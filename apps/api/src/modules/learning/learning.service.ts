import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { type KafkaEnvelope, type NotifyRequest, TOPICS } from '@yanimda/contracts';
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { OutboxBus } from '../../common/outbox';
import { safeError } from '../../common/safe-error';
import { DB, type Db, type Tx } from '../../db/client';
import { auditLog, signal, threshold } from '../../db/schema';
import { inactivityThreshold } from '../event/decide';
import { type ActivitySample, learnThresholds } from '../event/learning';
import { DEFAULT_SLEEP_WINDOW, DEFAULT_TIMEZONE } from '../event/night';
import {
  learningOf,
  loadRulePack,
  ruleFor,
  type RulePack,
  RULES,
  type RulesProvider,
  staticRules,
} from '../event/rules.loader';
import type { Actor } from '../profile/contacts';
import { ProfileService } from '../profile/profile.service';

export type ThresholdSource = 'DEFAULT' | 'LEARNED' | 'FAMILY';
export interface LearningSummary {
  protectedPersonId: string;
  learningMode: { active: boolean; until: string | null };
  sleepWindow: { timezone: string; start: string; end: string; source: ThresholdSource };
  inactivity: {
    minutes: number | null;
    source: ThresholdSource;
    default: number | null;
    min: number | null;
    max: number | null;
  };
  learnedAt: string | null;
  learnedDays: number | null;
  reportSentAt: string | null;
  /** T-061 (C-09): düşme sorusu cevap süresi (sn, 30–90); null → kural paketi (`fallPromptDefault`). */
  fallPromptSec: number | null;
  fallPromptDefault: number | null;
}

