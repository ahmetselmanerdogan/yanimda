import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import {
  type ChargingPlan,
  type CoverageHistory,
  type CoverageLevel,
  type CoverageView,
  type DeviceCategory,
  type DeviceSummary,
  type DeviceTier,
  type KafkaEnvelope,
  type NotifyRequest,
  type ProtectionState,
  type Signal,
  type SupervisorCoverage,
  TOPICS,
} from '@yanimda/contracts';
import { catalogs } from '@yanimda/messages';
import { and, asc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import type { OutboxBus } from '../../common/outbox';
import type { Db, Tx } from '../../db/client';
import {
  auditLog,
  chargingPlan,
  coverageGap,
  coverageHistory,
  coverageState,
  device,
  protectionState,
} from '../../db/schema';
import { type ChargeMark, learnChargingWindow } from './charge-learning';
import {
  applySignal,
  computeCoverage,
  type CoverageResult,
  DEFAULT_CAPS,
  DEFAULT_TIER,
  type DeviceFact,
  deviceOnline,
  emptyFacts,
  estimatedHoursLeft,
  type Facts,
  hhmm,
  inRange,
  isWearable,
  type LadderAction,
  type LadderState,
  legacyFacts,
  localDate,
  onHold,
  planCheck,
  stepLadders,
  toProtectionState,
  voiceOrderOf,
} from './coverage';
import { dailyCoverage, type HistoryRow, spansOf, summarize, toSegments, windowStart } from './coverage-report';
import { isInWindow } from './night';
import { PROTECTION_REASON, type ProtectionFacts, type SleepWindow } from './protection';
import {
  batteryOf,
  chargeLearnOf,
  chargingOf,
  chronicGapOf,
  coverageNoneOf,
  coverageOf,
  type RulePack,
  type RulesProvider,
} from './rules.loader';

export interface ProtectionChange {
  protectedPersonId: string;
  from: ProtectionState | null;
  to: ProtectionState;
  reason: string;
  at: Date;
  facts: ProtectionFacts;
}

/** Bir kişinin kapsama değerlendirmesi: olay motoru (EventService) olay işlerini commit'ten sonra yürütür. */
export interface CoverageUpdate {
  protectedPersonId: string;
  at: Date;
  coverage: CoverageResult;
  facts: Facts;
  levelChange: { from: CoverageLevel | null; to: CoverageLevel } | null;
  /** Eski koruma durumu değiştiyse (user.protection.changed yayınlandı). */
  protection: ProtectionChange | null;
  /** Olay işleri (KAPSAMA BOŞLUĞU / YERİNDE KONTROL aç, boşluğu kapat). Bildirimler aynı transaction'da outbox'a yazıldı. */
  events: Exclude<LadderAction, { kind: 'notify' }>[];
  /** S4.10 "hastanede / seyahatte" modu açık: olay işi yok; olay motoru bekleyen kapsama olaylarını kapatır. */
  hold: boolean;
}

export interface PlanWindow {
  start: string;
  end: string;
  source: ChargingPlan['source'];
  nightChargeAllowed: boolean;
  learnedDays?: number | null;
  learnedAt?: Date | null;
}

/** S4.10 kronik boşluk kaydının sonucu: P3 açılsın mı; bu boşlukla kronik döneme girildiyse başlangıcı. */
export interface GapDecision {
  open: boolean;
  chronicSince: Date | null;
}

type Row = typeof coverageState.$inferSelect;
/** Kişi ayarları: gece penceresi ve S4.10 "hastanede / seyahatte" modunun bitişi (yoksa null). */
type PersonWindow = SleepWindow & { holdUntil?: Date | null; coverageToleranceMin?: number };
interface SettingsSource {
  settingsOf(protectedPersonId: string, tx?: Pick<Db, 'execute'>): Promise<PersonWindow>;
}
/** Kapsama değerlendirmesinin olay işleri (bildirimler değil): olay motoru commit'ten sonra yürütür. */
const isEventAction = (a: LadderAction) => a.kind === 'gap-event' || a.kind === 'welfare-event';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WINDOW = /^([01][0-9]|2[0-3]):([0-5][0-9])-([01][0-9]|2[0-3]):([0-5][0-9])$/;
const NO_CAPS = { sos: false, fall: false, voice: false, location: false };
const LEVELS: CoverageLevel[] = ['FULL', 'BASIC', 'PHONE_ONLY', 'NIGHT', 'NONE'];
const BODY_LOCATIONS = ['WRIST_LEFT', 'WRIST_RIGHT', 'NECK', 'CHEST', 'FINGER', 'EAR', 'POCKET', 'HOME'] as const;
export const isBodyLocation = (v: unknown): v is (typeof BODY_LOCATIONS)[number] =>
  typeof v === 'string' && (BODY_LOCATIONS as readonly string[]).includes(v);

const factsOf = (r?: Row): Facts =>
  r
    ? { devices: (r.devices ?? {}) as Facts['devices'], bridgeSeenAt: r.bridgeSeenAt?.toISOString() ?? null }
    : emptyFacts();
const ladderOf = (r?: Row): LadderState => ({
  gapSince: r?.gapSince ?? null,
  gapCause: (r?.gapCause as LadderState['gapCause']) ?? null,
  gapOffPlan: r?.gapOffPlan ?? false,
  gapSent: r?.gapSent ?? [],
  noneSince: r?.noneSince ?? null,
  noneSent: r?.noneSent ?? [],
  intentUntil: r?.intentUntil ?? null,
});
const sameLadder = (a: LadderState, b: LadderState) =>
  a.gapSince?.getTime() === b.gapSince?.getTime() &&
  a.gapCause === b.gapCause &&
  a.gapOffPlan === b.gapOffPlan &&
  a.noneSince?.getTime() === b.noneSince?.getTime() &&
  a.intentUntil?.getTime() === b.intentUntil?.getTime() &&
  a.gapSent.join() === b.gapSent.join() &&
  a.noneSent.join() === b.noneSent.join();

/**
 * T-085 / T-086 kapsama servisi (event.coverage_state). Sinyallerle cihaz olguları güncellenir, seviye sinyal anına
 * göre hesaplanır; dakikalık tarama gerçek zamana göre yeniden hesaplar (gece, susan cihaz) ve şarj / "kapsama yok"
 * zamanlayıcılarını yürütür. Her değerlendirme tek transaction: satır FOR UPDATE → olgular + seviye + geçmiş +
 * outbox (user.coverage.changed, user.protection.changed, notify.requested). Olay motoru cihaz tablosunu okumaz; cihaz
 * listesi (GET /devices) cihaz kaydını bu servis birleştirir. Log'a kişi/cihaz kimliği yazılmaz.
 */
export class CoverageService {
  private readonly log = new Logger('Coverage');

  constructor(
    private readonly db: Db,
    private readonly outbox: OutboxBus,
    private readonly rules: RulesProvider,
    private readonly settings: SettingsSource,
  ) {}

  private get pack(): RulePack {
    return this.rules.current();
  }

  // ---- Yazma ----

  /** Sinyalin olgularını işler ve kapsamayı sinyal anına (en yeni bilinen an) göre değerlendirir. */
  async applySignal(s: Signal): Promise<CoverageUpdate> {
    const at = new Date(s.occurredAt);
    const ctx = await this.contextOf(s.protectedPersonId);
    return this.db.transaction((tx) =>
      this.evaluate(
        tx,
        s.protectedPersonId,
        ctx,
        (f) => applySignal(f, s, at),
        (f) => latest(f, at),
      ),
    );
  }

  /** Kayıp / çalıntı / emekli cihaz: olgulardan çıkar, kapsama hemen yeniden hesaplanır (S8.3, S9.4). */
  async removeDevice(protectedPersonId: string, deviceId: string, now = new Date()): Promise<CoverageUpdate> {
    const ctx = await this.contextOf(protectedPersonId);
    return this.db.transaction((tx) =>
      this.evaluate(
        tx,
        protectedPersonId,
        ctx,
        (f) => {
          const devices = { ...f.devices };
          delete devices[deviceId];
          return { ...f, devices };
        },
        () => now,
      ),
    );
  }

  /** "Şarj ediyorum" (S4.5): hatırlatmalar `minutes` dk susar; 120 dk operatör olayı susmaz. */
  async chargingIntent(protectedPersonId: string, minutes: number | undefined, actor: string, now = new Date()) {
    const max = 240;
    const m = minutes ?? chargingOf(this.pack).intentMin;
    if (!Number.isInteger(m) || m < 1 || m > max)
      throw new BadRequestException(`minutes 1–${max} arası tam sayı olmalı`);
    const ctx = await this.contextOf(protectedPersonId);
    const until = new Date(now.getTime() + m * 60_000);
    const upd = await this.db.transaction(async (tx) => {
      const u = await this.evaluate(
        tx,
        protectedPersonId,
        ctx,
        null,
        () => now,
        (l) => (l.intentUntil = until),
      );
      await tx.insert(auditLog).values({
        actorKind: actor === 'DEVICE' ? 'USER' : actor === 'FAMILY' ? 'FAMILY' : 'OPERATOR',
        action: 'coverage.charging_intent',
        entityType: 'protected_person',
        entityId: protectedPersonId,
        data: { minutes: m, by: actor },
      });
      return u;
    });
    return { until: until.toISOString(), update: upd };
  }

  /** Tüm kişileri `now`'a göre yeniden değerlendirir; değişen / iş üreten kişileri döner. */
  async sweep(now = new Date()): Promise<CoverageUpdate[]> {
    const rows = await this.db.select().from(coverageState);
    // Şarj pencereleri tek sorguda (çoğu kişi varsayılanda; satırı yok).
    const plans = new Map(
      (await this.db.select().from(chargingPlan)).map((p) => [p.protectedPersonId, planWindowOf(p)] as const),
    );
    const out: CoverageUpdate[] = [];
    const weak = await this.weakKinds();
    for (const r of rows) {
      const sleep = await this.settings.settingsOf(r.protectedPersonId);
      let window = plans.get(r.protectedPersonId) ?? this.defaultPlan();
      // S4.3: şarj penceresi kişinin yerel gününde bir kez öğrenilir (aile verdiyse dokunulmaz).
      const today = localDate(now, sleep.timezone);
      if (r.planLearnedOn !== today) {
        window = (await this.learnPlan(r.protectedPersonId, now, sleep, window)) ?? window;
        await this.db
          .update(coverageState)
          .set({ planLearnedOn: today })
          .where(eq(coverageState.protectedPersonId, r.protectedPersonId));
      }
      const ctx = { sleep, plan: window, weak };
      const facts = factsOf(r);
      const cov = this.compute(facts, now, ctx);
      const step = stepLadders(ladderOf(r), cov, facts, this.ladderCtx(r.protectedPersonId, now, ctx));
      const plan = onHold(ctx.sleep, now)
        ? null
        : planCheck(facts, r.planCheckedOn, this.planCtx(r.protectedPersonId, now, ctx));
      const dirty =
        cov.level !== r.level ||
        cov.reasons.join() !== r.reasons.join() ||
        step.actions.some((a) => !isEventAction(a)) ||
        !!plan ||
        !sameLadder(step.state, ladderOf(r));
      if (!dirty) {
        // Yalnız (tekrar ayıklanan) olay isteği: satır değişmez, transaction gerekmez.
        const events = step.actions.filter((a): a is Extract<LadderAction, { kind: 'gap-event' | 'welfare-event' }> =>
          isEventAction(a),
        );
        if (events.length)
          out.push({
            protectedPersonId: r.protectedPersonId,
            at: now,
            coverage: cov,
            facts,
            levelChange: null,
            protection: null,
            events,
            hold: onHold(ctx.sleep, now),
          });
        continue;
      }
      out.push(await this.db.transaction((tx) => this.evaluate(tx, r.protectedPersonId, ctx, null, () => now)));
    }
    return out;
  }

  // ---- Okuma ----

  /** GET /protected-persons/{id}/coverage — kayıtlı olgulardan şu ana göre hesaplanır. */
  async view(protectedPersonId: string, now = new Date()): Promise<CoverageView> {
    await this.assertKnown(protectedPersonId);
    const [row] = await this.db
      .select()
      .from(coverageState)
      .where(eq(coverageState.protectedPersonId, protectedPersonId));
    const ctx = await this.contextOf(protectedPersonId);
    const facts = factsOf(row);
    const cov = this.compute(facts, now, ctx);
    return {
      level: cov.level,
      since: (row && row.level === cov.level ? row.since : now).toISOString(),
      reasons: cov.reasons,
      capabilities: cov.capabilities,
      devices: await deviceSummaries(this.db, this.pack, protectedPersonId, now, { facts, state: row }),
      chronicGap: row?.chronicGapSince ? { since: row.chronicGapSince.toISOString() } : null,
      toleranceMin: ctx.sleep.coverageToleranceMin ?? 0,
    };
  }

  /**
   * GET /protected-persons/{id}/coverage/history?days=7 (S7.3, S7.4): son `days` yerel günün kapsama zaman çizelgesi
   * (dilimler) ve gün başına uyanık zaman yüzdeleri. Gece penceresi ve hold dakikaları yüzdeye girmez.
   */
  async history(protectedPersonId: string, days = 7, now = new Date()): Promise<CoverageHistory> {
    await this.assertKnown(protectedPersonId);
    if (!Number.isInteger(days) || days < 1 || days > 30)
      throw new BadRequestException('days 1–30 arası tam sayı olmalı');
    const sleep = await this.settings.settingsOf(protectedPersonId);
    const from = windowStart(now, days, sleep.timezone);
    const rows = await historyRows(this.db, [protectedPersonId], from, now);
    const spans = spansOf(rows.get(protectedPersonId) ?? [], from, now);
    const daily = dailyCoverage(spans, from, now, sleep);
    return {
      protectedPersonId,
      days,
      from: from.toISOString(),
      to: now.toISOString(),
      timezone: sleep.timezone,
      sleepWindow: { start: sleep.start, end: sleep.end },
      segments: toSegments(spans),
      daily,
      summary: summarize(daily),
    };
  }

  /** GET /protected-persons/{id}/devices */
  async devices(protectedPersonId: string, now = new Date()): Promise<DeviceSummary[]> {
    await this.assertKnown(protectedPersonId);
    const [row] = await this.db
      .select()
      .from(coverageState)
      .where(eq(coverageState.protectedPersonId, protectedPersonId));
    return deviceSummaries(this.db, this.pack, protectedPersonId, now, { facts: factsOf(row), state: row });
  }

  /** GET /supervisor/coverage (S4.11): seviye başına kişi; akşam planlı şarj (pencere içinde başlayan şarj boşluğu). */
  async supervisorSummary(now = new Date()): Promise<SupervisorCoverage> {
    const r = (await this.db.execute(sql`
      SELECT level, count(*)::int AS n,
             count(*) FILTER (WHERE level <> 'FULL' AND gap_cause = 'CHARGING' AND NOT gap_off_plan)::int AS planned
      FROM event.coverage_state GROUP BY level`)) as unknown as {
      rows: { level: string; n: number; planned: number }[];
    };
    const counts = Object.fromEntries(LEVELS.map((l) => [l, 0])) as Record<CoverageLevel, number>;
    let plannedCharging = 0;
    let total = 0;
    for (const x of r.rows) {
      if ((LEVELS as string[]).includes(x.level)) counts[x.level as CoverageLevel] = x.n;
      plannedCharging += x.planned;
      total += x.n;
    }
    return { counts, plannedCharging, total, at: now.toISOString() };
  }

  // ---- Şarj penceresi (S4.3) ----

  async planOf(protectedPersonId: string, tx: Pick<Db, 'select'> = this.db): Promise<PlanWindow> {
    const [p] = await tx.select().from(chargingPlan).where(eq(chargingPlan.protectedPersonId, protectedPersonId));
    return p ? planWindowOf(p) : this.defaultPlan();
  }

  async chargingPlan(protectedPersonId: string): Promise<ChargingPlan> {
    await this.assertKnown(protectedPersonId);
    const p = await this.planOf(protectedPersonId);
    return {
      window: `${p.start}-${p.end}`,
      source: p.source,
      nightChargeAllowed: p.nightChargeAllowed,
      ...(p.source === 'LEARNED'
        ? { learnedDays: p.learnedDays ?? null, learnedAt: p.learnedAt?.toISOString() ?? null }
        : {}),
    };
  }

  /**
   * S4.3 öğrenilmiş şarj penceresi: son `learn.days` günün A sınıfı giyilebilir CHARGE_START / CHARGE_END
   * sinyallerinden (charge-learning.ts). Geçmiş `learn.days` günü kapsamıyorsa, geçerli gün yetmiyorsa, aile pencereyi
   * verdiyse (FAMILY) veya pencere gece penceresine taşıyor ve gece şarjı onaylı değilse dokunulmaz. Değiştiyse
   * LEARNED yazılır (denetimde pencere + gün sayısı; kişisel veri yok). Yeni pencereyi (veya null) döner.
   */
  async learnPlan(
    protectedPersonId: string,
    now: Date,
    sleep?: PersonWindow,
    current?: PlanWindow,
  ): Promise<PlanWindow | null> {
    const plan = current ?? (await this.planOf(protectedPersonId));
    if (plan.source === 'FAMILY') return null;
    const p = chargeLearnOf(this.pack);
    const win = sleep ?? (await this.settings.settingsOf(protectedPersonId));
    // "14 gün sonra": en eski şarj sinyali pencerenin başını (bir gün payla) kapsamalı.
    const first = (await this.db.execute(sql`
      SELECT min(time) AS t FROM signal.signal
      WHERE protected_person_id = ${protectedPersonId} AND kind IN ('CHARGE_START', 'CHARGE_END')`)) as unknown as {
      rows: { t: Date | string | null }[];
    };
    const t0 = first.rows[0]?.t;
    if (!t0 || new Date(t0).getTime() > now.getTime() - (p.days - 1) * 86_400_000) return null;
    const since = new Date(now.getTime() - (p.days + 1) * 86_400_000);
    const r = (await this.db.execute(sql`
      SELECT device_id, kind, time FROM signal.signal
      WHERE protected_person_id = ${protectedPersonId} AND kind IN ('CHARGE_START', 'CHARGE_END')
        AND time >= ${since.toISOString()}::timestamptz AND time <= ${now.toISOString()}::timestamptz
        AND coalesce(payload->'source'->>'category', 'WATCH') NOT IN ('PHONE', 'HOME_UNIT', 'CLOUD')
        AND coalesce(payload->'source'->>'tier', 'A') = 'A'
      ORDER BY time`)) as unknown as { rows: { device_id: string; kind: ChargeMark['kind']; time: Date | string }[] };
    const marks = r.rows.map((x) => ({ deviceId: x.device_id, kind: x.kind, at: new Date(x.time) }));
    const learned = learnChargingWindow(marks, win.timezone, now, p);
    if (!learned) return null;
    if (!plan.nightChargeAllowed && overlaps(learned.start, learned.end, win.start, win.end)) return null;
    const same = plan.source === 'LEARNED' && plan.start === learned.start && plan.end === learned.end;
    const values = {
      windowStart: learned.start,
      windowEnd: learned.end,
      source: 'LEARNED',
      learnedDays: learned.validDays,
      learnedAt: now,
      updatedAt: now,
      updatedBy: 'system',
    };
    await this.db.transaction(async (tx) => {
      // Aile bu arada yazdıysa (FAMILY) dokunulmaz.
      await tx
        .insert(chargingPlan)
        .values({ protectedPersonId, ...values })
        .onConflictDoUpdate({
          target: chargingPlan.protectedPersonId,
          set: values,
          setWhere: sql`${chargingPlan.source} <> 'FAMILY'`,
        });
      if (!same)
        await tx.insert(auditLog).values({
          actorKind: 'SYSTEM',
          action: 'coverage.charging_plan_learned',
          entityType: 'protected_person',
          entityId: protectedPersonId,
          data: { window: `${learned.start}-${learned.end}`, validDays: learned.validDays },
        });
    });
    return {
      ...plan,
      start: learned.start,
      end: learned.end,
      source: 'LEARNED',
      learnedDays: learned.validDays,
      learnedAt: now,
    };
  }

  /**
   * S4.10 kronik boşluk: olay eşiğine ulaşan her kapsama boşluğu bir kez kaydedilir (kaynak kimliği). Son
   * `chronicGap.days` günde (son temizlenmeden sonra) `chronicGap.gaps` boşluk olduysa kişi kronik boşluk dönemine
   * girer: bu ve sonraki boşluklarda P3 açılmaz; aileye bir kez F-COVERAGE-CHRONIC (aynı transaction'da outbox).
   * Dönemdeki boşluklar eşiğin altına inerse dönem kendiliğinden biter (P3'ler döner). Hold'da çağrılmaz.
   */
  async recordGap(protectedPersonId: string, sourceId: string, reason: string, at: Date): Promise<GapDecision> {
    const p = chronicGapOf(this.pack);
    const decision = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ since: coverageState.chronicGapSince, cleared: coverageState.chronicClearedAt })
        .from(coverageState)
        .where(eq(coverageState.protectedPersonId, protectedPersonId))
        .for('update');
      const ins = await tx
        .insert(coverageGap)
        .values({ sourceId, protectedPersonId, reason, at })
        .onConflictDoNothing()
        .returning({ id: coverageGap.sourceId });
      if (!ins.length) {
        const [g] = await tx.select().from(coverageGap).where(eq(coverageGap.sourceId, sourceId));
        return { open: !g?.chronic, chronicSince: null, notify: false };
      }
      const from = new Date(at.getTime() - p.days * 86_400_000);
      const after = row?.cleared && row.cleared > from ? row.cleared : from;
      const [c] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(coverageGap)
        .where(
          and(
            eq(coverageGap.protectedPersonId, protectedPersonId),
            gte(coverageGap.at, after),
            sql`${coverageGap.at} <= ${at.toISOString()}::timestamptz`,
          ),
        );
      const n = c?.n ?? 0;
      if (n < p.gaps) {
        if (row?.since)
          await tx
            .update(coverageState)
            .set({ chronicGapSince: null, chronicClearedAt: at })
            .where(eq(coverageState.protectedPersonId, protectedPersonId));
        return { open: true, chronicSince: null, notify: false };
      }
      await tx.update(coverageGap).set({ chronic: true }).where(eq(coverageGap.sourceId, sourceId));
      if (row?.since) return { open: false, chronicSince: null, notify: false };
      await tx
        .update(coverageState)
        .set({ chronicGapSince: at })
        .where(eq(coverageState.protectedPersonId, protectedPersonId));
      await tx.insert(auditLog).values({
        actorKind: 'SYSTEM',
        action: 'coverage.chronic_gap',
        entityType: 'protected_person',
        entityId: protectedPersonId,
        data: { gaps: n, days: p.days },
      });
      const req: NotifyRequest = {
        code: 'F-COVERAGE-CHRONIC',
        audience: 'FAMILY',
        protectedPersonId,
        dedupeKey: `coverage-chronic:${protectedPersonId}:${at.toISOString()}:F-COVERAGE-CHRONIC`,
        vars: { n, days: p.days },
      };
      await this.outbox.publish(
        TOPICS.notifyRequested,
        this.envelope(TOPICS.notifyRequested, protectedPersonId, at, req),
        tx,
      );
      return { open: false, chronicSince: at, notify: true };
    });
    if (decision.notify) this.outbox.notifyCommitted();
    return { open: decision.open, chronicSince: decision.chronicSince };
  }

  /** S4.10: kronik boşluk dönemini bitirir (plan yapıldı: tolerans değişti). Sayım bu andan sonraki boşluklarla başlar. */
  async clearChronic(protectedPersonId: string, now: Date, tx: Pick<Db, 'update'> = this.db) {
    await tx
      .update(coverageState)
      .set({ chronicGapSince: null, chronicClearedAt: now })
      .where(eq(coverageState.protectedPersonId, protectedPersonId));
  }

  /**
   * PUT charging-plan (aile). Gece şarjı (tek alarm cihazının gece penceresinde şarjı) yalnız "gece düşme koruması
   * yok" uyarısı onaylanarak açılır (`acknowledgeNoNightFall: true`); kapalıyken pencere gece penceresine taşamaz.
   * Hata gövdesinde katalog kodu F-UI-NIGHT-CHARGE-WARN (istemci metni oradan gösterir).
   */
  async setChargingPlan(protectedPersonId: string, body: unknown, actorId: string, now = new Date()) {
    await this.assertKnown(protectedPersonId);
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof body !== 'object' || body === null || Array.isArray(body))
      throw new BadRequestException('Nesne bekleniyor');
    const current = await this.planOf(protectedPersonId);
    let [start, end] = [current.start, current.end];
    if (b.window !== undefined) {
      const m = typeof b.window === 'string' ? WINDOW.exec(b.window) : null;
      if (!m) throw new BadRequestException('window HH:MM-HH:MM olmalı');
      [start, end] = [`${m[1]}:${m[2]}`, `${m[3]}:${m[4]}`];
      if (start === end) throw new BadRequestException('window başlangıcı ve bitişi farklı olmalı');
    }
    if (b.nightChargeAllowed !== undefined && typeof b.nightChargeAllowed !== 'boolean')
      throw new BadRequestException('nightChargeAllowed true/false');
    const night = (b.nightChargeAllowed as boolean | undefined) ?? current.nightChargeAllowed;
    const warn = () =>
      new BadRequestException({ message: catalogs.tr['F-UI-NIGHT-CHARGE-WARN']!.text, code: 'F-UI-NIGHT-CHARGE-WARN' });
    if (night && b.nightChargeAllowed === true && b.acknowledgeNoNightFall !== true) throw warn();
    const sleep = await this.settings.settingsOf(protectedPersonId);
    if (!night && overlaps(start, end, sleep.start, sleep.end)) throw warn();
    const values = {
      windowStart: start,
      windowEnd: end,
      source: 'FAMILY',
      nightChargeAllowed: night,
      nightAckAt: night ? now : null,
      nightAckBy: night ? actorId : null,
      updatedAt: now,
      updatedBy: actorId,
    };
    await this.db.transaction(async (tx) => {
      await tx
        .insert(chargingPlan)
        .values({ protectedPersonId, ...values })
        .onConflictDoUpdate({ target: chargingPlan.protectedPersonId, set: values });
      await tx.insert(auditLog).values({
        actorKind: 'FAMILY',
        actorId,
        action: 'coverage.charging_plan_set',
        entityType: 'protected_person',
        entityId: protectedPersonId,
        data: { window: `${start}-${end}`, nightChargeAllowed: night },
      });
    });
    return this.chargingPlan(protectedPersonId);
  }

  // ---- İç ----

  private async contextOf(protectedPersonId: string, plan?: PlanWindow, weak?: ReadonlySet<string>) {
    const sleep = await this.settings.settingsOf(protectedPersonId);
    return { sleep, plan: plan ?? (await this.planOf(protectedPersonId)), weak: weak ?? (await this.weakKinds()) };
  }

  /**
   * T-085 OEM (S2.7): gecikmesi bozulan ortaklar (device.partner_status; ortak kodu = cihaz türü). Ortak sağlığını
   * PartnerHealthService yazar; kapsama yalnız "zayıf" nedenini ekler, seviyeyi değiştirmez.
   */
  async weakKinds(): Promise<ReadonlySet<string>> {
    const r = (await this.db.execute(
      sql`SELECT partner FROM device.partner_status WHERE degraded_since IS NOT NULL`,
    )) as unknown as { rows: { partner: string }[] };
    return new Set(r.rows.map((x) => x.partner));
  }

  private defaultPlan(): PlanWindow {
    const [start, end] = chargingOf(this.pack).defaultWindow.split('-') as [string, string];
    return { start, end, source: 'DEFAULT', nightChargeAllowed: false };
  }

  private compute(f: Facts, now: Date, ctx: { sleep: PersonWindow; weak?: ReadonlySet<string> }): CoverageResult {
    const pack = this.pack;
    const battery = batteryOf(pack);
    return computeCoverage(f, now, {
      params: coverageOf(pack),
      deadPct: battery.deadPct,
      night: isInWindow(now, ctx.sleep.timezone, ctx.sleep.start, ctx.sleep.end),
      hold: onHold(ctx.sleep, now),
      droppedPct: battery.warnPct,
      weakKinds: ctx.weak,
    });
  }

  private ladderCtx(personId: string, now: Date, ctx: { sleep: PersonWindow; plan: PlanWindow }) {
    const charging = chargingOf(this.pack);
    const { timezone, start, end } = ctx.sleep;
    return {
      personId,
      now,
      quiet: { timezone, start, end, resumeAfterWakeMin: charging.resumeAfterWakeMin ?? 30 },
      plan: { start: ctx.plan.start, end: ctx.plan.end },
      charging,
      none: coverageNoneOf(this.pack),
      hold: onHold(ctx.sleep, now),
      toleranceMin: Math.min(ctx.sleep.coverageToleranceMin ?? 0, chronicGapOf(this.pack).toleranceMaxMin),
    };
  }

  private planCtx(personId: string, now: Date, ctx: { sleep: PersonWindow; plan: PlanWindow }) {
    const b = batteryOf(this.pack);
    return {
      personId,
      now,
      timezone: ctx.sleep.timezone,
      planHour: b.planHour,
      planPct: b.planPct,
      familyPct: b.familyPct,
      windowStart: ctx.plan.start,
      params: coverageOf(this.pack),
    };
  }

  /**
   * Kilitli değerlendirme: olgular (isteğe bağlı değişiklik) → seviye → zamanlayıcı adımı → planlı şarj kontrolü →
   * satır + geçmiş + outbox. `nowOf` değerlendirme anını olgulardan türetir (sinyal: en yeni görülme).
   */
  private async evaluate(
    tx: Tx,
    personId: string,
    ctx: { sleep: PersonWindow; plan: PlanWindow; weak?: ReadonlySet<string> },
    mutate: ((f: Facts) => Facts) | null,
    nowOf: (f: Facts) => Date,
    ladderMutate?: (l: LadderState) => void,
  ): Promise<CoverageUpdate> {
    const placeholder = new Date();
    const inserted = await tx
      .insert(coverageState)
      .values({
        protectedPersonId: personId,
        level: 'NONE',
        rawLevel: 'NONE',
        since: placeholder,
        capabilities: NO_CAPS,
        devices: {},
      })
      .onConflictDoNothing()
      .returning({ id: coverageState.protectedPersonId });
    const fresh = inserted.length > 0;
    const [row] = await tx
      .select()
      .from(coverageState)
      .where(eq(coverageState.protectedPersonId, personId))
      .for('update');
    let facts = factsOf(row);
    if (mutate) facts = mutate(facts);
    const now = nowOf(facts);
    const cov = this.compute(facts, now, ctx);
    const prev = ladderOf(fresh ? undefined : row);
    ladderMutate?.(prev);
    const step = stepLadders(prev, cov, facts, this.ladderCtx(personId, now, ctx));
    // S4.10: hastanede / seyahatte modunda 18:00 planlı şarj kontrolü de yapılmaz.
    const plan = onHold(ctx.sleep, now)
      ? null
      : planCheck(facts, row?.planCheckedOn ?? null, this.planCtx(personId, now, ctx));
    const from = fresh ? null : ((row?.level as CoverageLevel) ?? null);
    const changed = from !== cov.level;
    await tx
      .update(coverageState)
      .set({
        level: cov.level,
        rawLevel: cov.rawLevel,
        since: changed ? now : row!.since,
        reasons: cov.reasons,
        capabilities: cov.capabilities,
        devices: facts.devices,
        bridgeSeenAt: facts.bridgeSeenAt ? new Date(facts.bridgeSeenAt) : null,
        gapSince: step.state.gapSince,
        gapCause: step.state.gapCause,
        gapOffPlan: step.state.gapOffPlan,
        gapSent: step.state.gapSent,
        noneSince: step.state.noneSince,
        noneSent: step.state.noneSent,
        intentUntil: step.state.intentUntil,
        planCheckedOn: plan?.checkedOn ?? row?.planCheckedOn ?? null,
        updatedAt: new Date(),
      })
      .where(eq(coverageState.protectedPersonId, personId));
    if (changed) {
      await tx
        .insert(coverageHistory)
        .values({ protectedPersonId: personId, fromLevel: from, level: cov.level, reasons: cov.reasons, at: now });
      await this.outbox.publish(
        TOPICS.coverageChanged,
        this.envelope(TOPICS.coverageChanged, personId, now, {
          protectedPersonId: personId,
          from,
          to: cov.level,
          reasons: cov.reasons,
          capabilities: cov.capabilities,
          at: now.toISOString(),
        }),
        tx,
      );
      this.log.debug(`Kapsama: ${from ?? '-'} → ${cov.level}`);
    } else if (!fresh && row!.reasons.includes('ON_HOLD') !== cov.reasons.includes('ON_HOLD')) {
      // S4.10 hold açıldı / bitti: seviye aynı kalsa da geçmişe yazılır (uyanık zaman yüzdesinden hold çıkarılır).
      await tx
        .insert(coverageHistory)
        .values({ protectedPersonId: personId, fromLevel: from, level: cov.level, reasons: cov.reasons, at: now });
    }
    const protection = await this.saveProtection(tx, personId, cov, facts, now);
    const all = [...step.actions, ...(plan?.actions ?? [])];
    for (const a of all) {
      if (a.kind !== 'notify') continue;
      const req: NotifyRequest = {
        code: a.code,
        audience: a.audience,
        protectedPersonId: personId,
        dedupeKey: `${a.dedupeKey}:${a.code}`,
        ...(a.vars ? { vars: a.vars } : {}),
      };
      await this.outbox.publish(TOPICS.notifyRequested, this.envelope(TOPICS.notifyRequested, personId, now, req), tx);
    }
    return {
      protectedPersonId: personId,
      at: now,
      coverage: cov,
      facts,
      levelChange: changed ? { from, to: cov.level } : null,
      protection,
      events: all.filter((a): a is CoverageUpdate['events'][number] => a.kind !== 'notify'),
      hold: onHold(ctx.sleep, now),
    };
  }

  /** Eski koruma durumu (protection_state + user.protection.changed) kapsamadan türetilir. */
  private async saveProtection(
    tx: Tx,
    personId: string,
    cov: CoverageResult,
    facts: Facts,
    now: Date,
  ): Promise<ProtectionChange | null> {
    const state = toProtectionState(cov.level);
    const legacy = legacyFacts(facts);
    const [row] = await tx
      .select()
      .from(protectionState)
      .where(eq(protectionState.protectedPersonId, personId))
      .for('update');
    const changed = row?.state !== state;
    const reason = PROTECTION_REASON[state];
    const values = {
      ...legacy,
      state,
      reason: changed ? reason : row!.reason,
      since: changed ? now : row!.since,
      updatedAt: new Date(),
    };
    if (row) await tx.update(protectionState).set(values).where(eq(protectionState.protectedPersonId, personId));
    else await tx.insert(protectionState).values({ protectedPersonId: personId, ...values });
    if (!changed) return null;
    const from = (row?.state as ProtectionState) ?? null;
    await this.outbox.publish(
      TOPICS.protectionChanged,
      this.envelope(TOPICS.protectionChanged, personId, now, {
        protectedPersonId: personId,
        from,
        to: state,
        reason,
        at: now.toISOString(),
      }),
      tx,
    );
    return { protectedPersonId: personId, from, to: state, reason, at: now, facts: legacy };
  }

  private envelope<T>(topic: string, subject: string, at: Date, payload: T): KafkaEnvelope<T> {
    return {
      eventId: uuidv7(),
      type: topic,
      version: 1,
      occurredAt: at.toISOString(),
      countryCode: this.pack.country,
      subjectUserId: subject,
      payload,
    };
  }

  /** Kişi var mı: UUID kişi profile'da; diğerleri (simülatör kişileri) kapsama satırıyla. Yoksa 404. */
  private async assertKnown(personId: string) {
    const r = UUID.test(personId)
      ? await this.db.execute(sql`SELECT 1 FROM profile.protected_person WHERE id = ${personId}::uuid`)
      : await this.db.execute(sql`SELECT 1 FROM event.coverage_state WHERE protected_person_id = ${personId}`);
    if (!(r as unknown as { rows: unknown[] }).rows.length) throw new NotFoundException('Kişi bulunamadı');
  }
}

