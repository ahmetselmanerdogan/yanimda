import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { type KafkaEnvelope, type NotifyRequest, type SupervisorAlert, TOPICS } from '@yanimda/contracts';
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { bus as globalBus, type LocalBus } from '../../common/bus';
import { OutboxBus } from '../../common/outbox';
import { safeError } from '../../common/safe-error';
import { DB, type Db, type Tx } from '../../db/client';
import { auditLog, checkCall, checkPlan, event, protectedPerson } from '../../db/schema';
import { subscriptionProtection } from '../billing/subscription-protection';
import { EventService } from '../event/event.service';
import { DEFAULT_TIMEZONE } from '../event/night';
import { coverageNoneOf, loadRulePack, RULES, type RulesProvider, staticRules } from '../event/rules.loader';
import type { Actor } from '../profile/contacts';
import { ProfileService } from '../profile/profile.service';
import { type Frequency, nextDue } from './schedule';

/**
 * Düzenli "yanınızdayız" aramaları ve bildirimleri.
 *  - Plan (kişi başına): sıklık (günlük / haftalık / iki haftalık), gün, yerel saat, kanal (arama / bildirim / ikisi),
 *    tamamlanma penceresi. Aile sahibi (OWNER) veya operasyon (amir/yönetici) ayarlar.
 *  - Tarama (`WELLNESS_SWEEP_MS`, 60 sn): her plan için sıradaki dönem satırı; zamanı gelende kişiye P-WELLNESS
 *    bildirimi ve/veya operatör kuyruğunda P4 geri arama (CALLBACK, kaynak `wellness:<id>`); pencere dolunca
 *    KAÇIRILDI + amire O-WELLNESS-MISSED.
 *  - Sonuç: geri arama olayı kapanınca (yan şerit) iyi → DONE_OK, acil → DONE_HELP, ulaşılamadı → MISSED (+ uyarı).
 *  - T-087 (docs/07 S5.4): iki denemede ulaşılamayan (aileye F-WELLNESS-MISSED giden) aramadan sonra kural paketinin
 *    `coverageNone.welfareNoMovementH` (24 sa) süresince hiçbir cihaz hareketi yoksa YERİNDE KONTROL (P2).
 *  - Uyum: kişi ve merkez bazında planlanan / yapılan / kaçırılan (yönetim paneli).
 * Log'a yalnız kimlik; not ve ad yazılmaz.
 */
export type CheckStatus = 'SCHEDULED' | 'IN_PROGRESS' | 'DONE_OK' | 'DONE_HELP' | 'NOTIFIED' | 'MISSED' | 'SKIPPED';
export type Channel = 'CALL' | 'NOTIFY' | 'BOTH';
export interface PlanView {
  protectedPersonId: string;
  enabled: boolean;
  frequency: Frequency;
  weekday: number;
  localTime: string;
  channel: Channel;
  windowMin: number;
  nextDueAt: string | null;
}
export interface CheckView {
  id: string;
  protectedPersonId: string;
  person: string | null;
  dueAt: string;
  windowUntil: string;
  channel: Channel;
  status: CheckStatus;
  eventId: string | null;
  operatorId: string | null;
  completedAt: string | null;
  outcome: string | null;
}
export interface Compliance {
  days: number;
  planned: number;
  done: number;
  help: number;
  notified: number;
  missed: number;
  skipped: number;
  /** (yapılan + bildirildi + yardım) / (planlanan − bekleyen − atlanan); yoksa 1. */
  ratio: number;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Operatörde (görüşme sürüyor) durumlar: pencere dolsa da KAÇIRILDI yazılmaz. */
const HANDLING = new Set(['OPERATOR_ASSIGNED', 'CONTACT_CHAIN', 'CONFIRMED_OK', 'CONFIRMED_EMERGENCY', 'DISPATCH']);
const RETRY_MIN = 30;
const maxConcurrent = () => Number(process.env.WELLNESS_MAX_CONCURRENT ?? 5);
/** Kişi kimliğinden sabit kaydırma (dk): pencerenin ilk yarısında, 0…windowMin/2. */
export const spreadOffsetMin = (personId: string, windowMin: number) => {
  let h = 0;
  for (const ch of personId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % Math.max(1, Math.floor(windowMin / 2));
};
const OPEN: CheckStatus[] = ['SCHEDULED', 'IN_PROGRESS'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Rows<T> = { rows: T[] };

@Injectable()
export class WellnessService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Wellness');
  private timer?: NodeJS.Timeout;
  private unsub?: () => void;
  private readonly rules: RulesProvider;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OutboxBus) private readonly outbox: OutboxBus,
    @Inject(EventService) private readonly events: EventService,
    @Optional() @Inject(ProfileService) private readonly profile?: ProfileService,
    @Optional() @Inject(RULES) rules?: RulesProvider,
  ) {
    this.rules = rules ?? staticRules(loadRulePack());
  }

