import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DB, type Db } from '../../db/client';
import { auditLog, operator, supervisorFlag } from '../../db/schema';
import { falseAlarmOf, loadRulePack, RULES, type RulesProvider, staticRules } from '../event/rules.loader';
import { type FalseAlarmStats, falseAlarmStats } from '../false-alarm/stats';
import { CLAIM_SLA_BY_PRIORITY, CLAIM_SLA_SEC, claimSlaSec, FIRST_CALL_SLA_SEC } from './sla';

type Rows<T> = { rows: T[] };

export const OPERATOR_STATUSES = ['AVAILABLE', 'BREAK', 'OFFLINE'] as const;
export type OperatorStatus = (typeof OPERATOR_STATUSES)[number];

/** "Görüldü" bu süreden yeniyse operatör bağlı sayılır (WS ping 30 sn). */
export const ONLINE_WINDOW_SEC = 90;
const BREACH_LIMIT = 50;

export interface QueueDepthPoint {
  /** Saat başı (UTC ISO); derinlik bu saatin sonundaki (son saatte şimdiki) bekleyen olay sayısı. */
  at: string;
  depth: number;
  /** Bu saatte kuyruğa giren olay sayısı (tekrar girişler dahil). */
  entered: number;
}

export interface OperatorCard {
  subject: string;
  name: string | null;
  status: OperatorStatus;
  online: boolean;
  lastSeenAt: string | null;
  open: { eventId: string; type: string; priority: number; state: string; since: string }[];
  claims24h: number;
  /** Son 24 saatte kuyruktan üstlenmeye ortalama süre (sn). */
  avgClaimSec: number | null;
  closed24h: number;
}

export interface SlaBreach {
  eventId: string;
  type: string;
  priority: number;
  /** CLAIM: kuyruktan üstlenmeye > 10 sn; FIRST_CALL: üstlenmeden ilk aramaya > 20 sn. */
  kind: 'CLAIM' | 'FIRST_CALL';
  /** Hâlâ sürüyor (bekliyor / aranmadı). */
  live: boolean;
  waitedSec: number;
  /** İhlalin başladığı an (kuyruğa giriş / üstlenme). */
  at: string;
  operatorId: string | null;
}

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
  /** T-074: son 24 saat, saatlik. */
  queueDepth24h: QueueDepthPoint[];
  /** T-074: son 24 saatte açılan (test hariç) olaylar, türe göre. */
  byType24h: Record<string, number>;
  operators: OperatorCard[];
  /** Canlılar önce, sonra en yeni; en çok 50. */
  slaBreaches: SlaBreach[];
  sla: { claimSec: number; firstCallSec: number };
  overflow: { enabled: boolean; changedAt: string | null; changedBy: string | null };
  /** İnceleme bulgusu 8: bekleyen gelen SOS aramaları (kuyrukta / çalıyor / yönlendiriliyor). */
  inbound: InboundSummary;
}

export interface InboundCallView {
  id: string;
  status: 'routing' | 'ringing' | 'queued';
  eventId: string | null;
  /** Rehberden eşleşen kişinin görünen adı (numara yok). */
  person: string | null;
  operatorId: string | null;
  waitSec: number;
}
export interface InboundSummary {
  queued: number;
  ringing: number;
  oldestQueuedSec: number | null;
  /** En eski önce, en çok 20. */
  calls: InboundCallView[];
}

const OPERATOR_STATES = sql`('OPERATOR_ASSIGNED', 'CONTACT_CHAIN', 'CONFIRMED_OK', 'CONFIRMED_EMERGENCY', 'DISPATCH')`;
const num = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);
const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);

/**
 * E-11 amir panosu (T-025 özeti + T-074): kuyruk, operatörler, SLA ihlalleri, olay dağılımı, yanlış alarm oranı ve
 * amir eylemleri (operatör durumu, taşma bayrağı). Konsol 5 sn'de bir WS'den alır (QueueGateway).
 */