/**
 * Cihaz kartları: kayıtlı cihazlar (kayıt + katalog + sinyal alımında yazılan son durum) ve kaydı olmayan
 * (simülatör) cihazların olguları. Çevrimiçi kuralı kapsamayla aynı; sesli arama sırası `voiceOrderOf` (S1.8: elle
 * verilenler önce, sonra takılı > en son görülen > ev ünitesi > telefon; şarjdaki / çıkarılmış en sonda). GET /devices, /coverage ve T-087 merdiveni (çevrimdışı
 * atlama, T+0 çaldırma, en iyi sesli cihaz) aynı görünümü kullanır; `q` çağıranın transaction'ı olabilir (olay
 * kilidi altında okuma). `facts`/`state` verilmezse kapsama satırı `q` ile okunur.
 */
export async function deviceSummaries(
  q: Pick<Db, 'select' | 'execute'>,
  pack: RulePack,
  personId: string,
  now: Date,
  known?: { facts: Facts; state?: Row },
): Promise<DeviceSummary[]> {
  let state = known?.state;
  if (!known) [state] = await q.select().from(coverageState).where(eq(coverageState.protectedPersonId, personId));
  const facts = known?.facts ?? factsOf(state);
  const rows = UUID.test(personId)
    ? ((
        (await q.execute(sql`
          SELECT d.id::text AS id, d.kind, coalesce(d.category, m.category) AS category,
                 coalesce(d.tier, m.tier) AS tier, d.body_location, d.nickname, d.voice_order, d.last_seen_at,
                 d.battery_pct, d.charging, d.charging_since, d.on_wrist, d.connectivity, m.capabilities,
                 m.battery_life_h, right(d.voice_number, 2) AS voice_last2, d.connection_path
          FROM ${device} d LEFT JOIN device.device_model m ON m.id = coalesce(d.model_id, d.kind)
          WHERE d.protected_person_id = ${personId}::uuid AND d.revoked_at IS NULL AND d.retired_at IS NULL
          ORDER BY d.created_at, d.id`)) as unknown as { rows: DeviceRow[] }
      ).rows ?? [])
    : [];
  const merged: Facts = { devices: { ...facts.devices }, bridgeSeenAt: facts.bridgeSeenAt };
  const meta = new Map<string, DeviceRow>();
  for (const r of rows) {
    meta.set(r.id, r);
    const f = rowFact(r, facts.devices[r.id]);
    merged.devices[r.id] = f;
    if (f.bridged && f.seenAt && (!merged.bridgeSeenAt || f.seenAt > merged.bridgeSeenAt))
      merged.bridgeSeenAt = f.seenAt;
  }
  if (state?.bridgeSeenAt && (!merged.bridgeSeenAt || state.bridgeSeenAt.toISOString() > merged.bridgeSeenAt))
    merged.bridgeSeenAt = state.bridgeSeenAt.toISOString();
  const params = coverageOf(pack);
  const ids = [...rows.map((r) => r.id), ...Object.keys(facts.devices).filter((id) => !meta.has(id))];
  const list = ids.map((id) => {
    const f = merged.devices[id]!;
    const r = meta.get(id);
    const online = deviceOnline(f, merged, now, params);
    return {
      f,
      r,
      online,
      summary: {
        id,
        kind: r?.kind ?? f.kind ?? 'SIMULATOR',
        category: f.category,
        tier: f.tier,
        bodyLocation: (r?.body_location as DeviceSummary['bodyLocation']) ?? null,
        nickname: r?.nickname ?? null,
        online,
        lastSeenAt: f.seenAt,
        batteryPct: f.batteryPct,
        charging: f.charging,
        chargingSince: f.chargingSince,
        onBody: f.category === 'PHONE' ? null : f.onBody,
        estimatedHoursLeft: estimatedHoursLeft(f),
        voiceOrder: null as number | null,
        voiceOrderManual: false as boolean,
        voiceNumberLast2: r?.voice_last2 ?? null,
        bridged: f.category !== 'PHONE' && f.bridged,
      } satisfies DeviceSummary,
    };
  });
  const order = voiceOrderOf(
    list
      .filter((x) => x.f.caps.voice)
      .map((x) => ({
        id: x.summary.id,
        category: x.f.category,
        online: x.online,
        onBody: x.f.onBody,
        charging: x.f.charging,
        seenAt: x.f.seenAt,
        manual: x.r?.voice_order ?? null,
      })),
  );
  for (const x of list) {
    const i = order.indexOf(x.summary.id);
    x.summary.voiceOrder = i < 0 ? null : i + 1;
    x.summary.voiceOrderManual = i >= 0 && x.r?.voice_order != null;
  }
  return list.map((x) => x.summary);
}