  onModuleInit() {
    this.subscribe();
    const every = Number(process.env.WELLNESS_SWEEP_MS ?? 60_000);
    if (every > 0) {
      this.timer = setInterval(() => void this.sweep().catch((e) => this.log.warn(`Tarama: ${safeError(e)}`)), every);
      this.timer.unref();
    }
  }

  onModuleDestroy() {
    this.unsub?.();
    if (this.timer) clearInterval(this.timer);
  }

  /** Geri arama olayı kapanınca sonuç (yan şerit: istatistik/takip, SOS'u bekletmez). Testler için ayrı bus. */
  subscribe(bus: LocalBus = globalBus) {
    this.unsub?.();
    this.unsub = bus.subscribe<{ id: string; confirmedOutcome?: string; operatorId?: string; closedAt?: string }>(
      TOPICS.eventClosed,
      (e) => this.onEventClosed(e.payload).then(() => undefined),
      { lane: 'side', name: 'wellness.result' },
    );
  }

  // ---- plan ----

  async plan(actor: Actor, personId: string, now = new Date()): Promise<PlanView | null> {
    await this.authorize(actor, personId, false);
    const [p] = await this.db.select().from(checkPlan).where(eq(checkPlan.protectedPersonId, personId));
    return p ? this.planView(p, await this.timezoneOf(personId), now) : null;
  }

  async setPlan(actor: Actor, personId: string, body: unknown, now = new Date()): Promise<PlanView> {
    await this.authorize(actor, personId, true);
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const set: Partial<typeof checkPlan.$inferInsert> = {};
    if (b.enabled !== undefined) {
      if (typeof b.enabled !== 'boolean') throw new BadRequestException('enabled true/false');
      set.enabled = b.enabled;
    }
    if (b.frequency !== undefined) {
      if (!['DAILY', 'WEEKLY', 'BIWEEKLY'].includes(b.frequency as string)) throw new BadRequestException('frequency');
      set.frequency = b.frequency as Frequency;
    }
    if (b.weekday !== undefined) {
      if (!Number.isInteger(b.weekday) || (b.weekday as number) < 1 || (b.weekday as number) > 7)
        throw new BadRequestException('weekday 1–7');
      set.weekday = b.weekday as number;
    }
    if (b.localTime !== undefined) {
      if (typeof b.localTime !== 'string' || !HHMM.test(b.localTime)) throw new BadRequestException('localTime SS:DD');
      set.localTime = b.localTime;
    }
    if (b.channel !== undefined) {
      if (!['CALL', 'NOTIFY', 'BOTH'].includes(b.channel as string)) throw new BadRequestException('channel');
      set.channel = b.channel as Channel;
    }
    if (b.windowMin !== undefined) {
      if (!Number.isInteger(b.windowMin) || (b.windowMin as number) < 15 || (b.windowMin as number) > 1440)
        throw new BadRequestException('windowMin 15–1440');
      set.windowMin = b.windowMin as number;
    }
    await this.db.transaction(async (tx) => {
      await tx
        .insert(checkPlan)
        .values({ protectedPersonId: personId, ...set, updatedAt: now, updatedBy: actor.id ?? actor.kind })
        .onConflictDoUpdate({
          target: checkPlan.protectedPersonId,
          set: { ...set, updatedAt: now, updatedBy: actor.id ?? actor.kind },
        });
      // Plan değişti: bekleyen (henüz başlamamış) dönem yeniden hesaplanır.
      await tx
        .delete(checkCall)
        .where(and(eq(checkCall.protectedPersonId, personId), eq(checkCall.status, 'SCHEDULED')));
      await this.audit(tx, actor.kind, actor.id ?? null, 'wellness.plan_set', personId, { fields: Object.keys(set) });
    });
    await this.ensureNext(personId, now);
    return (await this.plan(actor, personId, now))!;
  }

