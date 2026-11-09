import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';

import { safeError } from '../../common/safe-error';
import { DB, type Db } from '../../db/client';
import { dailySummary, protectedPerson } from '../../db/schema';
import { NotifyService } from '../notify/notify.service';
import {
  type DailySummary,
  localDayBounds,
  localParts,
  previousDay,
  type SignalPoint,
  summarize,
} from './daily-summary';

export const DAILY_ENV = Symbol('DAILY_ENV');

/** Gece işi saati (yerel): dünün özeti. */
const NIGHTLY_AT_MIN = 30; // 00:30
/** F-DAILY penceresi (yerel): 20:00–22:00 (gece penceresine taşmasın). */
const DAILY_FROM_MIN = 20 * 60;
const DAILY_UNTIL_MIN = 22 * 60;
/** Türkçe ondalık virgül: 1,5 saat. */
const HOURS = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 });
const COUNT = new Intl.NumberFormat('tr-TR');

export interface SummaryView {
  day: string;
  steps: number | null;
  hrMin: number | null;
  hrAvg: number | null;
  hrMax: number | null;
  wristMinutes: number;
  restStart: string | null;
  restEnd: string | null;
  partial: boolean;
}

/**
 * T-062 (C-07, B-10) günlük özet. Tarama (varsayılan 5 dk) her kişi için kendi saat diliminde:
 *  - 00:30'dan sonra dünün özeti yoksa hesaplanır → `signal.daily_summary` (yeniden hesap aynı satırı yazar)
 *  - 20:00–22:00 arası, bildirim açıksa ve gün "iyi" geçtiyse (acil sonuçlu veya açık olay yok) F-DAILY (gün başına
 *    bir kez; notify tekrarı ayıklar). Değerler bildirim satırında yalnız sayı olarak.
 * Çok örnekte güvenli: yazımlar upsert, bildirim dedupe anahtarlı.
 */
