import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import {
  type EventState,
  type EventType,
  type KafkaEnvelope,
  type NotifyRequest,
  type SupervisorAlert,
  TOPICS,
} from '@yanimda/contracts';
import { t } from '@yanimda/messages';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { bus as globalBus, type LocalBus } from '../../common/bus';
import { OutboxBus } from '../../common/outbox';
import { type TimerJob, TIMERS, type Timers } from '../../common/timers/timers';
import { DB, type Db, type Tx } from '../../db/client';
import { auditLog, dispatch, dispatchUpdate, event } from '../../db/schema';
import { RULES, type RulesProvider } from '../event/rules.loader';

/**
 * 112 bildirim ve intikal takibi. Olay DISPATCH'e geçince (112 arandı; zincir 112 adımı ya da acil kapanış)
 * süreç açılır. Aşamalar ileri gider (geri dönüş yok); CANCELLED her an. Olay kapansa da süreç takipte kalır.
 *  - Takip zamanlayıcısı (`dispatch-check`): ekip `DISPATCH_ARRIVAL_SLA_MIN` (15) içinde olay yerine ulaşmadıysa
 *    amire `O-DISPATCH-NO-ARRIVAL`, ulaştıktan sonra süreç `DISPATCH_OPEN_REMIND_MIN` (60) aralıkla açık kalırsa
 *    `O-DISPATCH-OPEN`; her uyarıda yeniden kurulur, son aşamada durur.
 *  - Aile: ekip olay yerinde (F-112-ON-SCENE), hastaneye nakil / hastanede (F-112-HOSPITAL, hastane adıyla).
 * Notlar (PII olabilir) log'a yazılmaz; audit'e yalnız aşama ve kaynak.
 */
export const DISPATCH_STAGES = [
  'NOTIFIED',
  'ACCEPTED',
  'EN_ROUTE',
  'ON_SCENE',
  'TRANSPORTING',
  'AT_HOSPITAL',
  'COMPLETED',
] as const;
export type DispatchStage = (typeof DISPATCH_STAGES)[number] | 'CANCELLED';
export type DispatchSource = 'OPERATOR' | 'EMS' | 'FAMILY' | 'SYSTEM';
const TERMINAL = new Set<DispatchStage>(['COMPLETED', 'CANCELLED']);
const ARRIVED = new Set<DispatchStage>(['ON_SCENE', 'TRANSPORTING', 'AT_HOSPITAL', 'COMPLETED']);
const STAGE_COLUMN: Record<Exclude<DispatchStage, 'NOTIFIED'>, keyof typeof dispatch.$inferInsert> = {
  ACCEPTED: 'acceptedAt',
  EN_ROUTE: 'enRouteAt',
  ON_SCENE: 'onSceneAt',
  TRANSPORTING: 'transportingAt',
  AT_HOSPITAL: 'atHospitalAt',
  COMPLETED: 'completedAt',
  CANCELLED: 'cancelledAt',
};
const FAMILY_NOTICE: Partial<Record<DispatchStage, string>> = {
  ON_SCENE: 'F-112-ON-SCENE',
  TRANSPORTING: 'F-112-TRANSPORT',
  AT_HOSPITAL: 'F-112-HOSPITAL',
};
/** Ekip varmadan en çok bu kadar "varmadı" uyarısı; sonra tek O-DISPATCH-ESCALATE ve varış bekleme uyarıları durur. */
export const NO_ARRIVAL_ALERTS = 3;
/** Ekip vardıktan sonra açık süreç hatırlatması üst sınırı. */
export const OPEN_REMINDERS = 6;

export const arrivalSlaMin = () => Number(process.env.DISPATCH_ARRIVAL_SLA_MIN ?? 15);
export const openRemindMin = () => Number(process.env.DISPATCH_OPEN_REMIND_MIN ?? 60);