  // ---- tarama ----

  /** Dönem satırlarını kurar, zamanı geleni başlatır, penceresi dolanı kaçırıldı yapar. Değişen sayısı. */
  async sweep(now = new Date()): Promise<number> {
    let n = 0;
    const plans = await this.db
      .select({ id: checkPlan.protectedPersonId })
      .from(checkPlan)
      .where(eq(checkPlan.enabled, true));
    for (const p of plans) if (await this.ensureNext(p.id, now)) n++;

    const due = await this.db
      .select()
      .from(checkCall)
      .where(and(eq(checkCall.status, 'SCHEDULED'), lte(checkCall.dueAt, now)));
    for (const c of due) if (await this.start(c, now)) n++;

    const late = await this.db
      .select()
      .from(checkCall)
      .where(and(inArray(checkCall.status, OPEN), lte(checkCall.windowUntil, now)));
    for (const c of late) {
      // Operatör görüşüyorsa (olay operatörde) pencere dolsa da KAÇIRILDI yazılmaz; sonuç olay kapanınca gelir.
      if (c.eventId) {
        const [ev] = await this.db.select({ state: event.state }).from(event).where(eq(event.id, c.eventId));
        if (ev && HANDLING.has(ev.state)) continue;
      }
      if (await this.miss(c.id, 'WINDOW', now)) {
        n++;
        // Kuyrukta bekleyen geri arama olayı kalmasın (denetim bulgu 7a); operatördeyse veya alarma döndüyse kalır.
        if (c.eventId)
          await this.events
            .closeBySystem(c.eventId, 'SUPPRESSED', 'düzenli arama penceresi doldu')
            .catch((e) => this.log.warn(`Geri arama kapatılamadı: ${safeError(e)}`));
      }
    }
    n += await this.welfareSweep(now);
    if (n) this.outbox.notifyCommitted();
    return n;
  }

  /**
   * T-087 (S5.4): son `welfareNoMovementH` saatte iki denemede ulaşılamayan (MISSED / UNREACHABLE) arama ve aynı sürede
   * hiçbir cihaz hareketi (adım, takma/çıkarma, şarj, düğme, düşme, cevap) yoksa YERİNDE KONTROL. Kaynak
   * `welfare-wellness:<dönem>`: dönem başına bir; açılan olay sayısı. Hastanede / seyahatte modunda olay motoru açmaz.
   */
  async welfareSweep(now = new Date()): Promise<number> {
    const hours = coverageNoneOf(this.rules.current()).welfareNoMovementH;
    const from = new Date(now.getTime() - hours * 3_600_000).toISOString();
    const rows = (
      (await this.db.execute(sql`
        SELECT k.id::text AS id, k.protected_person_id::text AS person, k.completed_at
        FROM event.check_call k
        WHERE k.status = 'MISSED' AND k.outcome = 'UNREACHABLE' AND k.completed_at > ${from}::timestamptz
          AND k.completed_at <= ${now.toISOString()}::timestamptz
          AND NOT EXISTS (
            SELECT 1 FROM signal.signal s
            WHERE s.protected_person_id = k.protected_person_id::text AND s.time > ${from}::timestamptz
              AND (s.kind IN ('ON_BODY', 'OFF_BODY', 'CHARGE_START', 'CHARGE_END', 'SOS', 'FALL', 'OK', 'CANCEL',
                              'CALLBACK_REQUEST', 'TEST')
                   OR (s.kind = 'STEPS' AND s.value > 0)))`)) as unknown as Rows<{
        id: string;
        person: string;
        completed_at: Date | string;
      }>
    ).rows;
    let n = 0;
    for (const r of rows)
      if (await this.events.raiseWelfare(r.person, 'NO_MOVEMENT', `welfare-wellness:${r.id}`, new Date(r.completed_at)))
        n++;
    return n;
  }