interface DeviceRow {
  id: string;
  kind: string;
  category: string | null;
  tier: string | null;
  body_location: string | null;
  nickname: string | null;
  voice_order: number | null;
  last_seen_at: Date | string | null;
  battery_pct: number | null;
  charging: boolean;
  charging_since: Date | string | null;
  on_wrist: boolean | null;
  connectivity: string | null;
  capabilities: Record<string, { available?: boolean }> | null;
  battery_life_h: number | null;
  /** Cihaza özel numaranın son iki hanesi (numaranın kendisi okunmaz). */
  voice_last2: string | null;
  connection_path?: string | null;
}

const planWindowOf = (p: typeof chargingPlan.$inferSelect): PlanWindow => ({
  start: p.windowStart,
  end: p.windowEnd,
  source: p.source as PlanWindow['source'],
  nightChargeAllowed: p.nightChargeAllowed,
  learnedDays: p.learnedDays,
  learnedAt: p.learnedAt,
});

/**
 * Kişilerin `from`–`to` kapsama geçmişi: `from` öncesindeki son satır (o andaki seviye) + aralıktaki satırlar.
 * Rapor uçları (kişi zaman çizelgesi, amir kronik listesi, yönetim kişi-gün yüzdesi) ortak kullanır.
 */
export async function historyRows(
  q: Pick<Db, 'select'>,
  personIds: string[],
  from: Date,
  to: Date,
): Promise<Map<string, HistoryRow[]>> {
  const out = new Map<string, HistoryRow[]>();
  if (!personIds.length) return out;
  const ids = sql.join(
    personIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = await q
    .select({
      id: coverageHistory.protectedPersonId,
      at: coverageHistory.at,
      level: coverageHistory.level,
      reasons: coverageHistory.reasons,
    })
    .from(coverageHistory)
    .where(
      and(
        sql`${coverageHistory.protectedPersonId} IN (${ids})`,
        lt(coverageHistory.at, to),
        sql`(${coverageHistory.at} >= ${from.toISOString()}::timestamptz OR ${coverageHistory.id} IN (
          SELECT DISTINCT ON (h.protected_person_id) h.id FROM event.coverage_history h
          WHERE h.protected_person_id IN (${ids}) AND h.at < ${from.toISOString()}::timestamptz
          ORDER BY h.protected_person_id, h.at DESC, h.id DESC))`,
      ),
    )
    .orderBy(asc(coverageHistory.at), asc(coverageHistory.id));
  for (const r of rows) {
    const list = out.get(r.id) ?? [];
    list.push({ at: r.at, level: r.level as CoverageLevel, reasons: r.reasons });
    out.set(r.id, list);
  }
  return out;
}

const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);