@Injectable()
export class SupervisorService {
  private readonly rules: RulesProvider;
  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(RULES) rules?: RulesProvider,
  ) {
    this.rules = rules ?? staticRules(loadRulePack());
  }

  private async q<T>(s: ReturnType<typeof sql>) {
    return ((await this.db.execute(s)) as unknown as Rows<T>).rows;
  }

  async dashboard(now = new Date()): Promise<SupervisorDashboard> {
    const nowIso = now.toISOString();
    const since = sql`${nowIso}::timestamptz - interval '24 hours'`;
    const queue = await this.q<{ priority: number; n: number; oldest: Date | string | null }>(sql`
      SELECT priority, count(*)::int AS n, min(coalesce(escalated_at, created_at)) AS oldest
      FROM event.event WHERE state = 'OPERATOR_QUEUE' GROUP BY priority ORDER BY priority`);
    const [work] = await this.q<{ n: number; ops: number }>(sql`
      SELECT count(*)::int AS n, count(DISTINCT operator_id)::int AS ops FROM event.event WHERE state IN ${OPERATOR_STATES}`);
    const outcomes = await this.q<{ outcome: string | null; n: number; tests: number }>(sql`
      SELECT confirmed_outcome AS outcome, count(*)::int AS n, count(*) FILTER (WHERE is_test)::int AS tests
      FROM event.event WHERE closed_at > ${since} GROUP BY 1`);
    const claims = await this.claims(now);
    const ok = claims.map((c) => c.s);
    const fa = falseAlarmOf(this.rules.current());
    const window = await falseAlarmStats(this.db, now, fa.windowDays, fa.reviewAfter);
    const byOutcome = Object.fromEntries(outcomes.map((o) => [o.outcome ?? 'UNKNOWN', o.n]));
    const real = outcomes.reduce((a, o) => a + o.n - o.tests, 0);
    const falseAlarms = outcomes.find((o) => o.outcome === 'FALSE_ALARM');
    const byType = await this.q<{ type: string; n: number }>(sql`
      SELECT type, count(*)::int AS n FROM event.event
      WHERE created_at > ${since} AND created_at <= ${nowIso}::timestamptz AND NOT is_test GROUP BY type ORDER BY type`);
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
          count: ok.length,
          p50Sec: num(percentile(ok, 0.5)),
          p95Sec: num(percentile(ok, 0.95)),
          overSlaCount: ok.filter((s) => s > CLAIM_SLA_SEC).length,
        },
      },
      falseAlarms: window,
      queueDepth24h: await this.depth(now),
      byType24h: Object.fromEntries(byType.map((r) => [r.type, r.n])),
      operators: await this.operators(now, claims),
      slaBreaches: await this.breaches(now, claims),
      sla: { claimSec: CLAIM_SLA_SEC, firstCallSec: FIRST_CALL_SLA_SEC },
      overflow: await this.overflow(),
      inbound: await this.inbound(now),
    };
  }

  /**
   * İnceleme bulgusu 8: henüz bağlanmamış gelen SOS aramaları. Kuyruktaki arama (kimse müsait değil) amire ve
   * operatörlere görünür; arayan numara yoktur (yalnız eşleşen kişi ve olay).
   */
  async inbound(now = new Date()): Promise<InboundSummary> {
    const rows = await this.q<{
      id: string;
      status: InboundCallView['status'];
      event_id: string | null;
      display_name: string | null;
      operator_id: string | null;
      since: Date | string;
    }>(sql`
      SELECT c.id::text AS id, c.status, c.event_id::text AS event_id, p.display_name, c.operator_id,
             coalesce(c.queued_at, c.created_at) AS since
      FROM telephony.inbound_call c
      LEFT JOIN profile.protected_person p ON p.id::text = c.protected_person_id
      WHERE c.status IN ('routing', 'ringing', 'queued')
      ORDER BY coalesce(c.queued_at, c.created_at) ASC
      LIMIT 20`);
    const wait = (d: Date | string) => Math.max(0, Math.round((now.getTime() - new Date(d).getTime()) / 1000));
    const calls = rows.map((r) => ({
      id: r.id,
      status: r.status,
      eventId: r.event_id,
      person: r.display_name,
      operatorId: r.operator_id,
      waitSec: wait(r.since),
    }));
    const queued = calls.filter((c) => c.status === 'queued');
    return {
      queued: queued.length,
      ringing: calls.filter((c) => c.status === 'ringing').length,
      oldestQueuedSec: queued[0]?.waitSec ?? null,
      calls,
    };
  }

  // ---- eylemler ----

  /**
   * WS bağlantısı / ping: personel görüldü (ad tokendan; durum değişmez). Amir (`SUPERVISOR`) kart olarak yalnız
   * olay yürütürse görünür; adı yine de buradan gelir.
   */
  async seen(
    subject: string,
    name?: string | null,
    kind: 'OPERATOR' | 'SUPERVISOR' = 'OPERATOR',
    now = new Date(),
  ): Promise<void> {
    if (!subject) return;
    await this.db
      .insert(operator)
      .values({ subject, displayName: name ?? null, kind, lastSeenAt: now })
      .onConflictDoUpdate({
        target: operator.subject,
        set: { lastSeenAt: now, kind, displayName: sql`coalesce(excluded.display_name, ${operator.displayName})` },
      });
  }

  /** PUT /v1/supervisor/operators/{sub}/status — amir operatör durumunu değiştirir (audit). */
  async setStatus(subject: string, status: unknown, by: string, now = new Date()) {
    if (typeof subject !== 'string' || !subject || subject.length > 200) throw new BadRequestException('Operatör yok');
    if (!OPERATOR_STATUSES.includes(status as OperatorStatus))
      throw new BadRequestException(`status: ${OPERATOR_STATUSES.join(' | ')}`);
    const s = status as OperatorStatus;
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(operator)
        .values({ subject, status: s, statusAt: now, statusBy: by })
        .onConflictDoUpdate({ target: operator.subject, set: { status: s, statusAt: now, statusBy: by } })
        .returning();
      await tx.insert(auditLog).values({
        actorKind: 'OPERATOR',
        actorId: by,
        action: 'operator.status',
        entityType: 'operator',
        entityId: subject,
        data: { status: s },
      });
      return { subject, status: s, statusAt: row!.statusAt.toISOString(), statusBy: by };
    });
  }

  /** PUT /v1/supervisor/overflow — yedek merkeze taşma bayrağı (v1.0'da yalnız işaret; yönlendirme v2.0). */
  async setOverflow(enabled: unknown, by: string, now = new Date()) {
    if (typeof enabled !== 'boolean') throw new BadRequestException('enabled (true/false) gerekli');
    await this.db.transaction(async (tx) => {
      await tx
        .insert(supervisorFlag)
        .values({ key: 'overflow', enabled, changedAt: now, changedBy: by })
        .onConflictDoUpdate({ target: supervisorFlag.key, set: { enabled, changedAt: now, changedBy: by } });
      await tx.insert(auditLog).values({
        actorKind: 'OPERATOR',
        actorId: by,
        action: 'supervisor.overflow',
        entityType: 'flag',
        entityId: 'overflow',
        data: { enabled },
      });
    });
    return this.overflow();
  }

  // ---- iç ----

  /** Son 24 saatte kuyruktan üstlenmeler (test dahil değil): olay, operatör, süre, an. */
  private claims(now: Date) {
    const nowIso = now.toISOString();
    return this.q<{
      event_id: string;
      actor_id: string | null;
      s: number;
      at: Date | string;
      queued_at: Date | string;
    }>(
      sql`
      WITH t AS (
        SELECT event_id, to_state, actor_id, at, lag(to_state) OVER w AS prev, lag(at) OVER w AS prev_at
        FROM event.transition
        WHERE event_id IN (SELECT id FROM event.event WHERE NOT is_test
                             AND (closed_at IS NULL OR closed_at > ${nowIso}::timestamptz - interval '24 hours'))
        WINDOW w AS (PARTITION BY event_id ORDER BY seq)
      )
      SELECT event_id, actor_id, extract(epoch FROM at - prev_at)::float8 AS s, at, prev_at AS queued_at FROM t
      WHERE to_state = 'OPERATOR_ASSIGNED' AND prev = 'OPERATOR_QUEUE'
        AND at > ${nowIso}::timestamptz - interval '24 hours' AND at <= ${nowIso}::timestamptz`,
    ).then((rows) => rows.map((r) => ({ ...r, s: Number(r.s) })));
  }

  /** Saatlik kuyruk derinliği: kuyruk aralıkları (OPERATOR_QUEUE'ya giriş → sonraki geçiş) üzerinden. */
  private async depth(now: Date): Promise<QueueDepthPoint[]> {
    const nowIso = now.toISOString();
    const rows = await this.q<{ hr: Date | string; depth: number; entered: number }>(sql`
      WITH t AS (
        SELECT to_state, at, lead(at) OVER w AS next_at
        FROM event.transition
        WHERE event_id IN (SELECT id FROM event.event WHERE NOT is_test
                             AND (closed_at IS NULL OR closed_at > ${nowIso}::timestamptz - interval '25 hours'))
        WINDOW w AS (PARTITION BY event_id ORDER BY seq)
      ), q AS (
        SELECT at AS s, coalesce(next_at, 'infinity'::timestamptz) AS e FROM t WHERE to_state = 'OPERATOR_QUEUE'
      ), h AS (
        SELECT hr, least(hr + interval '1 hour', ${nowIso}::timestamptz) AS p
        FROM generate_series(date_trunc('hour', ${nowIso}::timestamptz) - interval '23 hours',
                             date_trunc('hour', ${nowIso}::timestamptz), interval '1 hour') AS hr
      )
      SELECT h.hr,
             (SELECT count(*) FROM q WHERE q.s <= h.p AND q.e > h.p)::int AS depth,
             (SELECT count(*) FROM q WHERE q.s >= h.hr AND q.s < h.p)::int AS entered
      FROM h ORDER BY h.hr`);
    return rows.map((r) => ({ at: new Date(r.hr).toISOString(), depth: r.depth, entered: r.entered }));
  }

  private async operators(now: Date, claims: { actor_id: string | null; s: number }[]): Promise<OperatorCard[]> {
    const nowIso = now.toISOString();
    const known = await this.db.select().from(operator);
    const open = await this.q<{
      id: string;
      operator_id: string;
      type: string;
      priority: number;
      state: string;
      since: Date | string | null;
    }>(sql`
      SELECT e.id, e.operator_id, e.type, e.priority, e.state,
             (SELECT max(at) FROM event.transition t WHERE t.event_id = e.id AND t.to_state = 'OPERATOR_ASSIGNED') AS since
      FROM event.event e WHERE e.state IN ${OPERATOR_STATES} AND e.operator_id IS NOT NULL
      ORDER BY e.priority, e.created_at`);
    const closed = await this.q<{ actor_id: string; n: number }>(sql`
      SELECT actor_id, count(*)::int AS n FROM event.transition
      WHERE to_state = 'CLOSED' AND actor_kind = 'OPERATOR' AND actor_id IS NOT NULL
        AND at > ${nowIso}::timestamptz - interval '24 hours' AND at <= ${nowIso}::timestamptz
      GROUP BY actor_id`);
    const subjects = new Set<string>([
      ...known.filter((k) => k.kind === 'OPERATOR').map((k) => k.subject),
      ...open.map((o) => o.operator_id),
      ...claims.map((c) => c.actor_id).filter((x): x is string => !!x),
    ]);
    const cards = [...subjects].map((subject): OperatorCard => {
      const k = known.find((x) => x.subject === subject);
      const mine = claims.filter((c) => c.actor_id === subject);
      const lastSeen = k?.lastSeenAt ?? null;
      return {
        subject,
        name: k?.displayName ?? null,
        status: (k?.status as OperatorStatus | undefined) ?? 'AVAILABLE',
        online: !!lastSeen && now.getTime() - lastSeen.getTime() <= ONLINE_WINDOW_SEC * 1000,
        lastSeenAt: iso(lastSeen),
        open: open
          .filter((o) => o.operator_id === subject)
          .map((o) => ({
            eventId: o.id,
            type: o.type,
            priority: o.priority,
            state: o.state,
            since: iso(o.since) ?? nowIso,
          })),
        claims24h: mine.length,
        avgClaimSec: mine.length ? num(mine.reduce((a, c) => a + c.s, 0) / mine.length) : null,
        closed24h: closed.find((c) => c.actor_id === subject)?.n ?? 0,
      };
    });
    return cards.sort(
      (a, b) =>
        Number(b.online) - Number(a.online) ||
        (a.name ?? a.subject).localeCompare(b.name ?? b.subject, 'tr') ||
        a.subject.localeCompare(b.subject),
    );
  }

  private async breaches(
    now: Date,
    claims: { event_id: string; actor_id: string | null; s: number; at: Date | string; queued_at: Date | string }[],
  ): Promise<SlaBreach[]> {
    const nowIso = now.toISOString();
    const sec = (from: Date | string, to: Date | string = now) =>
      Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000);
    const out: SlaBreach[] = [];
    const meta = new Map<string, { type: string; priority: number }>();
    const waiting = await this.q<{ id: string; type: string; priority: number; since: Date | string }>(sql`
      SELECT id, type, priority, coalesce(escalated_at, created_at) AS since FROM event.event
      WHERE state = 'OPERATOR_QUEUE' AND NOT is_test
        AND coalesce(escalated_at, created_at) < ${nowIso}::timestamptz - make_interval(secs => ${sql.raw(
          `CASE priority WHEN 1 THEN ${CLAIM_SLA_BY_PRIORITY[1]} WHEN 2 THEN ${CLAIM_SLA_BY_PRIORITY[2]} WHEN 3 THEN ${CLAIM_SLA_BY_PRIORITY[3]} ELSE ${CLAIM_SLA_BY_PRIORITY[4]} END`,
        )})`);
    for (const w of waiting)
      out.push({
        eventId: w.id,
        type: w.type,
        priority: w.priority,
        kind: 'CLAIM',
        live: true,
        waitedSec: sec(w.since),
        at: iso(w.since)!,
        operatorId: null,
      });
    // İlk arama: olay başına ilk üstlenme → ilk adım araması (chain_step.called_at).
    const calls = await this.q<{
      id: string;
      type: string;
      priority: number;
      state: string;
      operator_id: string | null;
      claimed_at: Date | string;
      claimed_by: string | null;
      called_at: Date | string | null;
    }>(sql`
      WITH c AS (
        SELECT DISTINCT ON (event_id) event_id, at AS claimed_at, actor_id AS claimed_by
        FROM event.transition WHERE to_state = 'OPERATOR_ASSIGNED' AND at <= ${nowIso}::timestamptz
        ORDER BY event_id, seq
      )
      SELECT e.id, e.type, e.priority, e.state, e.operator_id, c.claimed_at, c.claimed_by,
             (SELECT min(s.called_at) FROM chain.chain_run r JOIN chain.chain_step s ON s.run_id = r.id
              WHERE r.event_id = e.id) AS called_at
      FROM c JOIN event.event e ON e.id = c.event_id
      WHERE NOT e.is_test AND c.claimed_at > ${nowIso}::timestamptz - interval '24 hours'`);
    for (const c of calls) {
      const live = !c.called_at && c.state === 'OPERATOR_ASSIGNED';
      if (!c.called_at && !live) continue; // aramasız kapandı/geri alındı: ölçülemez
      const waited = sec(c.claimed_at, c.called_at ?? now);
      if (waited <= FIRST_CALL_SLA_SEC) continue;
      out.push({
        eventId: c.id,
        type: c.type,
        priority: c.priority,
        kind: 'FIRST_CALL',
        live,
        waitedSec: waited,
        at: iso(c.claimed_at)!,
        operatorId: (live ? c.operator_id : c.claimed_by) ?? c.claimed_by,
      });
    }
    const late = claims.filter((c) => c.s > CLAIM_SLA_SEC);
    if (late.length) {
      const ids = [...new Set(late.map((c) => c.event_id))];
      const rows = await this.q<{ id: string; type: string; priority: number }>(sql`
        SELECT id, type, priority FROM event.event WHERE id IN (${sql.join(
          ids.map((i) => sql`${i}::uuid`),
          sql`, `,
        )})`);
      for (const r of rows) meta.set(r.id, { type: r.type, priority: r.priority });
      for (const c of late) {
        const m = meta.get(c.event_id);
        if (!m || c.s <= claimSlaSec(m.priority)) continue; // öncelik bazlı hedef (gece karar 2)
        out.push({
          eventId: c.event_id,
          ...m,
          kind: 'CLAIM',
          live: false,
          waitedSec: Math.round(c.s),
          at: iso(c.queued_at)!,
          operatorId: c.actor_id,
        });
      }
    }
    return out
      .sort((a, b) => Number(b.live) - Number(a.live) || b.at.localeCompare(a.at) || a.kind.localeCompare(b.kind))
      .slice(0, BREACH_LIMIT);
  }

  private async overflow(): Promise<SupervisorDashboard['overflow']> {
    const [f] = await this.q<{ enabled: boolean; changed_at: Date | string; changed_by: string | null }>(
      sql`SELECT enabled, changed_at, changed_by FROM event.supervisor_flag WHERE key = 'overflow'`,
    );
    return f
      ? { enabled: f.enabled, changedAt: iso(f.changed_at), changedBy: f.changed_by }
      : { enabled: false, changedAt: null, changedBy: null };
  }
}

/** Sıralı olmayan dizide doğrusal ara değerli yüzdelik (percentile_cont ile aynı). */
function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}