@Injectable()
export class DailySummaryService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('DailySummary');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(NotifyService) private readonly notify?: Pick<NotifyService, 'plan'>,
    @Optional() @Inject(DAILY_ENV) private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  onModuleInit() {
    const every = Number(this.env.DAILY_SWEEP_MS ?? 300_000);
    if (every <= 0) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.sweep()
        .catch((e) => this.log.warn(`Günlük özet taraması: ${safeError(e)}`))
        .finally(() => (this.running = false));
    }, every);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Tek tur. Dönüş: hesaplanan özet ve planlanan bildirim sayısı. */
  async sweep(now = new Date()): Promise<{ summaries: number; notices: number }> {
    let summaries = 0;
    let notices = 0;
    const people = await this.db
      .select({ id: protectedPerson.id, tz: protectedPerson.timezone, enabled: protectedPerson.dailySummaryEnabled })
      .from(protectedPerson);
    for (const p of people) {
      try {
        const local = localParts(now, p.tz);
        if (local.minutes >= NIGHTLY_AT_MIN) {
          const y = previousDay(local.day);
          if (!(await this.stored(p.id, y))) {
            await this.compute(p.id, p.tz, y);
            summaries++;
          }
        }
        if (p.enabled && local.minutes >= DAILY_FROM_MIN && local.minutes < DAILY_UNTIL_MIN && this.notify) {
          const { start } = localDayBounds(local.day, p.tz);
          if (!(await this.goodDay(p.id, start, now))) continue;
          const s = await this.compute(p.id, p.tz, local.day, now, false);
          if (s.steps === null && s.wristMinutes === 0) continue; // veri yok: "iyi" demeyelim
          notices += await this.notify.plan(
            {
              code: 'F-DAILY',
              audience: 'FAMILY',
              protectedPersonId: p.id,
              dedupeKey: `daily:${p.id}:${local.day}`,
              vars: { steps: COUNT.format(s.steps ?? 0), wristHours: HOURS.format(s.wristMinutes / 60) },
            },
            now,
          );
        }
      } catch (e) {
        this.log.warn(`Günlük özet: ${safeError(e)}`); // kimlik/veri yazılmaz
      }
    }
    return { summaries, notices };
  }

  /** Yerel gün özeti; `store` ise kaydeder (gece işi). Bugün için `upTo` = şimdi (kısmi). */
  async compute(personId: string, tz: string, day: string, upTo?: Date, store = true): Promise<DailySummary> {
    const { start, end } = localDayBounds(day, tz);
    const until = upTo && upTo < end ? upTo : end;
    const r = (await this.db.execute(sql`
      SELECT time, device_id, kind, value,
             (payload->'payload'->>'steps')::float AS steps,
             (payload->'payload'->>'hrAvg')::float AS hr_avg,
             (payload->'device'->>'onWrist')::boolean AS on_wrist
      FROM signal.signal
      WHERE protected_person_id = ${personId} AND time >= ${start} AND time < ${until}
        AND kind IN ('STEPS', 'HEART_RATE', 'HEARTBEAT', 'ON_BODY', 'OFF_BODY', 'BATTERY', 'LOCATION')`)) as unknown as {
      rows: {
        time: Date | string;
        device_id: string;
        kind: string;
        value: number | null;
        steps: number | null;
        hr_avg: number | null;
        on_wrist: boolean | null;
      }[];
    };
    const points: SignalPoint[] = r.rows.map((x) => ({
      time: new Date(x.time),
      deviceId: x.device_id,
      kind: x.kind,
      value: x.value,
      ...(x.steps != null ? { steps: x.steps } : {}),
      ...(x.hr_avg != null ? { hrAvg: x.hr_avg } : {}),
      ...(x.on_wrist != null ? { onWrist: x.on_wrist } : {}),
    }));
    const s = summarize(points, start, until);
    if (store) {
      const values = { ...s, computedAt: new Date() };
      await this.db
        .insert(dailySummary)
        .values({ protectedPersonId: personId, day, ...values })
        .onConflictDoUpdate({ target: [dailySummary.protectedPersonId, dailySummary.day], set: values });
    }
    return s;
  }

  /** Son `days` gün (bugün kısmi, canlı hesap). Aile ekranı ve telefon ana ekranı. */
  async recent(personId: string, days: number, now = new Date()): Promise<SummaryView[]> {
    if (!Number.isInteger(days) || days < 1 || days > 31) throw new BadRequestException('days 1–31');
    const [p] = await this.db
      .select({ tz: protectedPerson.timezone })
      .from(protectedPerson)
      .where(eq(protectedPerson.id, personId));
    const tz = p?.tz ?? 'Europe/Istanbul';
    const today = localParts(now, tz).day;
    const out: SummaryView[] = [this.view(today, await this.compute(personId, tz, today, now, false), true)];
    if (days > 1) {
      const rows = await this.db
        .select()
        .from(dailySummary)
        .where(and(eq(dailySummary.protectedPersonId, personId), sql`${dailySummary.day} < ${today}`))
        .orderBy(desc(dailySummary.day))
        .limit(days - 1);
      for (const r of rows) out.push(this.view(String(r.day).slice(0, 10), r, false));
    }
    return out;
  }

  private view(day: string, s: DailySummary, partial: boolean): SummaryView {
    return {
      day,
      steps: s.steps,
      hrMin: s.hrMin,
      hrAvg: s.hrAvg,
      hrMax: s.hrMax,
      wristMinutes: s.wristMinutes,
      restStart: s.restStart ? new Date(s.restStart).toISOString() : null,
      restEnd: s.restEnd ? new Date(s.restEnd).toISOString() : null,
      partial,
    };
  }

  private async stored(personId: string, day: string) {
    const [r] = await this.db
      .select({ d: dailySummary.day })
      .from(dailySummary)
      .where(and(eq(dailySummary.protectedPersonId, personId), eq(dailySummary.day, day)));
    return !!r;
  }

  /** Bugün acil sonuçlu olay yok ve açık (test dışı) olay yok. */
  private async goodDay(personId: string, dayStart: Date, now: Date) {
    const r = (await this.db.execute(sql`
      SELECT count(*)::int AS n FROM event.event
      WHERE protected_person_id = ${personId} AND NOT is_test AND created_at >= ${dayStart} AND created_at < ${now}
        AND (state <> 'CLOSED' OR confirmed_outcome = 'EMERGENCY')`)) as unknown as { rows: { n: number }[] };
    return (r.rows[0]?.n ?? 0) === 0;
  }
}
