import type { AdminCoverageMetrics } from '@yanimda/contracts';
import { sql } from 'drizzle-orm';

import type { Db } from '../../db/client';
import { fleetDaily, fleetPersons } from '../event/coverage.service';
import { chronicGapOf, type RulePack } from '../event/rules.loader';

type Rows<T> = { rows: T[] };
const num = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);
const share = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 1000 : null);
/** Yanlış alarm oranının paydası: gerçek alarm türleri (cihazın açtığı). */
const ALARMS = sql`('SOS', 'FALL', 'INACTIVITY')`;
/** Kişi-gün korunma yüzdesi dağılımı (alt sınır dahil, üst hariç). */
const BUCKETS: [string, number, number][] = [
  ['<50', 0, 50],
  ['50-80', 50, 80],
  ['80-95', 80, 95],
  ['95+', 95, 101],
];

/**
 * T-085 (docs/07 S7.3) yönetim ölçüleri — yalnız toplamlar, kişi kimliği / adı yok:
 *  - kişi-gün başına uyanık zaman kapsama yüzdesi (ortalama, ortanca, %80 altı payı, dağılım)
 *  - cihaz modeli ve uygulama sürümü başına yanlış alarm oranı (olayı açan ilk cihaz; SOS / düşme / hareketsizlik)
 *  - cihaz sınıfı ve adaptör başına sinyal gecikmesi p50 / p95 (occurredAt → receivedAt)
 *  - şarj uyumu: şarjdan çıkıştan (CHARGE_END) yeniden takılmaya (ON_BODY / onWrist) süre, ilk hatırlatmadan önce
 *    takılanların payı
 *  - 100 kişi-gün başına olay türü (test hariç)
 *  - model başına pil sağlığı: cihaz-gün başına düşüşlerin toplamı (şarj artışları sayılmaz), ortanca
 */
