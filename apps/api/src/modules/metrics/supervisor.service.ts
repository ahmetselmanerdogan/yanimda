import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DB, type Db } from '../../db/client';
import { falseAlarmOf, loadRulePack, RULES, type RulesProvider, staticRules } from '../event/rules.loader';
import { type FalseAlarmStats, falseAlarmStats } from '../false-alarm/stats';
import { CLAIM_SLA_SEC } from './sla';

type Rows<T> = { rows: T[] };

export interface SupervisorDashboard {
  at: string;
  queue: { priority: number; waiting: number; oldestWaitSec: number | null }[];
  inProgress: number;
  activeOperators: number;
  last24h: {
    closed: number;
    byOutcome: Record<string, number>;
    falseAlarmRatio: number;
    claim: { count: number; p50Sec: number | null; p95Sec: number | null; overSlaCount: number };
  };
  /** T-071 (D-07): kural paketi penceresinde (30 gün) yanlış alarm oranı, nedenler, eşiği aşan kişi sayısı. */
  falseAlarms: FalseAlarmStats;
}

const OPERATOR_STATES = sql`('OPERATOR_ASSIGNED', 'CONTACT_CHAIN', 'CONFIRMED_OK', 'CONFIRMED_EMERGENCY', 'DISPATCH')`;
const num = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);

/** E-11 / T-025 amir panosu özeti: kuyruk, aktif operatör, son 24 saat sonuçları ve üstlenme SLA'sı. */
@Injectable()
export class SupervisorService {
  private readonly rules: RulesProvider;
  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(RULES) rules?: RulesProvider,
  ) {
    this.rules = rules ?? staticRules(loadRulePack());
  }

  async dashboard(now = new Date()): Promise<SupervisorDashboard> {
    const q = async <T>(s: ReturnType<typeof sql>) => ((await this.db.execute(s)) as unknown as Rows<T>).rows;
    const nowIso = now.toISOString();
    const queue = await q<{ priority: number; n: number; oldest: Date | string | null }>(sql`
      SELECT priority, count(*)::int AS n, min(coalesce(escalated_at, created_at)) AS oldest
      FROM event.event WHERE state = 'OPERATOR_QUEUE' GROUP BY priority ORDER BY priority`);
    const [work] = await q<{ n: number; ops: number }>(sql`
      SELECT count(*)::int AS n, count(DISTINCT operator_id)::int AS ops FROM event.event WHERE state IN ${OPERATOR_STATES}`);
    const outcomes = await q<{ outcome: string | null; n: number; tests: number }>(sql`
      SELECT confirmed_outcome AS outcome, count(*)::int AS n, count(*) FILTER (WHERE is_test)::int AS tests
      FROM event.event WHERE closed_at > ${nowIso}::timestamptz - interval '24 hours' GROUP BY 1`);
    const [claim] = await q<{ n: number; p50: number | null; p95: number | null; over: number }>(sql`
      WITH t AS (
        SELECT to_state, at, lag(to_state) OVER w AS prev, lag(at) OVER w AS prev_at
        FROM event.transition WINDOW w AS (PARTITION BY event_id ORDER BY seq)
      ), c AS (
        SELECT extract(epoch FROM at - prev_at)::float8 AS s FROM t
        WHERE to_state = 'OPERATOR_ASSIGNED' AND prev = 'OPERATOR_QUEUE' AND at > ${nowIso}::timestamptz - interval '24 hours'
      )
      SELECT count(*)::int AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY s) AS p50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY s) AS p95, count(*) FILTER (WHERE s > ${CLAIM_SLA_SEC})::int AS over
      FROM c`);
    const fa = falseAlarmOf(this.rules.current());
    const window = await falseAlarmStats(this.db, now, fa.windowDays, fa.reviewAfter);
    const byOutcome = Object.fromEntries(outcomes.map((o) => [o.outcome ?? 'UNKNOWN', o.n]));
    const real = outcomes.reduce((a, o) => a + o.n - o.tests, 0);
    const falseAlarms = outcomes.find((o) => o.outcome === 'FALSE_ALARM');
    return {
      at: nowIso,
      queue: queue.map((r) => ({
        priority: r.priority,
        waiting: r.n,
        oldestWaitSec: r.oldest ? Math.round((now.getTime() - new Date(r.oldest).getTime()) / 1000) : null,
      })),
      inProgress: work?.n ?? 0,
      activeOperators: work?.ops ?? 0,
      last24h: {
        closed: outcomes.reduce((a, o) => a + o.n, 0),
        byOutcome,
        falseAlarmRatio: real ? (falseAlarms ? falseAlarms.n - falseAlarms.tests : 0) / real : 0,
        claim: {
          count: claim?.n ?? 0,
          p50Sec: num(claim?.p50),
          p95Sec: num(claim?.p95),
          overSlaCount: claim?.over ?? 0,
        },
      },
      falseAlarms: window,
    };
  }
}
