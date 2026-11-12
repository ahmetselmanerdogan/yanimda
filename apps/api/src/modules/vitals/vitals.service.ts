import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import {
  type EventType,
  type EventVitalsView,
  type FalseAlarm,
  type KafkaEnvelope,
  type NotifyRequest,
  type Signal,
  type SupervisorAlert,
  TOPICS,
  type VitalQuality,
  type VitalReview,
  type VitalRule,
  type VitalSlice,
  type WeeklyTrendsView,
} from '@yanimda/contracts';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { bus as globalBus, type LocalBus } from '../../common/bus';
import { OutboxBus } from '../../common/outbox';
import { safeError } from '../../common/safe-error';
import { DB, type Db } from '../../db/client';
import { auditLog, supervisorAlert } from '../../db/schema';
import { EventService } from '../event/event.service';
import { isInWindow } from '../event/night';
import { ProtectionService } from '../event/protection.service';
import {
  falseAlarmOf,
  loadRulePack,
  type RulePack,
  RULES,
  type RulesProvider,
  staticRules,
  vitalsEnabled,
  vitalsOf,
  type VitalsParams,
} from '../event/rules.loader';
import {
  baselineOf,
  bestQuality,
  buckets,
  effectiveQuality,
  evaluate,
  type Finding,
  localDay,
  median,
  moved,
  type PersonVitals,
  skinTempStreak,
  sliceOf,
  type VitalKind,
  type VitalPoint,
  weekStartOf,
  worsened,
  worseQuality,
} from './vitals';

type Rows<T> = { rows: T[] };
const KIND_OF: Partial<Record<Signal['kind'], VitalKind>> = {
  HEART_RATE: 'HR',
  SPO2: 'SPO2',
  SKIN_TEMP_DEVIATION: 'SKIN_TEMP',
};
export const VITAL_EVENT_TYPES: ReadonlySet<EventType> = new Set(['HEART_ANOMALY', 'SPO2_LOW']);
/** Katalogda kalite yoksa kategoriye göre (S1.4): yüzük / kulak / küpe Q3, diğerleri Q2. */
const CATEGORY_QUALITY: Record<string, VitalQuality> = { RING: 'Q3', EARBUD: 'Q3', EARRING: 'Q3' };
const CAPABILITY: Record<VitalKind, string> = { HR: 'heartRate', SPO2: 'spo2', SKIN_TEMP: 'skinTemp' };
/** Değer olaylarında "kişiye ulaşıldı" sayılan durumlar (S5.4 ulaşılamama merdiveni geçişi yapılmaz). */
const REACHED_STATES = new Set(['CONFIRMED_OK', 'CONFIRMED_EMERGENCY', 'DISPATCH']);
const NOT_GOOD = ['EMERGENCY', 'UNREACHABLE'];
/** Nabız / oksijen örneklerinin değerlendirme penceresi (dk). */
const LOOKBACK_MIN = 180;
const DAY_MS = 86_400_000;
const iso = (d: Date | number | string) => new Date(d).toISOString();
const ts = (v: Date | string) => new Date(v).getTime();

export interface VitalsActor {
  sub: string;
  supervisor: boolean;
}

/**
 * T-092 (docs/07 S6) değer kuralları — BAYRAKLA KAPALI (kural paketi `vitals.enabled`, ortam VITALS_ENABLED).
 * Kapalıyken hiçbir şey yazmaz ve okumaz: HEART_RATE / STEPS / SPO2 / SKIN_TEMP_DEVIATION yalnız signal.signal'de
 * kalır (bugünkü davranış), olay ve bildirim yok, uçlar 404.
 *
 * Açıkken:
 *  - Sinyal alımı (core şeridi): geçerli örnek health.vital_sample'a (ortak şartlar `eligible`), kişinin öğrenme
 *    başlangıcı, sonra S6.4 kuralları (vitals.ts) ve S6.7 yorgunluk sınırları: aynı süren okuma bir kez; P3 için
 *    "iyi" sonrası 24 sa sessizlik (%20 kötüleşme deler) ve haftada en çok 2 kontrol araması (fazlası amirin eşik
 *    incelemesine); P2 kombinasyonları hiçbir sınıra takılmaz. Olay EventService.raiseVital ile (HEART_ANOMALY /
 *    SPO2_LOW); tabandan sapma yalnız aileye F-VITAL-TREND (günde bir, aile susturabilir); düşme + alışılmadık nabız
 *    açık düşme olayına vurgu (P1 kalır).
 *  - Tarama (VITALS_SWEEP_MS): P3 değer olayı claimSlaMin üstlenilmezse amire O-VITAL-UNCLAIMED; kişiye ulaşılamadı ve
 *    unreachableMin hiçbir cihazda hareket yok → olay P2 hareketsizlik merdivenine (S5.4); günlük özetler, taban
 *    çizgisi (S6.3) ve saklama süreleri (S6.8: ham 30 gün, özet 13 ay).
 *  - Görünürlük (S6.8): operatör yalnız açık olayda son 2 saatin 5 dk ortancalarını, tabanı ve kalite rozetini görür
 *    (erişim denetime yazılır); aile haftalık eğilimleri ve "iyi" olmayan sonuçları. Dakika düzeyinde ham veri kimseye
 *    gitmez. Log'da kişi, değer yok.
 */