export interface DispatchView {
  eventId: string;
  protectedPersonId: string;
  status: DispatchStage;
  notifiedAt: string;
  notifiedBy: string | null;
  caseRef: string | null;
  etaMin: number | null;
  hospital: string | null;
  stages: Partial<Record<DispatchStage, string>>;
  /** 112'nin aranmasından olay yerine varışa (dk); varılmadıysa null. */
  arrivalMin: number | null;
  /** Varış SLA'sı aşıldı mı (varılmadıysa şimdiye göre). */
  arrivalLate: boolean;
  open: boolean;
  checks: number;
  /** Operatörün 112'yi tekrar arayıp durumu sorduğu takip aramaları. */
  followUps: number;
  timeline: {
    status: DispatchStage;
    at: string;
    actorKind: string;
    actorId: string | null;
    source: DispatchSource;
    note: string | null;
    followUp: boolean;
  }[];
}

/** Aileye giden sade görünüm: aşama, zamanlar ve hastane (operatör, not, vaka numarası yok). */
export type FamilyDispatchView = Pick<DispatchView, 'status' | 'stages' | 'hospital'>;

type Row = typeof dispatch.$inferSelect;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class DispatchService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Dispatch');
  private unsub?: () => void;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OutboxBus) private readonly outbox: OutboxBus,
    @Optional() @Inject(TIMERS) private readonly timers?: Timers,
    @Optional() @Inject(RULES) private readonly rules?: RulesProvider,
  ) {
    this.timers?.on('dispatch-check', (job) => this.check(job));
  }

  onModuleInit() {
    this.subscribe();
  }

  onModuleDestroy() {
    this.unsub?.();
  }

  /** Olay geçişleri (core şerit): DISPATCH'e giriş süreci açar. Testler için ayrı bus. */
  subscribe(bus: LocalBus = globalBus) {
    this.unsub?.();
    this.unsub = bus.subscribe<{ eventId: string; to: EventState; actorId?: string; at?: string }>(
      TOPICS.eventTransitioned,
      async (e) => {
        if (e.payload.to !== 'DISPATCH') return;
        await this.open(
          e.payload.eventId,
          e.payload.actorId ?? null,
          e.payload.at ? new Date(e.payload.at) : new Date(),
        );
      },
    );
  }

  /** Süreci açar (idempotent: outbox tekrar teslim edebilir). Açıldıysa true. */
  async open(eventId: string, by: string | null, at = new Date()): Promise<boolean> {
    const [ev] = await this.db
      .select({ id: event.id, protectedPersonId: event.protectedPersonId, isTest: event.isTest })
      .from(event)
      .where(eq(event.id, eventId));
    if (!ev || ev.isTest) return false; // test olayında gerçek 112 aranmaz: süreç yok
    const opened = await this.db.transaction(async (tx) => {
      const ins = await tx
        .insert(dispatch)
        .values({ eventId, protectedPersonId: ev.protectedPersonId, notifiedAt: at, notifiedBy: by })
        .onConflictDoNothing()
        .returning({ id: dispatch.eventId });
      if (!ins.length) {
        // Tekrar teslim: süreç açıksa takip zamanlayıcısı eksik olabilir (önceki teslim commit ile kurulum arasında
        // öldüyse) → yeniden kur. İş kimliği <olay>.dispatch-check: zaten bekliyorsa ikinci kez eklenmez.
        const [row] = await tx.select({ status: dispatch.status }).from(dispatch).where(eq(dispatch.eventId, eventId));
        if (row && !TERMINAL.has(row.status as DispatchStage))
          await this.timers?.schedule(eventId, 'dispatch-check', arrivalSlaMin() * 60_000);
        return false;
      }
      await tx.insert(dispatchUpdate).values({
        id: uuidv7(),
        eventId,
        status: 'NOTIFIED',
        at,
        actorKind: by ? 'OPERATOR' : 'SYSTEM',
        actorId: by,
        source: by ? 'OPERATOR' : 'SYSTEM',
      });
      await this.audit(tx, by ? 'OPERATOR' : 'SYSTEM', by, 'dispatch.opened', eventId, { status: 'NOTIFIED' });
      // Zamanlayıcı commit'ten ÖNCE (olay motoru kalıbı): commit sonrası çökme takibi sessizce düşürmesin.
      await this.timers?.schedule(eventId, 'dispatch-check', arrivalSlaMin() * 60_000);
      return true;
    });
    if (opened) this.log.log(`112 süreci açıldı (olay=${eventId})`);
    return opened;
  }

  /**
   * POST /v1/events/{id}/dispatch — aşama ve ayrıntılar. Aşama yalnız ileri gider (aynı aşama yalnız ayrıntı
   * günceller); CANCELLED her an, son aşamadan sonra değişiklik yok (409).
   * Yetki: amir/yönetici her süreci; operatör yalnız olayı yürüttüğü (event.operator_id) sürecin — olay kapandıktan
   * sonra da (kapanış operatörü korur). Değilse 403 O-DISPATCH-NOT-OWNER.
   */
  async update(
    eventId: string,
    actor: { kind: 'OPERATOR' | 'SUPERVISOR' | 'ADMIN'; id: string },
    body: unknown,
    now = new Date(),
  ): Promise<DispatchView> {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const status = b.status as DispatchStage | undefined;
    if (status !== undefined && status !== 'CANCELLED' && !DISPATCH_STAGES.includes(status as never))
      throw new BadRequestException('Geçersiz aşama');
    const source = (b.source ?? (b.followUp === true ? 'EMS' : 'OPERATOR')) as DispatchSource;
    if (!['OPERATOR', 'EMS', 'FAMILY'].includes(source)) throw new BadRequestException('Geçersiz kaynak');
    const text = (k: string, max: number) => {
      const v = b[k];
      if (v === undefined) return undefined;
      if (v === null) return null;
      if (typeof v !== 'string' || v.length > max) throw new BadRequestException(`${k} en çok ${max} karakter`);
      return v.trim() || null;
    };
    const caseRef = text('caseRef', 64);
    const hospital = text('hospital', 160);
    const note = text('note', 1000);
    if (b.followUp !== undefined && typeof b.followUp !== 'boolean')
      throw new BadRequestException('followUp true/false');
    const followUp = b.followUp === true;
    const eta = b.etaMin;
    if (eta !== undefined && eta !== null && (!Number.isInteger(eta) || (eta as number) < 0 || (eta as number) > 600))
      throw new BadRequestException('etaMin 0–600 dk');
    if (!UUID.test(eventId)) throw new NotFoundException('Süreç yok');

    const result = await this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(dispatch).where(eq(dispatch.eventId, eventId)).for('update');
      if (!row) throw new NotFoundException('Süreç yok');
      if (actor.kind === 'OPERATOR') {
        const [ev] = await tx.select({ operatorId: event.operatorId }).from(event).where(eq(event.id, eventId));
        if (!ev || ev.operatorId !== actor.id)
          throw new ForbiddenException({ message: t('O-DISPATCH-NOT-OWNER', 'tr'), code: 'O-DISPATCH-NOT-OWNER' });
      }
      const cur = row.status as DispatchStage;
      if (TERMINAL.has(cur)) throw new ConflictException('Süreç kapandı');
      const advance = status !== undefined && status !== cur;
      if (
        advance &&
        status !== 'CANCELLED' &&
        DISPATCH_STAGES.indexOf(status as never) < DISPATCH_STAGES.indexOf(cur as never)
      )
        throw new ConflictException('Aşama geri alınamaz');
      const set: Partial<typeof dispatch.$inferInsert> = { updatedAt: now };
      if (caseRef !== undefined) set.caseRef = caseRef;
      if (hospital !== undefined) set.hospital = hospital;
      if (eta !== undefined) set.etaMin = eta as number | null;
      if (advance) {
        set.status = status;
        if (status === 'ON_SCENE' || status === 'TRANSPORTING' || status === 'AT_HOSPITAL') set.checks = 0;
        const col = STAGE_COLUMN[status as Exclude<DispatchStage, 'NOTIFIED'>];
        (set as Record<string, unknown>)[col] = now;
        // Atlanan ara aşamalar da zaman alır (ör. doğrudan "olay yerinde").
        if (status !== 'CANCELLED')
          for (const s of DISPATCH_STAGES.slice(
            DISPATCH_STAGES.indexOf(cur as never) + 1,
            DISPATCH_STAGES.indexOf(status as never),
          )) {
            const c = STAGE_COLUMN[s as Exclude<DispatchStage, 'NOTIFIED'>];
            if (!row[c as keyof Row]) (set as Record<string, unknown>)[c] = now;
          }
      }
      await tx.update(dispatch).set(set).where(eq(dispatch.eventId, eventId));
      await tx.insert(dispatchUpdate).values({
        id: uuidv7(),
        eventId,
        status: advance ? status! : cur,
        at: now,
        actorKind: actor.kind,
        actorId: actor.id,
        source,
        note: note ?? null,
        followUp,
      });
      await this.audit(tx, actor.kind, actor.id, 'dispatch.updated', eventId, {
        from: cur,
        to: advance ? status : cur,
        source,
        fields: Object.keys(set).filter((k) => k !== 'updatedAt'),
        ...(followUp ? { followUp: true } : {}),
      });
      const notice = advance ? FAMILY_NOTICE[status!] : undefined;
      if (notice) {
        const h = hospital ?? row.hospital;
        if (notice === 'F-112-ON-SCENE' || h)
          await this.notify(tx, row.protectedPersonId, eventId, notice, h ? { hospital: h } : undefined, now);
      }
      await this.outbox.publish(
        TOPICS.eventUpdated,
        this.envelope(TOPICS.eventUpdated, row.protectedPersonId, {
          eventId,
          reason: 'DISPATCH',
          dispatchStatus: advance ? status : cur,
        }),
        tx,
      );
      return { advanced: advance, to: advance ? status! : cur };
    });
    if (result.advanced && TERMINAL.has(result.to)) await this.timers?.cancel(eventId, 'dispatch-check');
    else if (result.advanced && result.to === 'ON_SCENE') {
      await this.timers?.cancel(eventId, 'dispatch-check');
      await this.timers?.schedule(eventId, 'dispatch-check', openRemindMin() * 60_000);
    }
    this.outbox.notifyCommitted();
    return (await this.get(eventId))!;
  }

  /**
   * Zamanlayıcı: süreç hâlâ açıksa amir uyarısı + yeniden kur.
   *  - Ekip yoldaysa ve tahmini varış girildiyse bekleme max(SLA, yola çıkış + ETA + 5 dk); dolmadan uyarı yok.
   *  - Varış öncesi en çok NO_ARRIVAL_ALERTS uyarı, sonra tek O-DISPATCH-ESCALATE ("112'yi tekrar arayın") ve durur.
   *  - Varış sonrası açık süreç hatırlatması OPEN_REMINDERS ile sınırlı.
   */
  async check({ eventId }: TimerJob, now = new Date()): Promise<void> {
    const next = await this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(dispatch).where(eq(dispatch.eventId, eventId)).for('update');
      if (!row || TERMINAL.has(row.status as DispatchStage)) return null;
      const arrived = ARRIVED.has(row.status as DispatchStage);
      if (!arrived && row.status === 'EN_ROUTE' && row.etaMin !== null && row.enRouteAt) {
        const due = row.enRouteAt.getTime() + (row.etaMin + 5) * 60_000;
        if (due > now.getTime()) return Math.max(1, Math.ceil((due - now.getTime()) / 60_000));
      }
      const limit = arrived ? OPEN_REMINDERS : NO_ARRIVAL_ALERTS;
      if (row.checks > limit) return null;
      const code = arrived ? 'O-DISPATCH-OPEN' : row.checks >= limit ? 'O-DISPATCH-ESCALATE' : 'O-DISPATCH-NO-ARRIVAL';
      const [ev] = await tx.select({ type: event.type }).from(event).where(eq(event.id, eventId));
      const alert: SupervisorAlert = {
        code,
        eventId,
        eventType: (ev?.type ?? 'SOS') as EventType,
        at: now.toISOString(),
      };
      await this.outbox.publish(
        TOPICS.supervisorAlert,
        this.envelope(TOPICS.supervisorAlert, row.protectedPersonId, alert),
        tx,
      );
      await tx
        .update(dispatch)
        .set({ checks: sql`${dispatch.checks} + 1`, lastCheckAt: now })
        .where(eq(dispatch.eventId, eventId));
      await this.audit(tx, 'SYSTEM', null, 'dispatch.check', eventId, { status: row.status, alert: code });
      if (code === 'O-DISPATCH-ESCALATE' || (arrived && row.checks + 1 >= OPEN_REMINDERS)) return null;
      return arrived ? openRemindMin() : Math.max(5, Math.round(arrivalSlaMin() / 3));
    });
    if (next !== null) await this.timers?.schedule(eventId, 'dispatch-check', next * 60_000);
    this.outbox.notifyCommitted();
  }

  async get(eventId: string, now = new Date()): Promise<DispatchView | null> {
    if (!UUID.test(eventId)) return null;
    const [row] = await this.db.select().from(dispatch).where(eq(dispatch.eventId, eventId));
    if (!row) return null;
    const timeline = await this.db
      .select()
      .from(dispatchUpdate)
      .where(eq(dispatchUpdate.eventId, eventId))
      .orderBy(asc(dispatchUpdate.at), asc(dispatchUpdate.id));
    return this.view(row, timeline, now);
  }

  /** Süren (ve isteğe bağlı son 24 saatte kapanan) süreçler; amir panosu ve yönetim. */
  async list(opts: { open?: boolean; limit?: number } = {}, now = new Date()): Promise<DispatchView[]> {
    const rows = await this.db
      .select()
      .from(dispatch)
      .where(
        opts.open
          ? sql`${dispatch.status} NOT IN ('COMPLETED', 'CANCELLED')`
          : sql`${dispatch.notifiedAt} > ${new Date(now.getTime() - 30 * 86_400_000)}`,
      )
      .orderBy(desc(dispatch.notifiedAt))
      .limit(Math.min(opts.limit ?? 100, 500));
    return rows.map((r) => this.view(r, [], now));
  }

  family(v: DispatchView | null): FamilyDispatchView | null {
    return v ? { status: v.status, stages: v.stages, hospital: v.hospital } : null;
  }

  // ---- iç ----

  private view(row: Row, timeline: (typeof dispatchUpdate.$inferSelect)[], now: Date): DispatchView {
    const stages: Partial<Record<DispatchStage, string>> = { NOTIFIED: row.notifiedAt.toISOString() };
    for (const [s, col] of Object.entries(STAGE_COLUMN)) {
      const v = row[col as keyof Row] as Date | null;
      if (v) stages[s as DispatchStage] = v.toISOString();
    }
    const arrival = row.onSceneAt ?? null;
    const arrivalMin = arrival ? Math.round((arrival.getTime() - row.notifiedAt.getTime()) / 6000) / 10 : null;
    const elapsedMin = ((arrival ?? now).getTime() - row.notifiedAt.getTime()) / 60_000;
    const status = row.status as DispatchStage;
    return {
      eventId: row.eventId,
      protectedPersonId: row.protectedPersonId,
      status,
      notifiedAt: row.notifiedAt.toISOString(),
      notifiedBy: row.notifiedBy,
      caseRef: row.caseRef,
      etaMin: row.etaMin,
      hospital: row.hospital,
      stages,
      arrivalMin,
      arrivalLate: status !== 'CANCELLED' && elapsedMin > arrivalSlaMin(),
      open: !TERMINAL.has(status),
      checks: row.checks,
      followUps: timeline.filter((t) => t.followUp).length,
      timeline: timeline.map((t) => ({
        status: t.status as DispatchStage,
        at: t.at.toISOString(),
        actorKind: t.actorKind,
        actorId: t.actorId,
        source: t.source as DispatchSource,
        note: t.note,
        followUp: t.followUp,
      })),
    };
  }

  private async notify(
    tx: Tx,
    protectedPersonId: string,
    eventId: string,
    code: string,
    vars: Record<string, string> | undefined,
    now: Date,
  ) {
    const payload: NotifyRequest = {
      code,
      audience: 'FAMILY',
      protectedPersonId,
      eventId,
      dedupeKey: `event:${eventId}:${code}`,
      ...(vars ? { vars } : {}),
    };
    await this.outbox.publish(
      TOPICS.notifyRequested,
      this.envelope(TOPICS.notifyRequested, protectedPersonId, payload, now),
      tx,
    );
  }

  private envelope<T>(topic: string, subject: string, payload: T, now = new Date()): KafkaEnvelope<T> {
    return {
      eventId: uuidv7(),
      type: topic,
      version: 1,
      occurredAt: now.toISOString(),
      countryCode: this.rules?.current().country ?? 'TR',
      subjectUserId: subject,
      payload,
    };
  }

  private async audit(tx: Tx, actorKind: string, actorId: string | null, action: string, id: string, data: unknown) {
    await tx.insert(auditLog).values({ actorKind, actorId, action, entityType: 'event', entityId: id, data });
  }
}