/** Kayıt satırı → olgu (kayıt alanları sinyal alımında yazılır; olgudan daha yeniyse onlar geçerli). */
function rowFact(r: DeviceRow, fact?: DeviceFact): DeviceFact {
  const category = (r.category ?? (r.kind.endsWith('PHONE') ? 'PHONE' : 'WATCH')) as DeviceCategory;
  const c = r.capabilities;
  const caps = c
    ? {
        sos: !!c.sos?.available,
        fall: !!c.fall?.available,
        voice: !!c.voice?.available,
        location: !!c.location?.available,
      }
    : DEFAULT_CAPS[category];
  const seenAt = iso(r.last_seen_at);
  const useFact = !!fact?.seenAt && (!seenAt || fact.seenAt >= seenAt);
  return {
    id: r.id,
    kind: r.kind,
    category,
    tier: (r.tier ?? DEFAULT_TIER[category]) as DeviceTier,
    caps,
    batteryLifeH: r.battery_life_h,
    seenAt: useFact ? fact!.seenAt : seenAt,
    onBody: useFact ? fact!.onBody : r.on_wrist,
    charging: useFact ? fact!.charging : r.charging,
    chargingSince: useFact ? fact!.chargingSince : iso(r.charging_since),
    chargeEndedAt: fact?.chargeEndedAt ?? null,
    batteryPct: useFact ? fact!.batteryPct : r.battery_pct,
    bridged: useFact ? fact!.bridged : r.connectivity === 'BLE' && category !== 'PHONE',
    // T-085 OEM: hat / elektrik yalnız sinyalden (olgu); ev ünitesi bağlantısı kayıttan da.
    ...(fact?.lineDown !== undefined ? { lineDown: fact.lineDown } : {}),
    ...(fact?.powerLoss !== undefined ? { powerLoss: fact.powerLoss } : {}),
    ...(fact?.viaHomeUnit || r.connection_path === 'HOME_UNIT' ? { viaHomeUnit: true } : {}),
  };
}