  private async ensureNext(personId: string, now: Date): Promise<boolean> {
    const [p] = await this.db.select().from(checkPlan).where(eq(checkPlan.protectedPersonId, personId));
    if (!p?.enabled) return false;
    const [pending] = await this.db
      .select({ id: checkCall.id })
      .from(checkCall)
      .where(and(eq(checkCall.protectedPersonId, personId), eq(checkCall.status, 'SCHEDULED')));
    if (pending) return false;
    const [last] = await this.db
      .select({ dueAt: checkCall.dueAt })
      .from(checkCall)
      .where(eq(checkCall.protectedPersonId, personId))
      .orderBy(desc(checkCall.dueAt))
      .limit(1);
    const from = last && last.dueAt > now ? last.dueAt : now;
    const tz = await this.timezoneOf(personId);
    const planned = nextDue(
      { frequency: p.frequency as Frequency, weekday: p.weekday, localTime: p.localTime, timezone: tz },
      from,
    );
    // Yayılma: aynı saatli planlar aynı dakikada kuyruğa yığılmasın — kişiye sabit kaydırma (pencerenin ilk yarısı).
    const dueAt = new Date(planned.getTime() + spreadOffsetMin(personId, p.windowMin) * 60_000);
    const ins = await this.db
      .insert(checkCall)
      .values({
        id: uuidv7(),
        protectedPersonId: personId,
        dueAt,
        windowUntil: new Date(planned.getTime() + p.windowMin * 60_000),
        channel: p.channel,
      })
      .onConflictDoNothing()
      .returning({ id: checkCall.id });
    return ins.length > 0;
  }