export async function coverageMetrics(db: Db, pack: RulePack, days: number, now: Date): Promise<AdminCoverageMetrics> {
  const q = async <T>(s: ReturnType<typeof sql>) => ((await db.execute(s)) as unknown as Rows<T>).rows;
  const to = now.toISOString();
  const from = new Date(now.getTime() - days * 86_400_000).toISOString();
  const target = chronicGapOf(pack).protectedPct;
  // Takma hatırlatmasının ilk adımı (charging.putOnMin[0]); şarj uyumu bu süreden önce takılanları sayar.
  const putOn = pack.charging?.putOnMin?.[0] ?? 15;

  // Kişi-gün kapsama yüzdesi (ölçülebilen uyanık dakikası olan günler).
  const persons = await fleetPersons(db);
  const daily = await fleetDaily(db, persons, days, now);
  const pcts: number[] = [];
  for (const list of daily.values()) for (const d of list) if (d.protectedPct !== null) pcts.push(d.protectedPct);
  pcts.sort((a, b) => a - b);
  const personDays = pcts.length;
  const median =
    personDays === 0
      ? null
      : personDays % 2
        ? pcts[(personDays - 1) / 2]!
        : (pcts[personDays / 2 - 1]! + pcts[personDays / 2]!) / 2;

  const fa = await q<{ model: string; app: string; n: number; fa: number }>(sql`
    SELECT coalesce(d.model_id, d.kind, 'UNKNOWN') AS model, coalesce(d.app_version, 'UNKNOWN') AS app,
           count(*)::int AS n,
           count(*) FILTER (WHERE e.confirmed_outcome = 'FALSE_ALARM'
                            OR EXISTS (SELECT 1 FROM event.false_alarm f WHERE f.event_id = e.id))::int AS fa
    FROM event.event e
    LEFT JOIN device.device d ON d.id::text = e.source_device_ids[1]
    WHERE NOT e.is_test AND e.type IN ${ALARMS} AND e.state = 'CLOSED'
      AND e.created_at >= ${from}::timestamptz AND e.created_at <= ${to}::timestamptz
    GROUP BY 1, 2 ORDER BY 1, 2`);

  const lat = await q<{ tier: string; adapter: string; n: number; p50: number | null; p95: number | null }>(sql`
    SELECT coalesce(payload->'source'->>'tier', 'A') AS tier, coalesce(payload->'source'->>'kind', 'UNKNOWN') AS adapter,
           count(*)::int AS n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY greatest(0, extract(epoch FROM received_at - time))) AS p50,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY greatest(0, extract(epoch FROM received_at - time))) AS p95
    FROM signal.signal WHERE time >= ${from}::timestamptz AND time <= ${to}::timestamptz
    GROUP BY 1, 2 ORDER BY 1, 2`);

  const [chg] = await q<{ n: number; worn: number; p50: number | null; p90: number | null; early: number }>(sql`
    WITH e AS (
      SELECT c.device_id, c.time AS ended,
             (SELECT min(s.time) FROM signal.signal s
              WHERE s.device_id = c.device_id AND s.time > c.time AND s.time <= c.time + interval '12 hours'
                AND (s.kind = 'ON_BODY' OR (s.payload->'device'->>'onWrist') = 'true')) AS worn
      FROM signal.signal c
      WHERE c.kind = 'CHARGE_END' AND c.time >= ${from}::timestamptz AND c.time <= ${to}::timestamptz
        AND coalesce(c.payload->'source'->>'category', 'WATCH') <> 'PHONE'
    )
    SELECT count(*)::int AS n, count(worn)::int AS worn,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM worn - ended) / 60)
             FILTER (WHERE worn IS NOT NULL) AS p50,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM worn - ended) / 60)
             FILTER (WHERE worn IS NOT NULL) AS p90,
           count(*) FILTER (WHERE worn - ended < make_interval(mins => ${putOn}))::int AS early
    FROM e`);

  const byType = await q<{ type: string; n: number }>(sql`
    SELECT type, count(*)::int AS n FROM event.event
    WHERE NOT is_test AND created_at >= ${from}::timestamptz AND created_at <= ${to}::timestamptz
    GROUP BY type ORDER BY type`);

  const bat = await q<{ model: string; devices: number; device_days: number; med: number | null }>(sql`
    WITH b AS (
      SELECT s.device_id, coalesce(dv.model_id, dv.kind, s.payload->'source'->>'kind', 'UNKNOWN') AS model, s.time,
             coalesce((s.payload->'device'->>'batteryPct')::float8, CASE WHEN s.kind = 'BATTERY' THEN s.value END) AS pct
      FROM signal.signal s
      LEFT JOIN device.device dv ON dv.id::text = s.device_id
      WHERE s.time >= ${from}::timestamptz AND s.time <= ${to}::timestamptz
        AND coalesce(s.payload->'source'->>'category', 'WATCH') <> 'PHONE'
    ), d AS (
      SELECT device_id, model, (time AT TIME ZONE 'UTC')::date AS day,
             pct - lag(pct) OVER (PARTITION BY device_id ORDER BY time) AS delta
      FROM b WHERE pct IS NOT NULL
    ), dd AS (
      SELECT device_id, model, day, coalesce(sum(-delta) FILTER (WHERE delta < 0), 0) AS drain, count(delta) AS pairs
      FROM d GROUP BY 1, 2, 3
    )
    SELECT model, count(DISTINCT device_id)::int AS devices, count(*)::int AS device_days,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY drain) AS med
    FROM dd WHERE pairs > 0 GROUP BY model ORDER BY model`);

  return {
    days,
    from,
    to,
    coverage: {
      personDays,
      avgProtectedPct: personDays ? num(pcts.reduce((a, x) => a + x, 0) / personDays) : null,
      medianProtectedPct: num(median),
      belowTargetShare: share(pcts.filter((x) => x < target).length, personDays),
      buckets: BUCKETS.map(([label, lo, hi]) => ({ label, n: pcts.filter((x) => x >= lo && x < hi).length })),
    },
    falseAlarms: fa.map((r) => ({
      model: r.model,
      appVersion: r.app,
      events: r.n,
      falseAlarms: r.fa,
      rate: share(r.fa, r.n) ?? 0,
    })),
    latency: lat.map((r) => ({
      tier: r.tier,
      adapter: r.adapter,
      signals: r.n,
      p50Sec: num(r.p50),
      p95Sec: num(r.p95),
    })),
    charging: {
      sessions: chg?.n ?? 0,
      worn: chg?.worn ?? 0,
      medianToWearMin: num(chg?.p50),
      p90ToWearMin: num(chg?.p90),
      beforeReminderShare: share(chg?.early ?? 0, chg?.n ?? 0),
    },
    eventsPer100PersonDays: personDays
      ? Object.fromEntries(byType.map((r) => [r.type, Math.round((r.n / personDays) * 1000) / 10]))
      : {},
    battery: bat.map((r) => ({
      model: r.model,
      devices: r.devices,
      deviceDays: r.device_days,
      medianDailyDrainPct: num(r.med),
    })),
  };
}