/** Değerlendirme anı: en yeni görülme (sinyal anı dahil). */
function latest(f: Facts, at: Date): Date {
  let t = at.getTime();
  for (const d of Object.values(f.devices)) if (d.seenAt) t = Math.max(t, Date.parse(d.seenAt));
  if (f.bridgeSeenAt) t = Math.max(t, Date.parse(f.bridgeSeenAt));
  return new Date(t);
}

/** Şarj penceresi gece penceresiyle kesişiyor mu (dakika çözünürlüğü). */
function overlaps(ws: string, we: string, ss: string, se: string): boolean {
  const [a, b, c, d] = [hhmm(ws), hhmm(we), hhmm(ss), hhmm(se)];
  for (let m = a; m !== b; m = (m + 1) % 1440) if (inRange(m, c, d)) return true;
  return false;
}

/** Aktif cihaz sayıları (S1.7 sınırları): kayıt modülü kullanır. */
export async function activeDeviceCounts(
  tx: Pick<Db, 'select'>,
  protectedPersonId: string,
  excludeDeviceId?: string,
): Promise<{ total: number; phones: number; alarmWearables: number }> {
  const rows = await tx
    .select({ id: device.id, kind: device.kind, category: device.category, tier: device.tier })
    .from(device)
    .where(and(eq(device.protectedPersonId, protectedPersonId), isNull(device.revokedAt), isNull(device.retiredAt)));
  let total = 0;
  let phones = 0;
  let alarmWearables = 0;
  for (const r of rows) {
    if (r.id === excludeDeviceId) continue;
    total++;
    const category = (r.category ?? (r.kind.endsWith('PHONE') ? 'PHONE' : 'WATCH')) as DeviceCategory;
    const tier = (r.tier ?? DEFAULT_TIER[category]) as DeviceTier;
    if (category === 'PHONE') phones++;
    else if (tier === 'A' && isWearable({ category })) alarmWearables++;
  }
  return { total, phones, alarmWearables };
}