@Injectable()
export class VitalsService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Vitals');
  private readonly rules: RulesProvider;
  private readonly protection: Pick<ProtectionService, 'settingsOf'>;
  private unsubs: (() => void)[] = [];
  private timer?: NodeJS.Timeout;
  private lastDaily = 0;
  /** Testler saat enjekte eder (gün içi saatten bağımsız). */
  clock: () => Date = () => new Date();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OutboxBus) private readonly outbox: Pick<OutboxBus, 'publish'>,
    @Inject(EventService) private readonly events: Pick<EventService, 'raiseVital'>,
    @Optional() @Inject(RULES) rules?: RulesProvider,
    @Optional() @Inject(ProtectionService) protection?: Pick<ProtectionService, 'settingsOf'>,
  ) {
    this.rules = rules ?? staticRules(loadRulePack());
    this.protection = protection ?? new ProtectionService(db, outbox as OutboxBus, this.rules);
  }

  private get pack(): RulePack {
    return this.rules.current();
  }
  private get params(): VitalsParams {
    return vitalsOf(this.pack);
  }
  /** Bayrak (kural paketi + VITALS_ENABLED). */
  enabled(): boolean {
    return vitalsEnabled(this.pack);
  }

  onModuleInit() {
    this.subscribe();
  }

  onApplicationBootstrap() {
    const every = Number(process.env.VITALS_SWEEP_MS ?? 60_000);
    if (every > 0) {
      const tick = () =>
        this.sweep()
          .catch((e) => this.log.error(`Değer taraması başarısız: ${safeError(e)}`))
          .finally(() => {
            this.timer = setTimeout(tick, every);
            this.timer.unref();
          });
      this.timer = setTimeout(tick, Math.min(every, 60_000));
      this.timer.unref();
    }
  }

  onModuleDestroy() {
    clearTimeout(this.timer);
    for (const u of this.unsubs) u();
  }

  /**
   * Abonelikler core şeridinde: bayrak kapalıyken anında döner ve hiçbir satır yazılmaz (side şeridi her sinyal için
   * event.outbox_side satırı yazardı). Hata fırlatılırsa işçi zarfı yeniden teslim eder (olay motoru idempotent).
   */
  subscribe(bus: LocalBus = globalBus) {
    for (const u of this.unsubs) u();
    this.unsubs = [
      bus.subscribe<Signal>(TOPICS.signalReceived, (e) => this.onSignal(e.payload)),
      bus.subscribe<{ id: string; confirmedOutcome?: string; closedAt?: string; protectedPersonId: string }>(
        TOPICS.eventClosed,
        (e) => this.onEventClosed(e.payload).catch((err) => this.log.warn(`Kapanış işlenemedi: ${safeError(err)}`)),
      ),
      bus.subscribe<FalseAlarm>(TOPICS.eventFalseAlarm, (e) =>
        this.onFalseAlarm(e.payload).catch((err) => this.log.warn(`Yanlış alarm işlenemedi: ${safeError(err)}`)),
      ),
    ];
  }

  // ---- Sinyal alımı ----

  async onSignal(s: Signal): Promise<void> {
    const kind = KIND_OF[s.kind];
    if (!kind || !this.enabled()) return;
    if (typeof s.value !== 'number' || !Number.isFinite(s.value)) return;
    const v = this.params;
    const value = s.value;
    if (kind === 'HR' && (value < v.preconditions.hrMin || value > v.preconditions.hrMax)) return; // S6.4: atılır
    if (kind === 'SPO2' && (value < 50 || value > 100)) return;
    if (kind === 'SKIN_TEMP' && Math.abs(value) > 10) return;
    const at = new Date(s.occurredAt);
    const person = s.protectedPersonId;

    const dev = await this.deviceState(s, at, v);
    const still = !(await this.movedBetween(person, at.getTime() - v.preconditions.stillMin * 60_000, at.getTime()));
    const settings = await this.protection.settingsOf(person);
    const asleep = isInWindow(at, settings.timezone, settings.start, settings.end);
    const slice: VitalSlice = kind === 'SKIN_TEMP' ? 'SLEEP' : sliceOf(s.vital?.context, asleep, still);
    const claimed = s.vital?.quality;
    const quality = claimed ? worseQuality(claimed, dev.catalogQuality(kind)) : dev.catalogQuality(kind);
    const eligible =
      dev.worn &&
      !dev.charging &&
      dev.wornLongEnough &&
      (dev.batteryPct === null || dev.batteryPct >= v.preconditions.batteryPct) &&
      still &&
      s.vital?.context !== 'ACTIVE';
    const ins = (await this.db.execute(sql`
      INSERT INTO health.vital_sample
        (protected_person_id, device_id, kind, value, at, quality, slice, worn, still, eligible, source_key)
      VALUES (${person}, ${s.deviceId}, ${kind}, ${value}, ${iso(at)}::timestamptz, ${quality}, ${slice},
              ${dev.worn}, ${still}, ${eligible}, ${s.idempotencyKey})
      ON CONFLICT (source_key) DO NOTHING
      RETURNING id`)) as unknown as Rows<{ id: number }>;
    if (!ins.rows.length) return; // tekrar teslim
    await this.db.execute(sql`
      INSERT INTO health.vital_profile (protected_person_id, learning_started_at)
      VALUES (${person}, ${iso(at)}::timestamptz)
      ON CONFLICT (protected_person_id) DO UPDATE SET learning_started_at =
        LEAST(coalesce(health.vital_profile.learning_started_at, EXCLUDED.learning_started_at),
              EXCLUDED.learning_started_at)`);
    if (kind === 'SKIN_TEMP') return; // gece değeri: yalnız haftalık eğilim (S6.4)
    await this.evaluatePerson(person);
  }

  /** Kişinin son örnekleriyle kuralları çalıştırır ve sonuçları uygular (yorgunluk sınırlarıyla). */
  async evaluatePerson(person: string, now = this.clock()): Promise<Finding[]> {
    const v = this.params;
    const n = now.getTime();
    const from = n - LOOKBACK_MIN * 60_000;
    const r = (await this.db.execute(sql`
      SELECT device_id, kind, value, at, quality, slice, worn, still, eligible FROM health.vital_sample
      WHERE protected_person_id = ${person} AND kind IN ('HR', 'SPO2')
        AND at > ${iso(from)}::timestamptz AND at <= ${iso(n)}::timestamptz`)) as unknown as Rows<{
      device_id: string;
      kind: VitalKind;
      value: number;
      at: Date | string;
      quality: VitalQuality;
      slice: VitalSlice;
      worn: boolean;
      still: boolean;
      eligible: boolean;
    }>;
    const pts = (k: VitalKind): VitalPoint[] =>
      r.rows
        .filter((x) => x.kind === k)
        .map((x) => ({
          deviceId: x.device_id,
          at: ts(x.at),
          value: Number(x.value),
          quality: x.quality,
          slice: x.slice,
          worn: x.worn,
          still: x.still,
          eligible: x.eligible,
        }));
    const state = await this.personState(person, now);
    const fall = (await this.db.execute(sql`
      SELECT id::text AS id FROM event.event
      WHERE protected_person_id = ${person} AND state <> 'CLOSED' AND type = 'FALL' LIMIT 1`)) as unknown as Rows<{
      id: string;
    }>;
    // Kombinasyon "hiçbir cihazda hareket yok" (S6.4): ortak şarttaki "< 20 adım"dan sıkı — tek adım bile hareket.
    const stillCombo = !(await this.movedBetween(person, n - v.comboMin * 60_000, n, 1));
    const findings = evaluate({
      now: n,
      params: v,
      person: state,
      hr: pts('HR'),
      spo2: pts('SPO2'),
      stillCombo,
      fallOpen: fall.rows.length > 0,
    });
    for (const f of findings) {
      try {
        await this.apply(person, f, now, { fallEventId: fall.rows[0]?.id, lookbackStart: from, muted: state.muted });
      } catch (e) {
        this.log.error(`Değer kuralı uygulanamadı (${f.rule}): ${safeError(e)}`);
        throw e;
      }
    }
    return findings;
  }

  private async apply(
    person: string,
    f: Finding,
    now: Date,
    ctx: { fallEventId?: string; lookbackStart: number; muted: boolean },
  ) {
    const v = this.params;
    if (f.target === 'HIGHLIGHT') {
      if (!ctx.fallEventId) return;
      const seen = (await this.db.execute(sql`
        SELECT 1 FROM health.vital_alert WHERE event_id = ${ctx.fallEventId}::uuid AND rule = 'FALL_HR_HIGHLIGHT'
        LIMIT 1`)) as unknown as Rows<unknown>;
      if (seen.rows.length) return;
      await this.db.transaction(async (tx) => {
        await this.insertAlert(tx, person, f, 'HIGHLIGHT', now, ctx.fallEventId);
        await tx.insert(auditLog).values({
          actorKind: 'SYSTEM',
          action: 'event.vitals_highlight',
          entityType: 'event',
          entityId: ctx.fallEventId!,
          data: { rule: f.rule },
        });
        await this.outbox.publish(
          TOPICS.eventUpdated,
          this.envelope(TOPICS.eventUpdated, person, { eventId: ctx.fallEventId, reason: 'VITALS_ABNORMAL' }, now),
          tx,
        );
      });
      return;
    }
    // Aynı süren okuma ikinci kez tetiklemez (bölüm = kesintisiz ihlal). Okuma pencereyi aşacak kadar uzun sürüyorsa
    // son 24 saatteki aynı kuralın kaydı aynı bölüm sayılır.
    const spansWindow = f.runStart - ctx.lookbackStart <= v.preconditions.maxGapMin * 60_000;
    const since = spansWindow ? now.getTime() - DAY_MS : f.runStart - 60_000;
    const prior = (await this.db.execute(sql`
      SELECT 1 FROM health.vital_alert WHERE protected_person_id = ${person} AND rule = ${f.rule}
        AND at >= ${iso(since)}::timestamptz LIMIT 1`)) as unknown as Rows<unknown>;
    if (prior.rows.length) return;

    if (f.target === 'FAMILY') {
      if (ctx.muted) return; // S7.4: aile P4 eğilimleri susturabilir
      const tz = (await this.protection.settingsOf(person)).timezone;
      await this.db.transaction(async (tx) => {
        await this.insertAlert(tx, person, f, 'FAMILY', now);
        const payload: NotifyRequest = {
          code: v.trendCode,
          audience: 'FAMILY',
          protectedPersonId: person,
          dedupeKey: `vital-trend:${person}:${localDay(now, tz)}`,
        };
        await this.outbox.publish(
          TOPICS.notifyRequested,
          this.envelope(TOPICS.notifyRequested, person, payload, now),
          tx,
        );
      });
      return;
    }

    // Operatör olayı. P2 kombinasyonları hiçbir sınıra takılmaz (S6.7).
    if (f.priority >= 3) {
      const silence = (await this.db.execute(sql`
        SELECT ref_value FROM health.vital_silence
        WHERE protected_person_id = ${person} AND rule = ${f.rule} AND until > ${iso(now)}::timestamptz`)) as unknown as Rows<{
        ref_value: number;
      }>;
      const ref = silence.rows[0]?.ref_value;
      if (ref !== undefined && !worsened(f.rule, f.value, Number(ref), v.worsenPct)) return;
      const week = (await this.db.execute(sql`
        SELECT count(*)::int AS n FROM health.vital_alert
        WHERE protected_person_id = ${person} AND outcome = 'EVENT' AND priority >= 3
          AND at > ${iso(now.getTime() - 7 * DAY_MS)}::timestamptz`)) as unknown as Rows<{ n: number }>;
      if ((week.rows[0]?.n ?? 0) >= v.maxChecksPerWeek) {
        await this.db.transaction(async (tx) => {
          await this.insertAlert(tx, person, f, 'LIMITED', now);
          await this.review(
            tx,
            person,
            f.rule,
            'WEEKLY_LIMIT',
            `weekly:${person}:${f.rule}:${weekStartOf(now.toISOString().slice(0, 10))}`,
            now,
          );
        });
        this.log.log(`Değer kontrol araması haftalık sınırda; eşik incelemesine gönderildi (${f.rule})`);
        return;
      }
    }
    const eventId = await this.events.raiseVital(f.eventType!, {
      protectedPersonId: person,
      sourceId: `vital:${f.rule}:${iso(f.runStart)}`,
      note: f.rule,
      priority: f.priority,
      headOfQueue: f.headOfQueue,
    });
    await this.db.transaction((tx) => this.insertAlert(tx, person, f, 'EVENT', now, eventId ?? undefined));
    this.log.warn(`Değer olayı: ${f.rule} P${f.priority}`);
  }

  private async insertAlert(
    tx: Pick<Db, 'execute'>,
    person: string,
    f: Finding,
    outcome: 'EVENT' | 'FAMILY' | 'LIMITED' | 'HIGHLIGHT',
    now: Date,
    eventId?: string,
  ) {
    await tx.execute(sql`
      INSERT INTO health.vital_alert (id, protected_person_id, rule, outcome, priority, value, run_start, at, event_id)
      VALUES (${uuidv7()}::uuid, ${person}, ${f.rule}, ${outcome}, ${f.priority}, ${f.value},
              ${iso(f.runStart)}::timestamptz, ${iso(now)}::timestamptz, ${eventId ?? null}::uuid)`);
  }

  private async review(
    tx: Pick<Db, 'execute'>,
    person: string,
    rule: VitalRule,
    reason: 'WEEKLY_LIMIT' | 'FALSE_ALARMS',
    dedupeKey: string,
    now: Date,
  ) {
    await tx.execute(sql`
      INSERT INTO health.vital_review (id, protected_person_id, rule, reason, dedupe_key, created_at)
      VALUES (${uuidv7()}::uuid, ${person}, ${rule}, ${reason}, ${dedupeKey}, ${iso(now)}::timestamptz)
      ON CONFLICT (dedupe_key) DO NOTHING`);
  }

  /** Kişinin öğrenme durumu, nabız tabanı ve kişiye özel eşikleri. */
  private async personState(person: string, now: Date): Promise<PersonVitals & { muted: boolean }> {
    const v = this.params;
    const p = (await this.db.execute(sql`
      SELECT learning_started_at, low_hr, high_hr, spo2_low, copd, trends_muted FROM health.vital_profile
      WHERE protected_person_id = ${person}`)) as unknown as Rows<{
      learning_started_at: Date | string | null;
      low_hr: number | null;
      high_hr: number | null;
      spo2_low: number | null;
      copd: boolean;
      trends_muted: boolean;
    }>;
    const row = p.rows[0];
    const started = row?.learning_started_at ? ts(row.learning_started_at) : null;
    const b = (await this.db.execute(sql`
      SELECT slice, median FROM health.vital_baseline WHERE protected_person_id = ${person} AND kind = 'HR'`)) as unknown as Rows<{
      slice: VitalSlice;
      median: number;
    }>;
    const baseline = b.rows.length ? Object.fromEntries(b.rows.map((x) => [x.slice, Number(x.median)])) : null;
    return {
      learning: started === null || now.getTime() < started + v.learnDays * DAY_MS,
      baseline,
      overrides: {
        lowHr: row?.low_hr ?? null,
        highHr: row?.high_hr ?? null,
        spo2Low: row?.spo2_low ?? null,
        copd: !!row?.copd,
      },
      muted: !!row?.trends_muted,
    };
  }

  /**
   * Örnek anında cihazın durumu: takılı / şarjda / pil (sinyalin cihaz bloğu, yoksa kapsama olgusu), ≥ wornMin dk
   * takılı (son "çıkarıldı / şarja girdi" gözleminden sonraki ilk "takılı" gözlemi) ve katalog kalitesi.
   */
  private async deviceState(s: Signal, at: Date, v: VitalsParams) {
    const fact = (await this.db.execute(sql`
      SELECT devices->${s.deviceId} AS fact FROM event.coverage_state WHERE protected_person_id = ${s.protectedPersonId}`)) as unknown as Rows<{
      fact: { onBody?: boolean | null; charging?: boolean; batteryPct?: number | null } | null;
    }>;
    const f = fact.rows[0]?.fact ?? null;
    const worn = s.device?.onWrist ?? f?.onBody ?? false;
    const charging = s.device?.charging ?? f?.charging ?? false;
    const batteryPct = s.device?.batteryPct ?? f?.batteryPct ?? null;
    const atIso = iso(at);
    const off = (await this.db.execute(sql`
      SELECT max(time) AS t FROM signal.signal
      WHERE device_id = ${s.deviceId} AND time <= ${atIso}::timestamptz
        AND (kind IN ('OFF_BODY', 'CHARGE_START') OR payload->'device'->>'onWrist' = 'false'
             OR payload->'device'->>'charging' = 'true')`)) as unknown as Rows<{ t: Date | string | null }>;
    const lastOff = off.rows[0]?.t ? iso(off.rows[0].t) : null;
    const on = (await this.db.execute(sql`
      SELECT min(time) AS t FROM signal.signal
      WHERE device_id = ${s.deviceId} AND time <= ${atIso}::timestamptz
        AND time > coalesce(${lastOff}::timestamptz, '-infinity'::timestamptz)
        AND (kind = 'ON_BODY' OR payload->'device'->>'onWrist' = 'true')`)) as unknown as Rows<{
      t: Date | string | null;
    }>;
    const wornSince = on.rows[0]?.t ? ts(on.rows[0].t) : null;
    const wornLongEnough = wornSince !== null && at.getTime() - wornSince >= v.preconditions.wornMin * 60_000;
    const m = (await this.db.execute(sql`
      SELECT m.capabilities, coalesce(d.category, m.category) AS category
      FROM device.device d LEFT JOIN device.device_model m ON m.id = coalesce(d.model_id, d.kind)
      WHERE d.id::text = ${s.deviceId}`)) as unknown as Rows<{
      capabilities: Record<string, { quality?: VitalQuality }> | null;
      category: string | null;
    }>;
    const caps = m.rows[0]?.capabilities ?? null;
    const category = m.rows[0]?.category ?? s.source?.category ?? 'WATCH';
    return {
      worn: worn === true,
      charging: charging === true,
      batteryPct,
      wornLongEnough,
      catalogQuality: (k: VitalKind): VitalQuality =>
        caps?.[CAPABILITY[k]]?.quality ?? CATEGORY_QUALITY[category] ?? 'Q2',
    };
  }

  /**
   * [from, to] aralığında hiçbir cihazda hareket var mı (S6.4): adım sayaçlarının artışı ≥ stillSteps veya ACTIVE
   * bağlamlı ölçüm. STEPS.value ve HEARTBEAT payload.steps günlük kümülatif sayaçtır.
   */
  async movedBetween(
    person: string,
    from: number,
    to: number,
    steps = this.params.preconditions.stillSteps,
  ): Promise<boolean> {
    const r = (await this.db.execute(sql`
      SELECT device_id, time, kind, value, payload->'payload'->>'steps' AS hb, payload->'vital'->>'context' AS ctx
      FROM signal.signal
      WHERE protected_person_id = ${person} AND time > ${iso(from - 2 * 3600_000)}::timestamptz
        AND time <= ${iso(to)}::timestamptz
        AND kind IN ('STEPS', 'HEARTBEAT', 'HEART_RATE', 'SPO2')`)) as unknown as Rows<{
      device_id: string;
      time: Date | string;
      kind: string;
      value: number | null;
      hb: string | null;
      ctx: string | null;
    }>;
    if (r.rows.some((x) => x.ctx === 'ACTIVE' && ts(x.time) > from)) return true;
    const counters = r.rows
      .map((x) => ({
        deviceId: x.device_id,
        at: ts(x.time),
        value: x.kind === 'STEPS' ? x.value : x.kind === 'HEARTBEAT' && x.hb !== null ? Number(x.hb) : null,
      }))
      .filter((c): c is { deviceId: string; at: number; value: number } => typeof c.value === 'number');
    return moved(counters, from, to, steps);
  }

  // ---- Olay kapanışı ve yanlış alarm (S6.7) ----

  /** Operatör "iyi" (OK) kaydetti: kişi + kural cooldownH susar; referans okuma olayı açan okumadır. P2 susmaz. */
  async onEventClosed(ev: { id: string; confirmedOutcome?: string; closedAt?: string; protectedPersonId: string }) {
    if (!this.enabled() || ev.confirmedOutcome !== 'OK') return;
    const v = this.params;
    const until = (ev.closedAt ? ts(ev.closedAt) : this.clock().getTime()) + v.cooldownH * 3600_000;
    await this.db.execute(sql`
      INSERT INTO health.vital_silence (protected_person_id, rule, until, ref_value, event_id)
      SELECT protected_person_id, rule, ${iso(until)}::timestamptz, value, event_id FROM health.vital_alert
      WHERE event_id = ${ev.id}::uuid AND outcome = 'EVENT' AND priority >= 3
      ON CONFLICT (protected_person_id, rule) DO UPDATE
        SET until = EXCLUDED.until, ref_value = EXCLUDED.ref_value, event_id = EXCLUDED.event_id`);
  }

  /** T-071 yanlış alarm incelemesi değerlere de (S6.7): pencerede reviewAfter. değer yanlış alarmı → eşik incelemesi. */
  async onFalseAlarm(fa: FalseAlarm) {
    if (!this.enabled()) return;
    const upd = (await this.db.execute(sql`
      UPDATE health.vital_alert SET false_alarm_at = coalesce(false_alarm_at, ${fa.at}::timestamptz)
      WHERE event_id = ${fa.eventId}::uuid AND outcome = 'EVENT'
      RETURNING rule`)) as unknown as Rows<{ rule: VitalRule }>;
    if (!upd.rows.length) return;
    const fp = falseAlarmOf(this.pack);
    const now = new Date(fa.at);
    const n = (await this.db.execute(sql`
      SELECT count(DISTINCT event_id)::int AS n FROM health.vital_alert
      WHERE protected_person_id = ${fa.protectedPersonId} AND false_alarm_at IS NOT NULL
        AND false_alarm_at > ${iso(now.getTime() - fp.windowDays * DAY_MS)}::timestamptz`)) as unknown as Rows<{
      n: number;
    }>;
    if ((n.rows[0]?.n ?? 0) < fp.reviewAfter) return;
    const bucket = Math.floor(now.getTime() / (fp.windowDays * DAY_MS));
    await this.review(
      this.db,
      fa.protectedPersonId,
      upd.rows[0]!.rule,
      'FALSE_ALARMS',
      `fa:${fa.protectedPersonId}:${bucket}`,
      now,
    );
  }

  // ---- Tarama ----

  /** Dakikalık: üstlenme hedefi, ulaşılamama geçişi; saatlik: günlük özet, taban çizgisi, saklama süreleri. */
  async sweep(now = this.clock()): Promise<void> {
    await this.purge(now); // saklama süresi bayraktan bağımsız (kapalıyken değer tabloları boştur)
    if (!this.enabled()) return;
    await this.sweepEvents(now);
    if (now.getTime() - this.lastDaily >= 3600_000) {
      this.lastDaily = now.getTime();
      await this.sweepDaily(now);
    }
  }

  async sweepEvents(now = this.clock()): Promise<void> {
    const v = this.params;
    const r = (await this.db.execute(sql`
      SELECT a.id::text AS alert_id, a.event_id::text AS event_id, a.protected_person_id AS person, a.priority,
             a.at, a.escalated_at, e.type, e.state, e.escalated_at AS queued_at,
             EXISTS (SELECT 1 FROM chain.chain_run r JOIN chain.chain_step s ON s.run_id = r.id
                     WHERE r.event_id = e.id AND s.result = 'REACHED') AS reached
      FROM health.vital_alert a JOIN event.event e ON e.id = a.event_id
      WHERE a.outcome = 'EVENT' AND e.state <> 'CLOSED'`)) as unknown as Rows<{
      alert_id: string;
      event_id: string;
      person: string;
      priority: number;
      at: Date | string;
      escalated_at: Date | string | null;
      type: EventType;
      state: string;
      queued_at: Date | string | null;
      reached: boolean;
    }>;
    for (const a of r.rows) {
      if (
        a.priority >= 3 &&
        a.state === 'OPERATOR_QUEUE' &&
        a.queued_at &&
        now.getTime() - ts(a.queued_at) >= v.claimSlaMin * 60_000
      )
        await this.alertUnclaimed(a.event_id, a.type, now);
      if (
        !a.escalated_at &&
        VITAL_EVENT_TYPES.has(a.type) &&
        !REACHED_STATES.has(a.state) &&
        !a.reached &&
        now.getTime() - ts(a.at) >= v.unreachableMin * 60_000 &&
        !(await this.movedBetween(a.person, now.getTime() - v.unreachableMin * 60_000, now.getTime()))
      ) {
        // S5.4: ulaşılamadı ve 10 dk hiçbir cihazda hareket yok → P2 hareketsizlik merdiveni (olay yükseltilir).
        await this.events.raiseVital('INACTIVITY', {
          protectedPersonId: a.person,
          sourceId: `vital-unreachable:${a.event_id}`,
          note: 'VITAL_UNREACHABLE',
          priority: 2,
        });
        await this.db.execute(sql`
          UPDATE health.vital_alert SET escalated_at = ${iso(now)}::timestamptz WHERE event_id = ${a.event_id}::uuid`);
        this.log.warn('Değer olayı: ulaşılamadı + hareket yok → hareketsizlik merdiveni');
      }
    }
  }

  private async alertUnclaimed(eventId: string, type: EventType, now: Date) {
    const dedupeKey = `vital-unclaimed:${eventId}`;
    const alert: SupervisorAlert & { dedupeKey: string } = {
      code: 'O-VITAL-UNCLAIMED',
      eventId,
      eventType: type,
      at: now.toISOString(),
      dedupeKey,
    };
    await this.db.transaction(async (tx) => {
      const ins = await tx
        .insert(supervisorAlert)
        .values({ id: uuidv7(), dedupeKey, code: alert.code, eventId, eventType: type, at: now })
        .onConflictDoNothing()
        .returning({ id: supervisorAlert.id });
      if (ins.length)
        await this.outbox.publish(
          TOPICS.supervisorAlert,
          this.envelope(TOPICS.supervisorAlert, eventId, alert, now),
          tx,
        );
    });
  }

  /** Son 2 günün günlük özetleri (kişinin yerel günü) ve öğrenmesi bitmiş kişilerin taban çizgisi (günde bir). */
  async sweepDaily(now = this.clock()): Promise<void> {
    const persons = (await this.db.execute(sql`
      SELECT DISTINCT protected_person_id AS p FROM health.vital_sample
      WHERE at > ${iso(now.getTime() - 2 * DAY_MS)}::timestamptz`)) as unknown as Rows<{ p: string }>;
    for (const { p } of persons.rows) {
      try {
        const tz = (await this.protection.settingsOf(p)).timezone;
        await this.summarize(p, tz, now);
        const state = await this.personState(p, now);
        if (state.learning) continue;
        const fresh = (await this.db.execute(sql`
          SELECT 1 FROM health.vital_baseline WHERE protected_person_id = ${p}
            AND computed_at > ${iso(now.getTime() - 20 * 3600_000)}::timestamptz LIMIT 1`)) as unknown as Rows<unknown>;
        if (!fresh.rows.length) await this.computeBaseline(p, tz, now);
      } catch (e) {
        this.log.error(`Değer özeti / taban çizgisi hesaplanamadı: ${safeError(e)}`);
      }
    }
  }

  /** Günlük dilim özetleri (takılı örnekler; nabızda uyku / dinlenme dilimleri hareketsiz). */
  async summarize(person: string, tz: string, now: Date) {
    const r = (await this.db.execute(sql`
      SELECT kind, value, at, slice, still FROM health.vital_sample
      WHERE protected_person_id = ${person} AND worn AND at > ${iso(now.getTime() - 3 * DAY_MS)}::timestamptz
        AND at <= ${iso(now)}::timestamptz`)) as unknown as Rows<{
      kind: VitalKind;
      value: number;
      at: Date | string;
      slice: VitalSlice;
      still: boolean;
    }>;
    const days = new Set([localDay(now, tz), localDay(new Date(now.getTime() - DAY_MS), tz)]);
    const groups = new Map<string, number[]>();
    for (const x of r.rows) {
      if (x.kind === 'HR' && x.slice !== 'ACTIVE' && !x.still) continue;
      const day = localDay(new Date(x.at), tz);
      if (!days.has(day)) continue;
      const k = `${day}|${x.kind}|${x.slice}`;
      groups.set(k, [...(groups.get(k) ?? []), Number(x.value)]);
    }
    for (const [k, vs] of groups) {
      const [day, kind, slice] = k.split('|');
      await this.db.execute(sql`
        INSERT INTO health.vital_daily (protected_person_id, day, kind, slice, median, min, max, n, computed_at)
        VALUES (${person}, ${day}::date, ${kind}, ${slice}, ${median(vs)}, ${Math.min(...vs)}, ${Math.max(...vs)},
                ${vs.length}, ${iso(now)}::timestamptz)
        ON CONFLICT (protected_person_id, day, kind, slice) DO UPDATE SET median = EXCLUDED.median,
          min = EXCLUDED.min, max = EXCLUDED.max, n = EXCLUDED.n, computed_at = EXCLUDED.computed_at`);
    }
  }

  /** S6.3: 28 günlük kayan pencereden dilim tabanları (yeterli geçerli gün olmayan dilim silinir: genel eşik). */
  async computeBaseline(person: string, tz: string, now: Date) {
    const v = this.params;
    const r = (await this.db.execute(sql`
      SELECT value, at, quality, slice, worn, still, eligible FROM health.vital_sample
      WHERE protected_person_id = ${person} AND kind = 'HR'
        AND at > ${iso(now.getTime() - v.baselineDays * DAY_MS)}::timestamptz
        AND at <= ${iso(now)}::timestamptz`)) as unknown as Rows<{
      value: number;
      at: Date | string;
      quality: VitalQuality;
      slice: VitalSlice;
      worn: boolean;
      still: boolean;
      eligible: boolean;
    }>;
    const base = baselineOf(
      r.rows.map((x) => ({ ...x, value: Number(x.value), at: ts(x.at) })),
      tz,
      v,
    );
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM health.vital_baseline WHERE protected_person_id = ${person} AND kind = 'HR'`);
      for (const b of base)
        await tx.execute(sql`
          INSERT INTO health.vital_baseline (protected_person_id, kind, slice, median, valid_days, computed_at)
          VALUES (${person}, 'HR', ${b.slice}, ${b.median}, ${b.validDays}, ${iso(now)}::timestamptz)`);
    });
    return base;
  }

  /**
   * S6.8 saklama: ham örnekler rawDays, özetler / tetiklenen kurallar / çözülmüş incelemeler summaryMonths. Yeni sinyal
   * türleri (SPO2, SKIN_TEMP_DEVIATION) signal.signal'de de rawDays; HEART_RATE ham kaydı yalnız bayrak açıkken
   * kısaltılır (kapalıyken bugünkü davranış değişmez).
   */
  async purge(now = this.clock()): Promise<void> {
    const v = this.params;
    const raw = iso(now.getTime() - v.retention.rawDays * DAY_MS);
    const months = new Date(now);
    months.setUTCMonth(months.getUTCMonth() - v.retention.summaryMonths);
    const summary = iso(months);
    await this.db.execute(sql`DELETE FROM health.vital_sample WHERE at < ${raw}::timestamptz`);
    await this.db.execute(sql`DELETE FROM health.vital_daily WHERE day < (${summary}::timestamptz)::date`);
    await this.db.execute(sql`DELETE FROM health.vital_alert WHERE at < ${summary}::timestamptz`);
    await this.db.execute(sql`DELETE FROM health.vital_review WHERE resolved_at < ${summary}::timestamptz`);
    await this.db.execute(sql`DELETE FROM health.vital_silence WHERE until < ${iso(now)}::timestamptz`);
    const kinds = this.enabled() ? ['SPO2', 'SKIN_TEMP_DEVIATION', 'HEART_RATE'] : ['SPO2', 'SKIN_TEMP_DEVIATION'];
    await this.db.execute(sql`
      DELETE FROM signal.signal WHERE time < ${raw}::timestamptz
        AND kind IN (${sql.join(
          kinds.map((k) => sql`${k}`),
          sql`, `,
        )})`);
  }

  // ---- Görünürlük (S6.8) ----

  /**
   * GET /events/{id}/vitals — yalnız açık olayda (kapalı → 403), yalnız değer olayında veya değer kuralı / vurgu
   * eklenmiş olayda (yoksa 404). Son windowMin dk'nın bucketMin dk ortancaları; erişim denetime yazılır (değer yok).
   */
  async eventVitals(eventId: string, actor: VitalsActor, now = this.clock()): Promise<EventVitalsView> {
    if (!this.enabled()) throw new NotFoundException('Değer görünümü kapalı');
    if (!/^[0-9a-f-]{36}$/i.test(eventId)) throw new NotFoundException('Olay bulunamadı');
    const e = (await this.db.execute(sql`
      SELECT id::text AS id, protected_person_id AS person, type, state FROM event.event WHERE id = ${eventId}::uuid`)) as unknown as Rows<{
      id: string;
      person: string;
      type: EventType;
      state: string;
    }>;
    const ev = e.rows[0];
    if (!ev) throw new NotFoundException('Olay bulunamadı');
    const alerts = (await this.db.execute(sql`
      SELECT rule, value, at FROM health.vital_alert WHERE event_id = ${eventId}::uuid ORDER BY at`)) as unknown as Rows<{
      rule: VitalRule;
      value: number;
      at: Date | string;
    }>;
    if (!VITAL_EVENT_TYPES.has(ev.type) && !alerts.rows.length) throw new NotFoundException('Bu olayda değer yok');
    if (ev.state === 'CLOSED') throw new ForbiddenException('Değerler yalnız olay açıkken görünür');
    const v = this.params;
    const from = now.getTime() - v.view.windowMin * 60_000;
    const r = (await this.db.execute(sql`
      SELECT device_id, kind, value, at, quality, slice, worn, still, eligible FROM health.vital_sample
      WHERE protected_person_id = ${ev.person} AND kind IN ('HR', 'SPO2') AND worn
        AND at >= ${iso(from)}::timestamptz AND at <= ${iso(now)}::timestamptz`)) as unknown as Rows<{
      device_id: string;
      kind: 'HR' | 'SPO2';
      value: number;
      at: Date | string;
      quality: VitalQuality;
      slice: VitalSlice;
      worn: boolean;
      still: boolean;
      eligible: boolean;
    }>;
    const points = r.rows.map((x) => ({
      kind: x.kind,
      p: {
        deviceId: x.device_id,
        at: ts(x.at),
        value: Number(x.value),
        quality: x.quality,
        slice: x.slice,
        worn: x.worn,
        still: x.still,
        eligible: x.eligible,
      } satisfies VitalPoint,
    }));
    const agreeMs = v.agreeMin * 60_000;
    const qualities = (['HR', 'SPO2'] as const).flatMap((k) => {
      const ps = points.filter((x) => x.kind === k).map((x) => x.p);
      const agrees =
        k === 'HR'
          ? (a: number, b: number) => Math.abs(a - b) <= (Math.max(a, b) * v.hr.agreePct) / 100
          : (a: number, b: number) => Math.abs(a - b) <= v.spo2.agreePts;
      return ps.map((p) => effectiveQuality(p, ps, agreeMs, agrees));
    });
    const b = (await this.db.execute(sql`
      SELECT slice, median FROM health.vital_baseline WHERE protected_person_id = ${ev.person} AND kind = 'HR'`)) as unknown as Rows<{
      slice: VitalSlice;
      median: number;
    }>;
    await this.db.insert(auditLog).values({
      actorKind: 'OPERATOR',
      actorId: actor.sub,
      action: 'vitals.viewed',
      entityType: 'event',
      entityId: ev.id,
      data: { purpose: 'event' },
    });
    return {
      eventId: ev.id,
      windowMin: v.view.windowMin,
      bucketMin: v.view.bucketMin,
      series: (['HR', 'SPO2'] as const)
        .map((k) => ({
          kind: k,
          points: buckets(
            points.filter((x) => x.kind === k).map((x) => x.p),
            from,
            v.view.bucketMin,
          ),
        }))
        .filter((s) => s.points.length > 0),
      baseline: b.rows.length ? { HR: Object.fromEntries(b.rows.map((x) => [x.slice, Number(x.median)])) } : null,
      quality: bestQuality(qualities),
      alerts: alerts.rows.map((a) => ({ rule: a.rule, value: Number(a.value), at: iso(a.at) })),
      highlight: alerts.rows.some((a) => a.rule === 'FALL_HR_HIGHLIGHT'),
      noteCode: 'O-UI-VITALS-NOTE',
    };
  }

  /** GET /protected-persons/{id}/trends/weekly — aile (yetki çağıranda); haftalık özet + "iyi" olmayan sonuçlar. */
  async weeklyTrends(person: string, weeks = 4, now = this.clock()): Promise<WeeklyTrendsView> {
    if (!this.enabled()) throw new NotFoundException('Sağlık eğilimleri kapalı');
    const w = Math.min(Math.max(Math.trunc(Number(weeks)) || 4, 1), 13);
    const v = this.params;
    const tz = (await this.protection.settingsOf(person)).timezone;
    const today = localDay(now, tz);
    const firstWeek = weekStartOf(today);
    const fromDay = new Date(Date.parse(`${firstWeek}T00:00:00Z`) - (w - 1) * 7 * DAY_MS).toISOString().slice(0, 10);
    const r = (await this.db.execute(sql`
      SELECT day::text AS day, kind, slice, median, n FROM health.vital_daily
      WHERE protected_person_id = ${person} AND day >= ${fromDay}::date AND day <= ${today}::date`)) as unknown as Rows<{
      day: string;
      kind: VitalKind;
      slice: VitalSlice;
      median: number;
      n: number;
    }>;
    const rows = r.rows.map((x) => ({ ...x, day: x.day.slice(0, 10), median: Number(x.median) }));
    const out: WeeklyTrendsView['weeks'] = [];
    for (let i = 0; i < w; i++) {
      const start = new Date(Date.parse(`${fromDay}T00:00:00Z`) + i * 7 * DAY_MS).toISOString().slice(0, 10);
      const inWeek = rows.filter((x) => weekStartOf(x.day) === start);
      const med = (k: VitalKind, s: VitalSlice) => {
        const xs = inWeek.filter((x) => x.kind === k && x.slice === s).map((x) => x.median);
        return xs.length ? Math.round(median(xs) * 10) / 10 : null;
      };
      const nights = inWeek.filter((x) => x.kind === 'SKIN_TEMP').map((x) => ({ day: x.day, value: x.median }));
      out.push({
        weekStart: start,
        restingHr: med('HR', 'REST'),
        sleepHr: med('HR', 'SLEEP'),
        spo2: med('SPO2', 'REST'),
        skinTempNightsAbove: nights.filter((n) => n.value >= v.skinTemp.deltaC).length,
        skinTempTwoNights: skinTempStreak(nights, v.skinTemp.deltaC, v.skinTemp.nights),
        validDays: inWeek.filter((x) => x.kind === 'HR' && x.slice === 'REST' && x.n >= v.validDaySamples).length,
      });
    }
    const o = (await this.db.execute(sql`
      SELECT e.id::text AS id, e.type, e.confirmed_outcome AS outcome, e.closed_at AS at FROM event.event e
      WHERE e.protected_person_id = ${person} AND e.state = 'CLOSED'
        AND e.confirmed_outcome IN (${sql.join(
          NOT_GOOD.map((x) => sql`${x}`),
          sql`, `,
        )})
        AND e.closed_at >= ${fromDay}::date
        AND (e.type IN ('HEART_ANOMALY', 'SPO2_LOW')
             OR EXISTS (SELECT 1 FROM health.vital_alert a WHERE a.event_id = e.id AND a.outcome = 'EVENT'))
      ORDER BY e.closed_at`)) as unknown as Rows<{ id: string; type: EventType; outcome: string; at: Date | string }>;
    return {
      protectedPersonId: person,
      noteCode: 'F-VITAL-WELLNESS-NOTE',
      weeks: out,
      outcomes: o.rows.map((x) => ({ eventId: x.id, type: x.type, outcome: x.outcome, at: iso(x.at) })),
    };
  }

  // ---- Kişiye özel ayarlar (S6.7) ----

  async settings(person: string) {
    const r = (await this.db.execute(sql`
      SELECT low_hr, high_hr, spo2_low, copd, trends_muted, family_consent_at, doctor_note, learning_started_at
      FROM health.vital_profile WHERE protected_person_id = ${person}`)) as unknown as Rows<{
      low_hr: number | null;
      high_hr: number | null;
      spo2_low: number | null;
      copd: boolean;
      trends_muted: boolean;
      family_consent_at: Date | string | null;
      doctor_note: boolean;
      learning_started_at: Date | string | null;
    }>;
    const x = r.rows[0];
    const v = this.params;
    const started = x?.learning_started_at ? ts(x.learning_started_at) : null;
    return {
      enabled: this.enabled(),
      lowHr: x?.low_hr ?? null,
      highHr: x?.high_hr ?? null,
      spo2Low: x?.spo2_low ?? null,
      copd: !!x?.copd,
      trendsMuted: !!x?.trends_muted,
      familyConsentAt: x?.family_consent_at ? iso(x.family_consent_at) : null,
      doctorNote: !!x?.doctor_note,
      learningUntil: started === null ? null : iso(started + v.learnDays * DAY_MS),
      defaults: { lowHr: v.hr.low, highHr: v.hr.highResting, spo2Low: v.spo2.low, spo2LowCopd: v.spo2.lowCopd },
    };
  }

  /**
   * PUT /protected-persons/{id}/vital-settings — kişiye özel eşik veya KOAH profili yalnız `familyConsent: true` ve
   * `doctorNote: true` (yüklenmiş doktor notu işareti; içerik tutulmaz, isteğe bağlı `doctorNoteRef`) ile. Eşikler
   * null → genel eşiğe döner. `trendsMuted` aile P4 eğilim bildirimini susturur (P3 susturulamaz).
   */
  async setSettings(person: string, body: unknown, actorId: string, now = this.clock()) {
    if (typeof body !== 'object' || body === null || Array.isArray(body))
      throw new BadRequestException('Nesne bekleniyor');
    const b = body as Record<string, unknown>;
    const allowed = [
      'lowHr',
      'highHr',
      'spo2Low',
      'copd',
      'trendsMuted',
      'familyConsent',
      'doctorNote',
      'doctorNoteRef',
    ];
    const unknownKeys = Object.keys(b).filter((k) => !allowed.includes(k));
    if (unknownKeys.length) throw new BadRequestException(`Bilinmeyen alan: ${unknownKeys.join(', ')}`);
    const int = (k: string, min: number, max: number): number | null | undefined => {
      const x = b[k];
      if (x === undefined || x === null) return x as null | undefined;
      if (!Number.isInteger(x) || (x as number) < min || (x as number) > max)
        throw new BadRequestException(`${k} ${min}–${max} arası tam sayı olmalı`);
      return x as number;
    };
    const lowHr = int('lowHr', 25, 80);
    const highHr = int('highHr', 90, 220);
    const spo2Low = int('spo2Low', 70, 96);
    for (const k of ['copd', 'trendsMuted', 'familyConsent', 'doctorNote'])
      if (b[k] !== undefined && typeof b[k] !== 'boolean') throw new BadRequestException(`${k} boolean olmalı`);
    if (b.doctorNoteRef !== undefined && b.doctorNoteRef !== null)
      if (typeof b.doctorNoteRef !== 'string' || b.doctorNoteRef.length < 1 || b.doctorNoteRef.length > 200)
        throw new BadRequestException('doctorNoteRef 1–200 karakter olmalı');
    const personal = [lowHr, highHr, spo2Low].some((x) => typeof x === 'number') || b.copd === true;
    if (personal && !(b.familyConsent === true && b.doctorNote === true))
      throw new BadRequestException('Kişiye özel eşik aile onayı (familyConsent) ve doktor notu (doctorNote) ister');
    const cur = await this.settings(person);
    const next = {
      lowHr: lowHr === undefined ? cur.lowHr : lowHr,
      highHr: highHr === undefined ? cur.highHr : highHr,
      spo2Low: spo2Low === undefined ? cur.spo2Low : spo2Low,
      copd: typeof b.copd === 'boolean' ? b.copd : cur.copd,
      trendsMuted: typeof b.trendsMuted === 'boolean' ? b.trendsMuted : cur.trendsMuted,
    };
    const stillPersonal = next.lowHr !== null || next.highHr !== null || next.spo2Low !== null || next.copd;
    const consent = personal
      ? { at: iso(now), by: actorId, note: true, ref: (b.doctorNoteRef as string | null | undefined) ?? null }
      : stillPersonal
        ? null // önceki onay korunur
        : { at: null, by: null, note: false, ref: null };
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO health.vital_profile (protected_person_id) VALUES (${person})
        ON CONFLICT (protected_person_id) DO NOTHING`);
      await tx.execute(sql`
        UPDATE health.vital_profile SET low_hr = ${next.lowHr}, high_hr = ${next.highHr}, spo2_low = ${next.spo2Low},
          copd = ${next.copd}, trends_muted = ${next.trendsMuted},
          ${
            consent
              ? sql`family_consent_at = ${consent.at}::timestamptz, family_consent_by = ${consent.by},
                    doctor_note = ${consent.note}, doctor_note_ref = ${consent.ref},`
              : sql``
          }
          updated_at = ${iso(now)}::timestamptz, updated_by = ${actorId}
        WHERE protected_person_id = ${person}`);
      await tx.insert(auditLog).values({
        actorKind: 'FAMILY',
        actorId,
        action: 'vitals.settings',
        entityType: 'protected_person',
        entityId: person,
        data: { fields: Object.keys(b).filter((k) => k !== 'doctorNoteRef'), personal },
      });
    });
    return this.settings(person);
  }

  // ---- Amirin eşik incelemesi (S6.7) ----

  /** Amirin listesi: kişi adı (amir zaten panoda görür), kural ve neden; değer yazılmaz. */
  async reviews(open = true): Promise<VitalReview[]> {
    const r = (await this.db.execute(sql`
      SELECT r.id::text AS id, r.protected_person_id AS person, p.display_name AS name, r.rule, r.reason, r.note,
        r.created_at, r.resolved_at, r.resolved_by
      FROM health.vital_review r LEFT JOIN profile.protected_person p ON p.id::text = r.protected_person_id
      ${open ? sql`WHERE r.resolved_at IS NULL` : sql``}
      ORDER BY r.created_at DESC LIMIT 200`)) as unknown as Rows<{
      id: string;
      person: string;
      name: string | null;
      note: string | null;
      rule: VitalRule;
      reason: string;
      created_at: Date | string;
      resolved_at: Date | string | null;
      resolved_by: string | null;
    }>;
    return r.rows.map((x) => ({
      id: x.id,
      protectedPersonId: x.person,
      name: x.name,
      rule: x.rule,
      reason: x.reason as VitalReview['reason'],
      note: x.note,
      createdAt: iso(x.created_at),
      resolvedAt: x.resolved_at ? iso(x.resolved_at) : null,
      resolvedBy: x.resolved_by,
    }));
  }

  async resolveReview(id: string, supervisor: string, body: unknown, now = this.clock()) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException('İnceleme bulunamadı');
    const note = (body as { note?: unknown } | null)?.note;
    if (note !== undefined && (typeof note !== 'string' || note.length > 500))
      throw new BadRequestException('note ≤ 500 karakter');
    const r = (await this.db.execute(sql`
      UPDATE health.vital_review SET resolved_at = coalesce(resolved_at, ${iso(now)}::timestamptz),
        resolved_by = coalesce(resolved_by, ${supervisor}), note = coalesce(${(note as string | undefined) ?? null}, note)
      WHERE id = ${id}::uuid RETURNING id`)) as unknown as Rows<{ id: string }>;
    if (!r.rows.length) throw new NotFoundException('İnceleme bulunamadı');
    await this.db.insert(auditLog).values({
      actorKind: 'OPERATOR',
      actorId: supervisor,
      action: 'vitals.review_resolved',
      entityType: 'vital_review',
      entityId: id,
      data: null,
    });
    return (await this.reviews(false)).find((x) => x.id === id);
  }

  private envelope<T>(topic: string, subject: string, payload: T, now: Date): KafkaEnvelope<T> {
    return {
      eventId: uuidv7(),
      type: topic,
      version: 1,
      occurredAt: now.toISOString(),
      countryCode: this.pack.country,
      subjectUserId: subject,
      payload,
    };
  }
}