  /**
   * Dönemi başlatır. Sıra: atlama kuralları → kapasite (ertele) → bildirim / geri arama olayı (kaynak kimliğiyle
   * tekrarsız, yalnız YENİ olay: kişinin süren olayına eklenmez) → aynı işlemde satır IN_PROGRESS + olay bağı.
   * Olay açılıp satır işaretlenmeden süreç ölürse sonraki tarama aynı kaynakla olayı bulup bağlar (kayıp yok).
   */
  private async start(c: typeof checkCall.$inferSelect, now: Date): Promise<boolean> {
    const skip = await this.skipReason(c.protectedPersonId, now);
    if (skip) return this.finishAs(c.id, 'SKIPPED', skip, now);
    const call = c.channel !== 'NOTIFY';
    if (call && (await this.busy(c, now))) return false; // kapasite: sonraki taramada yeniden dene
    const source = `wellness:${c.id}:${c.attempts}`;
    let eventId: string | null = null;
    if (call) {
      await this.events.raiseCallback(c.protectedPersonId, source, 'düzenli arama (yanınızdayız)', true);
      const [ev] = await this.db
        .select({ id: event.id })
        .from(event)
        .where(sql`${event.sourceSignalIds} @> ARRAY[${source}]::text[]`);
      if (!ev) return this.finishAs(c.id, 'SKIPPED', 'OPEN_EVENT', now); // arada açık olay oluştu
      eventId = ev.id;
    }
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(checkCall).where(eq(checkCall.id, c.id)).for('update');
      if (row?.status !== 'SCHEDULED') return false;
      await tx
        .update(checkCall)
        .set({
          status: call ? 'IN_PROGRESS' : 'NOTIFIED',
          startedAt: now,
          eventId,
          ...(call ? {} : { completedAt: now }),
        })
        .where(eq(checkCall.id, c.id));
      if (c.channel !== 'CALL' && c.attempts === 0)
        await this.notify(tx, c.protectedPersonId, 'P-WELLNESS', 'ELDER', `wellness:${c.id}`, now);
      await this.audit(tx, 'SYSTEM', null, 'wellness.started', c.protectedPersonId, {
        check: c.id,
        channel: c.channel,
        attempt: c.attempts,
      });
      return true;
    });
  }

  /** Atlama: süren olay (operatör zaten temasta), son 6 saatte operatörle kapanmış gerçek olay, koruma kapalı. */
  private async skipReason(personId: string, now: Date): Promise<string | null> {
    const [r] = (
      (await this.db.execute(sql`
        SELECT
          EXISTS (SELECT 1 FROM event.event WHERE protected_person_id = ${personId} AND state <> 'CLOSED') AS open,
          EXISTS (SELECT 1 FROM event.event WHERE protected_person_id = ${personId} AND state = 'CLOSED' AND NOT is_test
                  AND operator_id IS NOT NULL AND confirmed_outcome IN ('OK', 'EMERGENCY')
                  AND closed_at > ${now}::timestamptz - interval '6 hours') AS recent`)) as unknown as Rows<{
        open: boolean;
        recent: boolean;
      }>
    ).rows;
    if (r?.open) return 'OPEN_EVENT';
    if (r?.recent) return 'RECENT_CONTACT';
    const p = await subscriptionProtection(this.db, personId, now);
    if (!p.protectionActive) return 'NOT_PROTECTED';
    return null;
  }

  /** Kapasite: kuyrukta P1–P2 bekliyorken ya da kuyruktaki düzenli arama sayısı sınırdayken başlatma (dönemin
   *  ikinci yarısına kadar; sonra yine başlat ki dönem boşa düşmesin). */
  private async busy(c: typeof checkCall.$inferSelect, now: Date): Promise<boolean> {
    const lateHalf = now.getTime() >= c.windowUntil.getTime() - (c.windowUntil.getTime() - c.dueAt.getTime()) / 2;
    if (lateHalf) return false;
    const [r] = (
      (await this.db.execute(sql`
        SELECT
          (SELECT count(*) FROM event.event WHERE state = 'OPERATOR_QUEUE' AND priority <= 2 AND NOT is_test)::int AS urgent,
          (SELECT count(*) FROM event.check_call k JOIN event.event e ON e.id = k.event_id
            WHERE k.status = 'IN_PROGRESS' AND e.state = 'OPERATOR_QUEUE')::int AS queued`)) as unknown as Rows<{
        urgent: number;
        queued: number;
      }>
    ).rows;
    return (r?.urgent ?? 0) > 0 || (r?.queued ?? 0) >= maxConcurrent();
  }

  private async finishAs(id: string, status: CheckStatus, outcome: string, now: Date): Promise<boolean> {
    const r = await this.db
      .update(checkCall)
      .set({ status, outcome, completedAt: now })
      .where(and(eq(checkCall.id, id), eq(checkCall.status, 'SCHEDULED')))
      .returning({ id: checkCall.id });
    return r.length > 0;
  }

  private async miss(
    id: string,
    reason: string,
    now: Date,
    operatorId?: string | null,
    family = false,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(checkCall).where(eq(checkCall.id, id)).for('update');
      if (!row || !OPEN.includes(row.status as CheckStatus)) return false;
      await tx
        .update(checkCall)
        .set({ status: 'MISSED', completedAt: now, outcome: reason, ...(operatorId ? { operatorId } : {}) })
        .where(eq(checkCall.id, id));
      const alert: SupervisorAlert = {
        code: 'O-WELLNESS-MISSED',
        eventId: row.eventId ?? row.id,
        eventType: 'CALLBACK',
        at: now.toISOString(),
      };
      await this.outbox.publish(
        TOPICS.supervisorAlert,
        this.envelope(TOPICS.supervisorAlert, row.protectedPersonId, alert, now),
        tx,
      );
      // İki denemede de ulaşılamadı: aileye haber (yaşlıya ulaşamadık, siz de arayın).
      if (family) await this.notify(tx, row.protectedPersonId, 'F-WELLNESS-MISSED', 'FAMILY', `wellness:${id}`, now);
      await this.audit(tx, 'SYSTEM', null, 'wellness.missed', row.protectedPersonId, { check: id, reason, family });
      return true;
    });
  }

  /** Geri arama olayı kapandı → dönem sonucu. */
  async onEventClosed(ev: { id: string; confirmedOutcome?: string; operatorId?: string; closedAt?: string }) {
    if (!UUID.test(ev.id)) return;
    const [row] = await this.db.select().from(checkCall).where(eq(checkCall.eventId, ev.id));
    if (!row || !OPEN.includes(row.status as CheckStatus)) return;
    const at = ev.closedAt ? new Date(ev.closedAt) : new Date();
    if (ev.confirmedOutcome === 'UNREACHABLE') {
      if (row.attempts < 1) {
        // Ulaşılamadı: 30 dk sonra bir kez daha (yeni geri arama olayı); pencere yeniden denemeyi kapsayacak kadar uzar.
        const retryAt = new Date(at.getTime() + RETRY_MIN * 60_000);
        await this.db
          .update(checkCall)
          .set({
            status: 'SCHEDULED',
            attempts: row.attempts + 1,
            dueAt: retryAt,
            windowUntil: new Date(Math.max(row.windowUntil.getTime(), retryAt.getTime() + 60 * 60_000)),
            eventId: null,
            operatorId: ev.operatorId ?? null,
            outcome: 'UNREACHABLE',
          })
          .where(and(eq(checkCall.id, row.id), inArray(checkCall.status, OPEN)));
        return;
      }
      await this.miss(row.id, 'UNREACHABLE', at, ev.operatorId, true);
      this.outbox.notifyCommitted();
      return;
    }
    const status: CheckStatus = ev.confirmedOutcome === 'EMERGENCY' ? 'DONE_HELP' : 'DONE_OK';
    await this.db.transaction(async (tx) => {
      await tx
        .update(checkCall)
        .set({ status, completedAt: at, operatorId: ev.operatorId ?? null, outcome: ev.confirmedOutcome ?? null })
        .where(and(eq(checkCall.id, row.id), inArray(checkCall.status, OPEN)));
      await this.audit(tx, 'SYSTEM', null, 'wellness.done', row.protectedPersonId, { check: row.id, status });
    });
  }

  // ---- görünümler ----

  async checks(
    opts: { personId?: string; status?: CheckStatus[]; from?: Date; to?: Date; limit?: number } = {},
  ): Promise<CheckView[]> {
    const conds = [
      opts.personId ? eq(checkCall.protectedPersonId, opts.personId) : undefined,
      opts.status?.length ? inArray(checkCall.status, opts.status) : undefined,
      opts.from ? sql`${checkCall.dueAt} >= ${opts.from}` : undefined,
      opts.to ? sql`${checkCall.dueAt} < ${opts.to}` : undefined,
    ].filter(Boolean);
    const rows = await this.db
      .select({ c: checkCall, person: protectedPerson.displayName })
      .from(checkCall)
      .leftJoin(protectedPerson, eq(protectedPerson.id, checkCall.protectedPersonId))
      .where(conds.length ? and(...(conds as never[])) : undefined)
      .orderBy(desc(checkCall.dueAt))
      .limit(Math.min(opts.limit ?? 200, 1000));
    return rows.map(({ c, person }) => ({
      id: c.id,
      protectedPersonId: c.protectedPersonId,
      person,
      dueAt: c.dueAt.toISOString(),
      windowUntil: c.windowUntil.toISOString(),
      channel: c.channel as Channel,
      status: c.status as CheckStatus,
      eventId: c.eventId,
      operatorId: c.operatorId,
      completedAt: c.completedAt?.toISOString() ?? null,
      outcome: c.outcome,
    }));
  }

  /** Son `days` günde planlanan dönemlerin uyumu (kişi veya tüm merkez). */
  async compliance(personId?: string, days = 30, now = new Date()): Promise<Compliance> {
    const since = new Date(now.getTime() - days * 86_400_000);
    const r = (await this.db.execute(sql`
      SELECT count(*)::int AS planned,
             count(*) FILTER (WHERE status = 'DONE_OK')::int AS done,
             count(*) FILTER (WHERE status = 'DONE_HELP')::int AS help,
             count(*) FILTER (WHERE status = 'NOTIFIED')::int AS notified,
             count(*) FILTER (WHERE status = 'MISSED')::int AS missed,
             count(*) FILTER (WHERE status = 'SKIPPED')::int AS skipped,
             count(*) FILTER (WHERE status IN ('SCHEDULED', 'IN_PROGRESS'))::int AS pending
      FROM event.check_call
      WHERE due_at >= ${since} AND due_at <= ${now}
        ${personId ? sql`AND protected_person_id = ${personId}::uuid` : sql``}`)) as unknown as Rows<{
      planned: number;
      done: number;
      help: number;
      notified: number;
      missed: number;
      skipped: number;
      pending: number;
    }>;
    const x = r.rows[0] ?? { planned: 0, done: 0, help: 0, notified: 0, missed: 0, skipped: 0, pending: 0 };
    // Atlanan dönem (süren olay / yakın temas / koruma kapalı) paydaya girmez.
    const closed = x.planned - x.pending - x.skipped;
    return {
      days,
      planned: x.planned,
      done: x.done,
      help: x.help,
      notified: x.notified,
      missed: x.missed,
      skipped: x.skipped,
      ratio: closed > 0 ? (x.done + x.help + x.notified) / closed : 1,
    };
  }

  // ---- iç ----

  private planView(p: typeof checkPlan.$inferSelect, tz: string, now: Date): PlanView {
    return {
      protectedPersonId: p.protectedPersonId,
      enabled: p.enabled,
      frequency: p.frequency as Frequency,
      weekday: p.weekday,
      localTime: p.localTime,
      channel: p.channel as Channel,
      windowMin: p.windowMin,
      nextDueAt: p.enabled
        ? nextDue(
            { frequency: p.frequency as Frequency, weekday: p.weekday, localTime: p.localTime, timezone: tz },
            now,
          ).toISOString()
        : null,
    };
  }

  private async timezoneOf(personId: string): Promise<string> {
    const [r] = await this.db
      .select({ tz: protectedPerson.timezone })
      .from(protectedPerson)
      .where(eq(protectedPerson.id, personId));
    return r?.tz || DEFAULT_TIMEZONE;
  }

  /** Aile: okuma üye, yazma yalnız sahip; operasyon rolleri (ADMIN olarak gelir) her kişi. */
  private async authorize(actor: Actor, personId: string, write: boolean) {
    if (!UUID.test(personId)) throw new BadRequestException('Kişi kimliği');
    if (actor.kind === 'ADMIN' || !this.profile) return;
    if (write) await this.profile.authorizeOwner(actor, personId);
    else await this.profile.authorize(actor, personId);
  }

  private async notify(
    tx: Tx,
    personId: string,
    code: string,
    audience: 'ELDER' | 'FAMILY',
    dedupe: string,
    now: Date,
  ) {
    const payload: NotifyRequest = { code, audience, protectedPersonId: personId, dedupeKey: `${dedupe}:${code}` };
    await this.outbox.publish(
      TOPICS.notifyRequested,
      this.envelope(TOPICS.notifyRequested, personId, payload, now),
      tx,
    );
  }

  private envelope<T>(topic: string, subject: string, payload: T, now: Date): KafkaEnvelope<T> {
    return {
      eventId: uuidv7(),
      type: topic,
      version: 1,
      occurredAt: now.toISOString(),
      countryCode: 'TR',
      subjectUserId: subject,
      payload,
    };
  }

  private async audit(tx: Tx, actorKind: string, actorId: string | null, action: string, id: string, data: unknown) {
    await tx
      .insert(auditLog)
      .values({ actorKind, actorId, action, entityType: 'protected_person', entityId: id, data });
  }
}
