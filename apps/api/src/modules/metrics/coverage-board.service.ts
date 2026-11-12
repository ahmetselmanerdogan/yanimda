import { Inject, Injectable, Optional } from '@nestjs/common';
import type { LadderStepStat, SupervisorCoverageBoard } from '@yanimda/contracts';
import { sql } from 'drizzle-orm';

import { DB, type Db } from '../../db/client';
import { awakeMinutes, onHold, phoneOnline } from '../event/coverage';
import { fleetDaily, fleetPersons } from '../event/coverage.service';
import { summarize } from '../event/coverage-report';
import {
  chronicGapOf,
  coverageNoneOf,
  coverageOf,
  loadRulePack,
  RULES,
  type RulesProvider,
  staticRules,
} from '../event/rules.loader';

type Rows<T> = { rows: T[] };
const iso = (v: Date | string) => new Date(v).toISOString();
/** Ulaşılamadı sayılan adım sonuçları (SILENT: otomatik cevap, ses yok). */
const UNREACHED = sql`('NO_ANSWER', 'BUSY', 'WRONG_NUMBER', 'SILENT')`;
const LIST_LIMIT = 50;

/**
 * T-089 (docs/07 S7.2) amir kapsama panosu: uyanıkken 20 dk+ kapsama YOK olanlar (en uzun önce), kronik boşluk
 * (son 7 günde uyanık zamanın %80'inden azı korunan veya S4.10 işaretli), çevrimdışı telefon köprüleri, merdiven
 * adımı başına ulaşılamama oranı (P1/P2, 7 ve 30 gün), 90 sn üstlenilmeyen P1 ve hareketsizlik / yerinde kontrol 112
 * bildirimleri. "Planlı şarj" görünümü GET /supervisor/coverage'da kalır. Hastanede / seyahatte modundakiler
 * listelerde yok. Kişi yalnız görünen adıyla; sağlık verisi yok.
 */
@Injectable()
export class CoverageBoardService {
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

  async board(now = new Date()): Promise<SupervisorCoverageBoard> {
    const pack = this.rules.current();
    const none = coverageNoneOf(pack);
    const chronicP = chronicGapOf(pack);
    const params = coverageOf(pack);
    const persons = (await fleetPersons(this.db)).filter((p) => !onHold({ holdUntil: p.holdUntil }, now));

    const noneAwake = persons
      .filter((p) => p.level === 'NONE' && p.noneSince)
      .map((p) => ({
        protectedPersonId: p.id,
        name: p.name,
        since: p.noneSince!.toISOString(),
        awakeMin: awakeMinutes(p.noneSince!, now, { ...p.sleep, resumeAfterWakeMin: 0 }),
        reasons: [] as string[],
      }))
      .filter((x) => x.awakeMin >= none.remindMin)
      .sort((a, b) => b.awakeMin - a.awakeMin || a.protectedPersonId.localeCompare(b.protectedPersonId))
      .slice(0, LIST_LIMIT);
    if (noneAwake.length) {
      const reasons = await this.q<{ id: string; reasons: string[] }>(sql`
        SELECT protected_person_id AS id, reasons FROM event.coverage_state
        WHERE protected_person_id IN (${sql.join(
          noneAwake.map((x) => sql`${x.protectedPersonId}`),
          sql`, `,
        )})`);
      for (const x of noneAwake) x.reasons = reasons.find((r) => r.id === x.protectedPersonId)?.reasons ?? [];
    }

    const daily = await fleetDaily(this.db, persons, chronicP.days, now);
    const chronic = persons
      .map((p) => ({ p, s: summarize(daily.get(p.id) ?? []) }))
      .filter(({ p, s }) => !!p.chronicSince || (s.protectedPct !== null && s.protectedPct < chronicP.protectedPct))
      .map(({ p, s }) => ({
        protectedPersonId: p.id,
        name: p.name,
        protectedPct: s.protectedPct,
        chronicSince: p.chronicSince?.toISOString() ?? null,
        toleranceMin: p.toleranceMin,
      }))
      .sort(
        (a, b) =>
          (a.protectedPct ?? 101) - (b.protectedPct ?? 101) || a.protectedPersonId.localeCompare(b.protectedPersonId),
      )
      .slice(0, LIST_LIMIT);

    const offlineBridges = persons
      .map((p) => {
        const bridged = Object.values(p.facts.devices).filter((d) => d.bridged && d.category !== 'PHONE');
        if (!bridged.length || phoneOnline(p.facts, now, params)) return null;
        const seen = [
          p.facts.bridgeSeenAt,
          ...Object.values(p.facts.devices)
            .filter((d) => d.category === 'PHONE')
            .map((d) => d.seenAt),
        ]
          .filter((x): x is string => !!x)
          .sort()
          .pop();
        return { protectedPersonId: p.id, name: p.name, phoneSeenAt: seen ?? null, bridgedDevices: bridged.length };
      })
      .filter((x): x is NonNullable<typeof x> => !!x)
      .sort((a, b) => (a.phoneSeenAt ?? '').localeCompare(b.phoneSeenAt ?? ''))
      .slice(0, LIST_LIMIT);

    const unclaimedP1 = await this.q<{ event_id: string; event_type: string; at: Date | string; acked: boolean }>(sql`
      SELECT event_id, event_type, at, acked_at IS NOT NULL AS acked FROM event.supervisor_alert
      WHERE code = 'O-P1-UNCLAIMED' AND at >= ${now.toISOString()}::timestamptz - interval '7 days'
        AND at <= ${now.toISOString()}::timestamptz
      ORDER BY at DESC LIMIT ${LIST_LIMIT}`);
    const dispatch112 = await this.q<{
      event_id: string;
      type: string;
      notified_at: Date | string;
      status: string;
      name: string | null;
    }>(sql`
      SELECT d.event_id::text AS event_id, e.type, d.notified_at, d.status, p.display_name AS name
      FROM event.dispatch d JOIN event.event e ON e.id = d.event_id
      LEFT JOIN profile.protected_person p ON p.id::text = d.protected_person_id
      WHERE e.type IN ('INACTIVITY', 'WELFARE_CHECK') AND NOT e.is_test
        AND d.notified_at >= ${now.toISOString()}::timestamptz - interval '7 days'
        AND d.notified_at <= ${now.toISOString()}::timestamptz
      ORDER BY d.notified_at DESC LIMIT ${LIST_LIMIT}`);

    return {
      at: now.toISOString(),
      noneAwake,
      chronic,
      offlineBridges,
      unreachable: { days7: await this.unreachable(now, 7), days30: await this.unreachable(now, 30) },
      unclaimedP1: unclaimedP1.map((r) => ({
        eventId: r.event_id,
        eventType: r.event_type,
        at: iso(r.at),
        acked: r.acked,
      })),
      dispatch112: dispatch112.map((r) => ({
        eventId: r.event_id,
        eventType: r.type,
        notifiedAt: iso(r.notified_at),
        status: r.status,
        name: r.name,
      })),
    };
  }

