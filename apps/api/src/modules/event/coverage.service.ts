import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import {
  type ChargingPlan,
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
import { and, eq, isNull, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import type { OutboxBus } from '../../common/outbox';
import type { Db, Tx } from '../../db/client';
import { auditLog, chargingPlan, coverageHistory, coverageState, device, protectionState } from '../../db/schema';
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
  planCheck,
  stepLadders,
  toProtectionState,
  voiceOrderOf,
} from './coverage';
import { isInWindow } from './night';
import { PROTECTION_REASON, type ProtectionFacts, type SleepWindow } from './protection';
import { batteryOf, chargingOf, coverageNoneOf, coverageOf, type RulePack, type RulesProvider } from './rules.loader';

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
  /** Olay işleri (KAPSAMA BOŞLUĞU aç / kapat). Bildirimler aynı transaction'da outbox'a yazıldı. */
  events: Exclude<LadderAction, { kind: 'notify' }>[];
}

export interface PlanWindow {
  start: string;
  end: string;
  source: ChargingPlan['source'];
  nightChargeAllowed: boolean;
}

type Row = typeof coverageState.$inferSelect;
interface SettingsSource {
  settingsOf(protectedPersonId: string, tx?: Pick<Db, 'execute'>): Promise<SleepWindow>;
}

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
    for (const r of rows) {
      const ctx = await this.contextOf(r.protectedPersonId, plans.get(r.protectedPersonId) ?? this.defaultPlan());
      const facts = factsOf(r);
      const cov = this.compute(facts, now, ctx);
      const step = stepLadders(ladderOf(r), cov, facts, this.ladderCtx(r.protectedPersonId, now, ctx));
      const plan = planCheck(facts, r.planCheckedOn, this.planCtx(r.protectedPersonId, now, ctx));
      const dirty =
        cov.level !== r.level ||
        cov.reasons.join() !== r.reasons.join() ||
        step.actions.some((a) => a.kind !== 'gap-event') ||
        !!plan ||
        !sameLadder(step.state, ladderOf(r));
      if (!dirty) {
        // Yalnız (tekrar ayıklanan) olay isteği: satır değişmez, transaction gerekmez.
        const events = step.actions.filter((a) => a.kind === 'gap-event');
        if (events.length)
          out.push({
            protectedPersonId: r.protectedPersonId,
            at: now,
            coverage: cov,
            facts,
            levelChange: null,
            protection: null,
            events,
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
    return { window: `${p.start}-${p.end}`, source: p.source, nightChargeAllowed: p.nightChargeAllowed };
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

  private async contextOf(protectedPersonId: string, plan?: PlanWindow) {
    const sleep = await this.settings.settingsOf(protectedPersonId);
    return { sleep, plan: plan ?? (await this.planOf(protectedPersonId)) };
  }

  private defaultPlan(): PlanWindow {
    const [start, end] = chargingOf(this.pack).defaultWindow.split('-') as [string, string];
    return { start, end, source: 'DEFAULT', nightChargeAllowed: false };
  }

  private compute(f: Facts, now: Date, ctx: { sleep: SleepWindow }): CoverageResult {
    const pack = this.pack;
    return computeCoverage(f, now, {
      params: coverageOf(pack),
      deadPct: batteryOf(pack).deadPct,
      night: isInWindow(now, ctx.sleep.timezone, ctx.sleep.start, ctx.sleep.end),
    });
  }

  private ladderCtx(personId: string, now: Date, ctx: { sleep: SleepWindow; plan: PlanWindow }) {
    const charging = chargingOf(this.pack);
    return {
      personId,
      now,
      quiet: { ...ctx.sleep, resumeAfterWakeMin: charging.resumeAfterWakeMin ?? 30 },
      plan: { start: ctx.plan.start, end: ctx.plan.end },
      charging,
      none: coverageNoneOf(this.pack),
    };
  }

  private planCtx(personId: string, now: Date, ctx: { sleep: SleepWindow; plan: PlanWindow }) {
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
    ctx: { sleep: SleepWindow; plan: PlanWindow },
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
    const plan = planCheck(facts, row?.planCheckedOn ?? null, this.planCtx(personId, now, ctx));
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
                 m.battery_life_h
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
}

const planWindowOf = (p: typeof chargingPlan.$inferSelect): PlanWindow => ({
  start: p.windowStart,
  end: p.windowEnd,
  source: p.source as PlanWindow['source'],
  nightChargeAllowed: p.nightChargeAllowed,
});

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