/** Öğrenmenin baktığı sinyaller (hareket ve "veri var" günleri). */
const KINDS = ['STEPS', 'ON_BODY', 'OFF_BODY', 'HEARTBEAT', 'HEART_RATE'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Aile uyku penceresinin en uzun süresi (dk). */
export const MAX_SLEEP_WINDOW_MIN = 12 * 60;
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
/** SS:DD → SS:DD pencere süresi (gece yarısını aşabilir). */
export const windowMinutes = (start: string, end: string) => (minutesOf(end) - minutesOf(start) + 1440) % 1440;
/** T-061 (C-09): düşme sorusu cevap süresi sınırları (sn). Migration 0015'teki CHECK ile aynı. */
const FALL_PROMPT_MIN = 30;
const FALL_PROMPT_MAX = 90;
/** Günlük iş: aynı kişiyi bu süreden sık öğrenme (tarama saatlik çalışır). */
const RELEARN_AFTER_MS = 20 * 3600_000;
const DAY_MS = 86_400_000;

type Rows<T> = { rows: T[] };
interface DueRow {
  id: string;
  timezone: string;
  until: Date | string;
  learned_at: Date | string | null;
}

/**
 * T-070 (D-06) öğrenme modu. Kişi oluşturulunca `learning_mode_until = +learning.days` (ProfileService).
 *  - Günlük iş (`runDue`, saatlik tarama): öğrenme modundaki her kişi için son `historyDays` günün sinyallerinden
 *    uyku penceresi + hareketsizlik eşiği öğrenilir ve event.threshold'a yazılır. Aile elle değiştirdiyse (kaynak
 *    FAMILY) o alana dokunulmaz.
 *  - Dönem bitince (until ≤ şimdi) son bir kez öğrenilir ve aileye bir kez "profil raporu" (F-LEARN-REPORT) gider.
 *  - Aile: GET özet, PUT eşikler (aile ayarı; null → varsayılana/öğrenmeye geri döner).
 * Sağlık verisi okunmaz; log'da kişi kimliği dışında bilgi yok.
 */
@Injectable()
export class LearningService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Learning');
  private readonly rules: RulesProvider;
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OutboxBus) private readonly outbox: OutboxBus,
    @Optional() @Inject(ProfileService) private readonly profile?: Pick<ProfileService, 'authorize' | 'authorizeOwner'>,
    @Optional() @Inject(RULES) rules?: RulesProvider,
  ) {
    this.rules = rules ?? staticRules(loadRulePack());
  }

  private get pack(): RulePack {
    return this.rules.current();
  }

  onApplicationBootstrap() {
    const every = Number(process.env.LEARNING_SWEEP_MS ?? 3600_000);
    if (every > 0) {
      const tick = () =>
        this.runDue()
          .catch((e) => this.log.error(`Öğrenme taraması başarısız: ${safeError(e)}`))
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
  }

  /** Günlük iş: öğrenme modundaki ve raporu gitmemiş kişiler. Öğrenilen / rapor gönderilen sayısı. */
  async runDue(now = new Date()): Promise<{ learned: number; reported: number }> {
    const r = (await this.db.execute(sql`
      SELECT p.id::text AS id, p.timezone, p.learning_mode_until AS until, t.learned_at
      FROM profile.protected_person p
      LEFT JOIN event.threshold t ON t.protected_person_id = p.id::text
      WHERE p.learning_mode_until IS NOT NULL AND t.report_sent_at IS NULL`)) as unknown as Rows<DueRow>;
    let learned = 0;
    let reported = 0;
    for (const p of r.rows) {
      try {
        const ended = new Date(p.until) <= now;
        const stale = !p.learned_at || now.getTime() - new Date(p.learned_at).getTime() >= RELEARN_AFTER_MS;
        if (stale || ended) {
          await this.learn(p.id, now, p.timezone);
          learned++;
        }
        if (ended && (await this.report(p.id, now))) reported++;
      } catch (e) {
        this.log.warn(`Öğrenme başarısız (kişi=${p.id}): ${safeError(e)}`);
      }
    }
    if (learned || reported) this.log.log(`Öğrenme: ${learned} kişi güncellendi, ${reported} rapor`);
    return { learned, reported };
  }

  /** Bir kişi için son `historyDays` günden öğren ve yaz (aile ayarlarına dokunmadan). */
  async learn(protectedPersonId: string, now = new Date(), timezone = DEFAULT_TIMEZONE) {
    const pack = this.pack;
    const lp = learningOf(pack);
    const t = ruleFor(pack, 'INACTIVITY')?.thresholdMin;
    const rows = await this.db
      .select({ at: signal.time, kind: signal.kind, value: signal.value })
      .from(signal)
      .where(
        and(
          eq(signal.protectedPersonId, protectedPersonId),
          inArray(signal.kind, KINDS),
          gte(signal.time, new Date(now.getTime() - lp.historyDays * DAY_MS)),
          lte(signal.time, now),
        ),
      );
    const learned = learnThresholds(rows as ActivitySample[], {
      timezone,
      now,
      historyDays: lp.historyDays,
      minDays: lp.minDays,
      percentile: lp.inactivityPercentile,
      min: t?.min ?? 15,
      max: t?.max ?? 90,
    });
    const learnInactivity = !!t?.learnable;
    await this.db.transaction(async (tx) => {
      const row = await this.lockRow(tx, protectedPersonId);
      const set: Partial<typeof threshold.$inferInsert> = { learnedAt: now, learnedDays: learned.days, updatedAt: now };
      if (
        learned.sleep &&
        row.sleepSource !== 'FAMILY' &&
        windowMinutes(learned.sleep.start, learned.sleep.end) <= MAX_SLEEP_WINDOW_MIN
      )
        Object.assign(set, { sleepStart: learned.sleep.start, sleepEnd: learned.sleep.end, sleepSource: 'LEARNED' });
      if (learnInactivity && learned.inactivityMin !== null && row.inactivitySource !== 'FAMILY')
        Object.assign(set, { inactivityMin: learned.inactivityMin, inactivitySource: 'LEARNED' });
      await tx.update(threshold).set(set).where(eq(threshold.protectedPersonId, protectedPersonId));
      await this.audit(tx, { kind: 'SYSTEM' }, 'learning.thresholds_learned', protectedPersonId, {
        days: learned.days,
        sleep: learned.sleep,
        inactivityMin: learned.inactivityMin,
        familyKept: { sleep: row.sleepSource === 'FAMILY', inactivity: row.inactivitySource === 'FAMILY' },
      });
    });
    return learned;
  }

  /** Dönem sonu "profil raporu" (bir kez). Gönderildiyse true. */
  async report(protectedPersonId: string, now = new Date()): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const row = await this.lockRow(tx, protectedPersonId);
      if (row.reportSentAt) return false;
      await tx
        .update(threshold)
        .set({ reportSentAt: now, updatedAt: now })
        .where(eq(threshold.protectedPersonId, protectedPersonId));
      const payload: NotifyRequest = {
        code: 'F-LEARN-REPORT',
        audience: 'FAMILY',
        protectedPersonId,
        dedupeKey: `learning-report:${protectedPersonId}`,
        vars: {
          sleepStart: row.sleepStart.slice(0, 5),
          sleepEnd: row.sleepEnd.slice(0, 5),
          inactivityMin: inactivityThreshold(this.pack, row.inactivityMin) ?? '-',
        },
      };
      const env: KafkaEnvelope<NotifyRequest> = {
        eventId: uuidv7(),
        type: TOPICS.notifyRequested,
        version: 1,
        occurredAt: now.toISOString(),
        countryCode: this.pack.country,
        subjectUserId: protectedPersonId,
        payload,
      };
      await this.outbox.publish(TOPICS.notifyRequested, env, tx);
      await this.audit(tx, { kind: 'SYSTEM' }, 'learning.report_sent', protectedPersonId, {});
      return true;
    });
  }

  // ---- aile uçları ----

  /** GET /v1/protected-persons/{id}/learning */
  async summary(actor: Actor, id: string, now = new Date()): Promise<LearningSummary> {
    await this.authorize(actor, id);
    const r = (await this.db.execute(sql`
      SELECT p.timezone, p.learning_mode_until AS until, t.*
      FROM profile.protected_person p
      LEFT JOIN event.threshold t ON t.protected_person_id = p.id::text
      WHERE p.id::text = ${id}`)) as unknown as Rows<{
      timezone: string;
      until: Date | string | null;
      sleep_start: string | null;
      sleep_end: string | null;
      sleep_source: ThresholdSource | null;
      inactivity_min: number | null;
      inactivity_source: ThresholdSource | null;
      learned_at: Date | string | null;
      learned_days: number | null;
      report_sent_at: Date | string | null;
      fall_prompt_sec: number | null;
    }>;
    const row = r.rows[0]!;
    const t = ruleFor(this.pack, 'INACTIVITY')?.thresholdMin;
    const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
    return {
      protectedPersonId: id,
      learningMode: { active: !!row.until && new Date(row.until) > now, until: iso(row.until) },
      sleepWindow: {
        timezone: row.timezone,
        start: row.sleep_start?.slice(0, 5) ?? DEFAULT_SLEEP_WINDOW.start,
        end: row.sleep_end?.slice(0, 5) ?? DEFAULT_SLEEP_WINDOW.end,
        source: row.sleep_source ?? 'DEFAULT',
      },
      inactivity: {
        minutes: inactivityThreshold(this.pack, row.inactivity_min) ?? null,
        source: row.inactivity_source ?? 'DEFAULT',
        default: t?.default ?? null,
        min: t?.min ?? null,
        max: t?.max ?? null,
      },
      learnedAt: iso(row.learned_at),
      learnedDays: row.learned_days,
      reportSentAt: iso(row.report_sent_at),
      fallPromptSec: row.fall_prompt_sec ?? null,
      fallPromptDefault: ruleFor(this.pack, 'FALL')?.devicePrompt?.windowSec ?? null,
    };
  }

  /**
   * PUT /v1/protected-persons/{id}/thresholds — aile ayarı. `sleepWindow: {start, end}` ve/veya `inactivityMin`
   * (kuralın min–max aralığında). Değer verilen alan FAMILY olur ve öğrenme ona dokunmaz; `null` aile ayarını
   * kaldırır (varsayılana döner, öğrenme yeniden yazabilir).
   */
  async setThresholds(actor: Actor, id: string, body: unknown, now = new Date()): Promise<LearningSummary> {
    if (!this.profile) throw new Error('ProfileService yok');
    await this.profile.authorizeOwner(actor, id); // bulgu 10: MEMBER güvenlik eşiklerini değiştiremez

    const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const set: Partial<typeof threshold.$inferInsert> = { updatedAt: now };
    if (b.sleepWindow === null)
      Object.assign(set, { ...this.defaultSleep(), sleepSource: 'DEFAULT' satisfies ThresholdSource });
    else if (b.sleepWindow !== undefined) {
      const w = b.sleepWindow as Record<string, unknown>;
      if (typeof w !== 'object' || typeof w.start !== 'string' || typeof w.end !== 'string')
        throw new BadRequestException('sleepWindow {start, end} gerekli');
      if (!HHMM.test(w.start) || !HHMM.test(w.end) || w.start === w.end)
        throw new BadRequestException('sleepWindow saatleri SS:DD olmalı ve farklı olmalı');
      // Bulgu 10: uyku penceresinde hareketsizlik/bağlantı uyarısı bastırılır; günü kaplayan pencere korumayı kapatır.
      if (windowMinutes(w.start, w.end) > MAX_SLEEP_WINDOW_MIN)
        throw new BadRequestException(`sleepWindow en çok ${MAX_SLEEP_WINDOW_MIN / 60} saat olabilir`);
      Object.assign(set, { sleepStart: w.start, sleepEnd: w.end, sleepSource: 'FAMILY' satisfies ThresholdSource });
    }
    if (b.inactivityMin === null) Object.assign(set, { inactivityMin: null, inactivitySource: 'DEFAULT' });
    else if (b.inactivityMin !== undefined) {
      const t = ruleFor(this.pack, 'INACTIVITY')?.thresholdMin;
      const v = b.inactivityMin;
      const lo = t?.min ?? 1;
      const hi = t?.max ?? 1440;
      if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi)
        throw new BadRequestException(`inactivityMin ${lo}–${hi} dk arası tam sayı olmalı`);
      Object.assign(set, { inactivityMin: v as number, inactivitySource: 'FAMILY' satisfies ThresholdSource });
    }
    if (b.fallPromptSec === null) set.fallPromptSec = null;
    else if (b.fallPromptSec !== undefined) {
      const v = b.fallPromptSec;
      if (!Number.isInteger(v) || (v as number) < FALL_PROMPT_MIN || (v as number) > FALL_PROMPT_MAX)
        throw new BadRequestException(`fallPromptSec ${FALL_PROMPT_MIN}–${FALL_PROMPT_MAX} sn arası tam sayı olmalı`);
      set.fallPromptSec = v as number;
    }
    if (Object.keys(set).length === 1)
      throw new BadRequestException('sleepWindow, inactivityMin veya fallPromptSec gerekli');
    await this.db.transaction(async (tx) => {
      await this.lockRow(tx, id);
      await tx.update(threshold).set(set).where(eq(threshold.protectedPersonId, id));
      const { updatedAt: _u, ...changed } = set;
      await this.audit(tx, actor, 'learning.thresholds_set', id, changed);
    });
    return this.summary(actor, id, now);
  }

  // ---- iç ----

  private defaultSleep() {
    return { sleepStart: DEFAULT_SLEEP_WINDOW.start, sleepEnd: DEFAULT_SLEEP_WINDOW.end };
  }

  private async authorize(actor: Actor, id: string) {
    if (!this.profile) throw new Error('ProfileService yok');
    await this.profile.authorize(actor, id);
  }

  /** Eşik satırını (yoksa varsayılanlarla oluşturup) kilitler. */
  private async lockRow(tx: Tx, protectedPersonId: string) {
    await tx.insert(threshold).values({ protectedPersonId }).onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(threshold)
      .where(eq(threshold.protectedPersonId, protectedPersonId))
      .for('update');
    return row!;
  }

  private async audit(tx: Tx, actor: Actor | { kind: 'SYSTEM' }, action: string, id: string, data: unknown) {
    await tx.insert(auditLog).values({
      actorKind: actor.kind,
      actorId: 'id' in actor ? (actor.id ?? null) : null,
      action,
      entityType: 'protected_person',
      entityId: id,
      data,
    });
  }
}