  /**
   * P1/P2 merdivenlerinde (test hariç, son `days` gün) adım türü başına deneme / ulaşılan / ulaşılamayan /
   * çevrimdışı atlanan; `stalledHere`: kimseye ulaşılamayan merdivenin son denenen adımı. Operatörün atladığı (SKIPPED)
   * adım deneme sayılmaz.
   */
  async unreachable(now: Date, days: number): Promise<LadderStepStat[]> {
    const rows = await this.q<{
      step: string;
      attempted: number;
      reached: number;
      unreached: number;
      offline: number;
      stalled: number;
    }>(sql`
      WITH s AS (
        SELECT r.id AS run, st.n, st.kind || coalesce(':' || st.contact_index, '') AS step, st.result
        FROM chain.chain_run r
        JOIN event.event e ON e.id = r.event_id
        JOIN chain.chain_step st ON st.run_id = r.id
        WHERE e.priority <= 2 AND NOT e.is_test AND st.result IS NOT NULL AND st.result <> 'SKIPPED'
          AND r.created_at >= ${now.toISOString()}::timestamptz - make_interval(days => ${days})
          AND r.created_at <= ${now.toISOString()}::timestamptz
      ), reached AS (
        SELECT DISTINCT run FROM s WHERE result = 'REACHED'
      ), stalled AS (
        SELECT DISTINCT ON (run) run, step FROM s WHERE run NOT IN (SELECT run FROM reached) ORDER BY run, n DESC
      )
      SELECT s.step, count(*)::int AS attempted,
             count(*) FILTER (WHERE s.result = 'REACHED')::int AS reached,
             count(*) FILTER (WHERE s.result IN ${UNREACHED})::int AS unreached,
             count(*) FILTER (WHERE s.result = 'OFFLINE_SKIPPED')::int AS offline,
             (SELECT count(*) FROM stalled x WHERE x.step = s.step)::int AS stalled
      FROM s GROUP BY s.step ORDER BY min(s.n), s.step`);
    return rows.map((r) => ({
      step: r.step,
      attempted: r.attempted,
      reached: r.reached,
      unreached: r.unreached,
      offlineSkipped: r.offline,
      unreachableRate: r.attempted ? Math.round(((r.unreached + r.offline) / r.attempted) * 1000) / 1000 : null,
      stalledHere: r.stalled,
    }));
  }
}