/** Filo raporları için kişi satırı (kapsama durumu + ayarlar). Ad yalnız amir panosuna gider; yönetim ölçüleri adsız. */
export interface FleetPerson {
  id: string;
  name: string | null;
  sleep: { timezone: string; start: string; end: string };
  holdUntil: Date | null;
  toleranceMin: number;
  chronicSince: Date | null;
  level: string;
  noneSince: Date | null;
  facts: Facts;
}

/** Kapsama durumu olan tüm kişiler (gece penceresi event.threshold, yoksa 22:00–08:00). */
export async function fleetPersons(q: Pick<Db, 'execute'>): Promise<FleetPerson[]> {
  const r = (await q.execute(sql`
    SELECT c.protected_person_id AS id, p.display_name AS name, coalesce(p.timezone, 'Europe/Istanbul') AS tz,
           coalesce(t.sleep_start::text, '22:00') AS ss, coalesce(t.sleep_end::text, '08:00') AS se,
           p.hold_until, coalesce(p.coverage_tolerance_min, 0) AS tol, c.chronic_gap_since, c.level, c.none_since,
           c.devices, c.bridge_seen_at
    FROM event.coverage_state c
    LEFT JOIN profile.protected_person p ON p.id::text = c.protected_person_id
    LEFT JOIN event.threshold t ON t.protected_person_id = c.protected_person_id
    ORDER BY c.protected_person_id`)) as unknown as {
    rows: {
      id: string;
      name: string | null;
      tz: string;
      ss: string;
      se: string;
      hold_until: Date | string | null;
      tol: number;
      chronic_gap_since: Date | string | null;
      level: string;
      none_since: Date | string | null;
      devices: Facts['devices'] | null;
      bridge_seen_at: Date | string | null;
    }[];
  };
  const d = (v: Date | string | null) => (v ? new Date(v) : null);
  return r.rows.map((x) => ({
    id: x.id,
    name: x.name,
    sleep: { timezone: x.tz, start: x.ss.slice(0, 5), end: x.se.slice(0, 5) },
    holdUntil: d(x.hold_until),
    toleranceMin: x.tol,
    chronicSince: d(x.chronic_gap_since),
    level: x.level,
    noneSince: d(x.none_since),
    facts: {
      devices: x.devices ?? {},
      bridgeSeenAt: x.bridge_seen_at ? new Date(x.bridge_seen_at).toISOString() : null,
    },
  }));
}

/** Kişi başına son `days` yerel günün uyanık zaman dağılımı (kişi zaman çizelgesiyle aynı hesap). */
export async function fleetDaily(
  q: Pick<Db, 'select'>,
  persons: Pick<FleetPerson, 'id' | 'sleep'>[],
  days: number,
  now: Date,
): Promise<Map<string, ReturnType<typeof dailyCoverage>>> {
  const out = new Map<string, ReturnType<typeof dailyCoverage>>();
  if (!persons.length) return out;
  const starts = new Map(persons.map((p) => [p.id, windowStart(now, days, p.sleep.timezone)] as const));
  const earliest = new Date(Math.min(...[...starts.values()].map((x) => x.getTime())));
  const rows = await historyRows(
    q,
    persons.map((p) => p.id),
    earliest,
    now,
  );
  for (const p of persons) {
    const from = starts.get(p.id)!;
    out.set(p.id, dailyCoverage(spansOf(rows.get(p.id) ?? [], from, now), from, now, p.sleep));
  }
  return out;
}
