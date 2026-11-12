import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { AdminCoverageMetrics } from '@yanimda/contracts';
import { sql } from 'drizzle-orm';

import { DB, type Db } from '../../db/client';
import { auditLog } from '../../db/schema';
import { loadRulePack, RULES, type RulesProvider, staticRules } from '../event/rules.loader';
import type { RecordingStore } from '../telephony/recording-store';
import { RECORDINGS } from '../telephony/telephony.service';
import { coverageMetrics } from './coverage-metrics';

/**
 * Yönetim ve çağrı merkezi paneli (okuma ağırlıklı). Kişisel veri en az: numara yok (rehber rolü ve sırası),
 * kişi yalnız görünen adıyla; ses kaydı yalnız yetkili rolle ve her dinleme audit.log'a yazılır.
 */
type Rows<T> = { rows: T[] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CallRow {
  id: string;
  direction: 'OUT' | 'IN';
  at: string;
  eventId: string | null;
  eventType: string | null;
  person: string | null;
  operatorId: string | null;
  /** Operatörün görünen adı (identity.operator); yoksa null. */
  operatorName: string | null;
  isTest: boolean;
  /** Aranan / arayan: rehber rolü (WATCH, PHONE, CONTACT, NEIGHBOR, 112, DESK) ve sırası; numara yok. */
  party: string;
  stepN: number | null;
  status: string;
  answered: boolean;
  durationSec: number | null;
  result: string | null;
  recording: boolean;
}

export interface Analytics {
  days: number;
  events: { total: number; real: number; byType: Record<string, number>; byOutcome: Record<string, number> };
  sla: {
    claimP50Sec: number | null;
    claimP95Sec: number | null;
    firstCallP50Sec: number | null;
    firstCallP95Sec: number | null;
  };
  calls: {
    total: number;
    answered: number;
    answerRate: number;
    avgTalkSec: number | null;
    byParty: Record<string, { total: number; answered: number }>;
  };
  inbound: { total: number; answered: number; abandoned: number; avgWaitSec: number | null };
  dispatch: {
    total: number;
    arrived: number;
    arrivalP50Min: number | null;
    arrivalP90Min: number | null;
    late: number;
    cancelled: number;
  };
  wellness: { planned: number; done: number; help: number; notified: number; missed: number };
  falseAlarmRatio: number;
  operators: {
    operatorId: string;
    operatorName: string | null;
    claims: number;
    closed: number;
    calls: number;
    answered: number;
    avgClaimSec: number | null;
    avgHandleMin: number | null;
  }[];
  daily: { day: string; events: number; emergencies: number; calls: number }[];
}

@Injectable()
export class AdminService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(RECORDINGS) private readonly recordings?: RecordingStore | null,
    @Optional() @Inject(RULES) rules?: RulesProvider,
  ) {
    this.rules = rules ?? staticRules(loadRulePack());
  }
  private readonly rules: RulesProvider;

  /** GET /v1/admin/coverage-metrics — T-085 (S7.3) kapsama ve cihaz ölçüleri (yalnız toplamlar). */
  coverageMetrics(days = 30, now = new Date()): Promise<AdminCoverageMetrics> {
    return coverageMetrics(this.db, this.rules.current(), days, now);
  }

  private async q<T>(s: ReturnType<typeof sql>) {
    return ((await this.db.execute(s)) as unknown as Rows<T>).rows;
  }

  /** Çağrı kaydı: zincir aramaları (giden) + gelen SOS aramaları; en yeni önce. Kim kimi aradı, cevap, süre. */
  async calls(f: {
    from: Date;
    to: Date;
    operatorId?: string;
    eventId?: string;
    answered?: boolean;
    limit?: number;
  }): Promise<CallRow[]> {
    const limit = Math.min(f.limit ?? 200, 1000);
    const rows = await this.q<{
      id: string;
      direction: 'OUT' | 'IN';
      at: Date | string;
      event_id: string | null;
      event_type: string | null;
      person: string | null;
      operator_id: string | null;
      operator_name: string | null;
      is_test: boolean;
      party: string;
      step_n: number | null;
      status: string;
      answered: boolean;
      duration_sec: number | null;
      result: string | null;
      recording: boolean;
    }>(sql`
      SELECT x.*, o.display_name AS operator_name FROM (
        SELECT c.id::text, 'OUT' AS direction, c.created_at AS at, c.event_id::text, e.type AS event_type,
               coalesce(e.is_test, false) AS is_test, p.display_name AS person, c.operator_id,
               coalesce(s.kind || coalesce(':' || s.contact_index, ''), 'STEP') AS party, c.step_n,
               c.status, c.answered, c.duration_sec, s.result, (c.recording_ref IS NOT NULL) AS recording
        FROM telephony.call c
        LEFT JOIN event.event e ON e.id = c.event_id
        LEFT JOIN profile.protected_person p ON p.id::text = e.protected_person_id
        LEFT JOIN chain.chain_run r ON r.event_id = c.event_id
        LEFT JOIN chain.chain_step s ON s.run_id = r.id AND s.n = c.step_n
        WHERE c.created_at >= ${f.from} AND c.created_at < ${f.to}
        UNION ALL
        SELECT i.id::text, 'IN', i.created_at, i.event_id::text, e.type, coalesce(e.is_test, false), p.display_name,
               i.operator_id,
               'INBOUND', NULL, i.status, (i.answered_at IS NOT NULL), i.duration_sec, NULL,
               (i.recording_ref IS NOT NULL)
        FROM telephony.inbound_call i
        LEFT JOIN event.event e ON e.id = i.event_id
        LEFT JOIN profile.protected_person p ON p.id::text = i.protected_person_id
        WHERE i.created_at >= ${f.from} AND i.created_at < ${f.to}
      ) x
      LEFT JOIN identity.operator o ON o.subject = x.operator_id
      WHERE true
        ${f.operatorId ? sql`AND x.operator_id = ${f.operatorId}` : sql``}
        ${f.eventId && UUID.test(f.eventId) ? sql`AND x.event_id = ${f.eventId}` : sql``}
        ${f.answered !== undefined ? sql`AND x.answered = ${f.answered}` : sql``}
      ORDER BY x.at DESC
      LIMIT ${limit}`);
    return rows.map((r) => ({
      id: r.id,
      direction: r.direction,
      at: new Date(r.at).toISOString(),
      eventId: r.event_id,
      eventType: r.event_type,
      person: r.person,
      operatorId: r.operator_id,
      operatorName: r.operator_name,
      isTest: r.is_test,
      party: r.party,
      stepN: r.step_n,
      status: r.status,
      answered: r.answered,
      durationSec: r.duration_sec,
      result: r.result,
      recording: r.recording,
    }));
  }

  /** Ses kaydı (yetkili rol): her dinleme audit.log'a yazılır (kim, hangi çağrı, neden). */
  async recording(callId: string, actor: { id: string; role: string }, reason: string | undefined) {
    if (!UUID.test(callId)) throw new NotFoundException('Kayıt yok');
    const why = (reason ?? '').trim();
    if (why.length < 5) throw new BadRequestException('Dinleme gerekçesi zorunlu (en az 5 karakter)');
    const [r] = await this.q<{ ref: string | null; event_id: string | null }>(sql`
      SELECT recording_ref AS ref, event_id::text FROM telephony.call WHERE id = ${callId}::uuid
      UNION ALL
      SELECT recording_ref, event_id::text FROM telephony.inbound_call WHERE id = ${callId}::uuid`);
    if (!r?.ref || !this.recordings) throw new NotFoundException('Kayıt yok');
    const obj = await this.recordings.get(r.ref);
    if (!obj) throw new NotFoundException('Kayıt yok');
    await this.db.insert(auditLog).values({
      actorKind: actor.role,
      actorId: actor.id,
      action: 'recording.played',
      entityType: 'call',
      entityId: callId,
      data: { role: actor.role, eventId: r.event_id, reason: why.slice(0, 200) },
    });
    return obj;
  }

  /** Genel analiz (son `days` gün): olaylar, SLA, aramalar, gelen aramalar, 112, düzenli aramalar, operatörler. */
  async analytics(days = 30, now = new Date()): Promise<Analytics> {
    const since = new Date(now.getTime() - days * 86_400_000);
    const pct = (p: number, col: ReturnType<typeof sql>) => sql`percentile_cont(${p}) WITHIN GROUP (ORDER BY ${col})`;
    const num = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);

    const byType = await this.q<{ k: string; n: number; real: number }>(sql`
      SELECT type AS k, count(*)::int AS n, count(*) FILTER (WHERE NOT is_test)::int AS real
      FROM event.event WHERE created_at >= ${since} AND created_at <= ${now} GROUP BY type`);
    const byOutcome = await this.q<{ k: string | null; n: number }>(sql`
      SELECT confirmed_outcome AS k, count(*)::int AS n FROM event.event
      WHERE closed_at >= ${since} AND closed_at <= ${now} AND NOT is_test GROUP BY 1`);
    const [sla] = await this.q<{ c50: number | null; c95: number | null; f50: number | null; f95: number | null }>(sql`
      WITH q AS (
        SELECT e.id,
               (SELECT min(t.at) FROM event.transition t WHERE t.event_id = e.id AND t.to_state = 'OPERATOR_QUEUE') AS queued,
               (SELECT min(t.at) FROM event.transition t WHERE t.event_id = e.id AND t.to_state = 'OPERATOR_ASSIGNED') AS claimed,
               (SELECT min(c.created_at) FROM telephony.call c WHERE c.event_id = e.id) AS first_call
        FROM event.event e WHERE e.created_at >= ${since} AND e.created_at <= ${now} AND NOT e.is_test)
      SELECT ${pct(0.5, sql`extract(epoch FROM claimed - queued)`)} AS c50,
             ${pct(0.95, sql`extract(epoch FROM claimed - queued)`)} AS c95,
             ${pct(0.5, sql`extract(epoch FROM first_call - claimed)`)} AS f50,
             ${pct(0.95, sql`extract(epoch FROM first_call - claimed)`)} AS f95
      FROM q WHERE claimed IS NOT NULL`);
    const parties = await this.q<{ k: string; n: number; a: number; talk: number | null }>(sql`
      SELECT coalesce(s.kind, 'STEP') AS k, count(*)::int AS n, count(*) FILTER (WHERE c.answered)::int AS a,
             avg(c.duration_sec) FILTER (WHERE c.answered) AS talk
      FROM telephony.call c
      JOIN event.event e ON e.id = c.event_id AND NOT e.is_test
      LEFT JOIN chain.chain_run r ON r.event_id = c.event_id
      LEFT JOIN chain.chain_step s ON s.run_id = r.id AND s.n = c.step_n
      WHERE c.created_at >= ${since} AND c.created_at <= ${now} GROUP BY 1`);
    const [inb] = await this.q<{ n: number; a: number; ab: number; wait: number | null }>(sql`
      SELECT count(*)::int AS n, count(*) FILTER (WHERE answered_at IS NOT NULL)::int AS a,
             count(*) FILTER (WHERE status = 'abandoned')::int AS ab,
             avg(extract(epoch FROM answered_at - created_at)) FILTER (WHERE answered_at IS NOT NULL) AS wait
      FROM telephony.inbound_call WHERE created_at >= ${since} AND created_at <= ${now}`);
    const [disp] = await this.q<{
      n: number;
      arrived: number;
      p50: number | null;
      p90: number | null;
      late: number;
      cancelled: number;
    }>(sql`
      SELECT count(*)::int AS n, count(on_scene_at)::int AS arrived,
             ${pct(0.5, sql`extract(epoch FROM on_scene_at - notified_at) / 60`)} AS p50,
             ${pct(0.9, sql`extract(epoch FROM on_scene_at - notified_at) / 60`)} AS p90,
             count(*) FILTER (WHERE on_scene_at - notified_at > make_interval(mins => ${Number(process.env.DISPATCH_ARRIVAL_SLA_MIN ?? 15)}))::int AS late,
             count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled
      FROM event.dispatch WHERE notified_at >= ${since} AND notified_at <= ${now}`);
    const [well] = await this.q<{ planned: number; done: number; help: number; notified: number; missed: number }>(sql`
      SELECT count(*)::int AS planned, count(*) FILTER (WHERE status = 'DONE_OK')::int AS done,
             count(*) FILTER (WHERE status = 'DONE_HELP')::int AS help,
             count(*) FILTER (WHERE status = 'NOTIFIED')::int AS notified,
             count(*) FILTER (WHERE status = 'MISSED')::int AS missed
      FROM event.check_call WHERE due_at >= ${since} AND due_at <= ${now}`);
    const ops = await this.q<{
      op: string;
      name: string | null;
      claims: number;
      closed: number;
      calls: number;
      answered: number;
      claim_s: number | null;
      handle_m: number | null;
    }>(sql`
      WITH t AS (
        SELECT t.actor_id AS op, t.event_id, t.to_state, t.at,
               (SELECT max(q.at) FROM event.transition q WHERE q.event_id = t.event_id AND q.to_state = 'OPERATOR_QUEUE' AND q.at <= t.at) AS queued
        FROM event.transition t
        WHERE t.at >= ${since} AND t.at <= ${now} AND t.actor_kind = 'OPERATOR' AND t.actor_id IS NOT NULL),
      c AS (
        SELECT c.operator_id AS op, count(*)::int AS calls, count(*) FILTER (WHERE c.answered)::int AS answered
        FROM telephony.call c JOIN event.event e ON e.id = c.event_id AND NOT e.is_test
        WHERE c.created_at >= ${since} AND c.created_at <= ${now} GROUP BY 1)
      SELECT t.op, (SELECT o.display_name FROM identity.operator o WHERE o.subject = t.op) AS name,
             count(*) FILTER (WHERE t.to_state = 'OPERATOR_ASSIGNED')::int AS claims,
             count(*) FILTER (WHERE t.to_state = 'CLOSED')::int AS closed,
             coalesce(max(c.calls), 0)::int AS calls, coalesce(max(c.answered), 0)::int AS answered,
             avg(extract(epoch FROM t.at - t.queued)) FILTER (WHERE t.to_state = 'OPERATOR_ASSIGNED') AS claim_s,
             avg(extract(epoch FROM t.at - t.queued) / 60) FILTER (WHERE t.to_state = 'CLOSED') AS handle_m
      FROM t LEFT JOIN c ON c.op = t.op GROUP BY t.op ORDER BY claims DESC LIMIT 100`);
    const daily = await this.q<{ day: string; events: number; emergencies: number; calls: number }>(sql`
      SELECT to_char(d, 'YYYY-MM-DD') AS day,
             (SELECT count(*) FROM event.event e WHERE e.created_at >= d AND e.created_at < d + interval '1 day' AND NOT e.is_test)::int AS events,
             (SELECT count(*) FROM event.event e WHERE e.closed_at >= d AND e.closed_at < d + interval '1 day' AND e.confirmed_outcome = 'EMERGENCY')::int AS emergencies,
             (SELECT count(*) FROM telephony.call c WHERE c.created_at >= d AND c.created_at < d + interval '1 day')::int AS calls
      FROM generate_series(date_trunc('day', ${since}::timestamptz), date_trunc('day', ${now}::timestamptz), interval '1 day') d
      ORDER BY d`);

    const outcome = Object.fromEntries(byOutcome.map((r) => [r.k ?? 'UNKNOWN', r.n]));
    const closedReal = byOutcome.reduce((a, r) => a + r.n, 0);
    const totalCalls = parties.reduce((a, r) => a + r.n, 0);
    const answered = parties.reduce((a, r) => a + r.a, 0);
    const talk = parties.filter((r) => r.talk !== null);
    return {
      days,
      events: {
        total: byType.reduce((a, r) => a + r.n, 0),
        real: byType.reduce((a, r) => a + r.real, 0),
        byType: Object.fromEntries(byType.map((r) => [r.k, r.real])),
        byOutcome: outcome,
      },
      sla: {
        claimP50Sec: num(sla?.c50),
        claimP95Sec: num(sla?.c95),
        firstCallP50Sec: num(sla?.f50),
        firstCallP95Sec: num(sla?.f95),
      },
      calls: {
        total: totalCalls,
        answered,
        answerRate: totalCalls ? answered / totalCalls : 0,
        avgTalkSec: talk.length
          ? num(
              talk.reduce((a, r) => a + Number(r.talk) * r.a, 0) /
                Math.max(
                  1,
                  talk.reduce((a, r) => a + r.a, 0),
                ),
            )
          : null,
        byParty: Object.fromEntries(parties.map((r) => [r.k, { total: r.n, answered: r.a }])),
      },
      inbound: { total: inb?.n ?? 0, answered: inb?.a ?? 0, abandoned: inb?.ab ?? 0, avgWaitSec: num(inb?.wait) },
      dispatch: {
        total: disp?.n ?? 0,
        arrived: disp?.arrived ?? 0,
        arrivalP50Min: num(disp?.p50),
        arrivalP90Min: num(disp?.p90),
        late: disp?.late ?? 0,
        cancelled: disp?.cancelled ?? 0,
      },
      wellness: well ?? { planned: 0, done: 0, help: 0, notified: 0, missed: 0 },
      falseAlarmRatio: closedReal ? (outcome.FALSE_ALARM ?? 0) / closedReal : 0,
      operators: ops.map((o) => ({
        operatorId: o.op,
        operatorName: o.name,
        claims: o.claims,
        closed: o.closed,
        calls: o.calls,
        answered: o.answered,
        avgClaimSec: num(o.claim_s),
        avgHandleMin: num(o.handle_m),
      })),
      daily,
    };
  }

  /** Olay arama (vaka dosyası listesi): tür, sonuç, kişi adı parçası, operatör; en yeni önce. */
  async events(f: {
    from: Date;
    to: Date;
    q?: string;
    type?: string;
    outcome?: string;
    operatorId?: string;
    limit?: number;
  }) {
    const rows = await this.q<{
      id: string;
      type: string;
      priority: number;
      state: string;
      outcome: string | null;
      is_test: boolean;
      created_at: Date | string;
      closed_at: Date | string | null;
      operator_id: string | null;
      person: string | null;
      dispatch: string | null;
    }>(sql`
      SELECT e.id::text, e.type, e.priority, e.state, e.confirmed_outcome AS outcome, e.is_test, e.created_at,
             e.closed_at, e.operator_id, p.display_name AS person, d.status AS dispatch
      FROM event.event e
      LEFT JOIN profile.protected_person p ON p.id::text = e.protected_person_id
      LEFT JOIN event.dispatch d ON d.event_id = e.id
      WHERE e.created_at >= ${f.from} AND e.created_at < ${f.to}
        ${f.type ? sql`AND e.type = ${f.type}` : sql``}
        ${f.outcome ? sql`AND e.confirmed_outcome = ${f.outcome}` : sql``}
        ${f.operatorId ? sql`AND e.operator_id = ${f.operatorId}` : sql``}
        ${f.q ? (UUID.test(f.q) ? sql`AND e.id = ${f.q}::uuid` : sql`AND p.display_name ILIKE ${`%${f.q.replace(/[%_]/g, '')}%`}`) : sql``}
      ORDER BY e.created_at DESC
      LIMIT ${Math.min(f.limit ?? 100, 500)}`);
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      priority: r.priority,
      state: r.state,
      outcome: r.outcome,
      isTest: r.is_test,
      createdAt: new Date(r.created_at).toISOString(),
      closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : null,
      operatorId: r.operator_id,
      person: r.person,
      dispatch: r.dispatch,
    }));
  }

  /**
   * Vaka dosyası: bir olayın tüm izi tek zaman çizelgesinde — geçişler (kim), zincir adımları (rehber rolü / sonuç /
   * not), aramalar (cevap, süre, kayıt), 112 süreci, bildirim teslimi (kod, alıcı türü, kanal, durum, deneme, yedek),
   * düzenli arama bağı, amir uyarıları (gördü mü), denetim kaydı. Numara, adres ve sağlık verisi yok.
   */
  async caseFile(eventId: string) {
    if (!UUID.test(eventId)) throw new NotFoundException('Olay yok');
    const [ev] = await this.q<{
      id: string;
      type: string;
      priority: number;
      state: string;
      outcome: string | null;
      is_test: boolean;
      created_at: Date | string;
      escalated_at: Date | string | null;
      closed_at: Date | string | null;
      close_reason: string | null;
      operator_id: string | null;
      person: string | null;
      sources: string[];
    }>(sql`
      SELECT e.id::text, e.type, e.priority, e.state, e.confirmed_outcome AS outcome, e.is_test, e.created_at,
             e.escalated_at, e.closed_at, e.close_reason, e.operator_id, p.display_name AS person,
             e.source_signal_ids AS sources
      FROM event.event e LEFT JOIN profile.protected_person p ON p.id::text = e.protected_person_id
      WHERE e.id = ${eventId}::uuid`);
    if (!ev) throw new NotFoundException('Olay yok');
    const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
    const transitions = await this.q<{
      from_state: string | null;
      to_state: string;
      actor_kind: string;
      actor_id: string | null;
      at: Date | string;
      note: string | null;
    }>(sql`
      SELECT from_state, to_state, actor_kind, actor_id, at, note FROM event.transition WHERE event_id = ${eventId}::uuid ORDER BY seq`);
    const steps = await this.q<{
      n: number;
      kind: string;
      contact_index: number | null;
      result: string | null;
      assessment: string | null;
      reason: string | null;
      note: string | null;
      operator_id: string | null;
      called_at: Date | string | null;
      completed_at: Date | string | null;
    }>(sql`
      SELECT s.n, s.kind, s.contact_index, s.result, s.assessment, s.reason, s.note, s.operator_id, s.called_at, s.completed_at
      FROM chain.chain_step s JOIN chain.chain_run r ON r.id = s.run_id WHERE r.event_id = ${eventId}::uuid ORDER BY s.n`);
    const notices = await this.q<{
      code: string;
      audience: string;
      recipient_kind: string;
      channel: string;
      status: string;
      attempts: number;
      created_at: Date | string;
      sent_at: Date | string | null;
      delivered_at: Date | string | null;
      fallback_of: string | null;
    }>(sql`
      SELECT code, audience, recipient_kind, channel, status, attempts, created_at, sent_at, delivered_at, fallback_of::text
      FROM notify.notification WHERE event_id = ${eventId}::uuid ORDER BY created_at, id`);
    const alerts = await this.q<{
      code: string;
      at: Date | string;
      acked_at: Date | string | null;
      acked_by: string | null;
    }>(sql`
      SELECT code, at, acked_at, acked_by FROM event.supervisor_alert WHERE event_id = ${eventId} ORDER BY at`);
    const [check] = await this.q<{ id: string; status: string; due_at: Date | string }>(sql`
      SELECT id::text, status, due_at FROM event.check_call WHERE event_id = ${eventId}::uuid LIMIT 1`);
    const [d] = await this.q<{
      status: string;
      case_ref: string | null;
      hospital: string | null;
      notified_at: Date | string;
      on_scene_at: Date | string | null;
    }>(sql`
      SELECT status, case_ref, hospital, notified_at, on_scene_at FROM event.dispatch WHERE event_id = ${eventId}::uuid`);
    const dispatchTimeline = d
      ? await this.q<{
          status: string;
          at: Date | string;
          actor_kind: string;
          actor_id: string | null;
          source: string;
          note: string | null;
        }>(sql`
          SELECT status, at, actor_kind, actor_id, source, note FROM event.dispatch_update WHERE event_id = ${eventId}::uuid ORDER BY at, id`)
      : [];
    const audit = await this.audit({
      from: new Date(0),
      to: new Date(Date.now() + 60_000),
      entityId: eventId,
      limit: 500,
    });
    const calls = await this.calls({ from: new Date(0), to: new Date(Date.now() + 60_000), eventId });
    const delivered = notices.filter((n) => n.delivered_at).length;
    return {
      event: {
        id: ev.id,
        type: ev.type,
        priority: ev.priority,
        state: ev.state,
        outcome: ev.outcome,
        isTest: ev.is_test,
        person: ev.person,
        operatorId: ev.operator_id,
        createdAt: iso(ev.created_at),
        escalatedAt: iso(ev.escalated_at),
        closedAt: iso(ev.closed_at),
        closeReason: ev.close_reason,
        signals: ev.sources.length,
      },
      transitions: transitions.map((t) => ({
        from: t.from_state,
        to: t.to_state,
        actorKind: t.actor_kind,
        actorId: t.actor_id,
        at: iso(t.at),
        note: t.note,
      })),
      steps: steps.map((x) => ({
        n: x.n,
        kind: x.kind,
        contactIndex: x.contact_index,
        result: x.result,
        assessment: x.assessment,
        reason: x.reason,
        note: x.note,
        operatorId: x.operator_id,
        calledAt: iso(x.called_at),
        completedAt: iso(x.completed_at),
      })),
      calls,
      dispatch: d
        ? {
            status: d.status,
            caseRef: d.case_ref,
            hospital: d.hospital,
            notifiedAt: iso(d.notified_at),
            onSceneAt: iso(d.on_scene_at),
            timeline: dispatchTimeline.map((u) => ({
              status: u.status,
              at: iso(u.at),
              actorKind: u.actor_kind,
              actorId: u.actor_id,
              source: u.source,
              note: u.note,
            })),
          }
        : null,
      notifications: {
        total: notices.length,
        delivered,
        failed: notices.filter((n) => n.status === 'failed').length,
        items: notices.map((n) => ({
          code: n.code,
          audience: n.audience,
          recipientKind: n.recipient_kind,
          channel: n.channel,
          status: n.status,
          attempts: n.attempts,
          fallback: !!n.fallback_of,
          createdAt: iso(n.created_at),
          sentAt: iso(n.sent_at),
          deliveredAt: iso(n.delivered_at),
        })),
      },
      wellness: check ? { checkId: check.id, status: check.status, dueAt: iso(check.due_at) } : null,
      alerts: alerts.map((a) => ({ code: a.code, at: iso(a.at), ackedAt: iso(a.acked_at), ackedBy: a.acked_by })),
      audit,
    };
  }

  /** Denetim kaydı (append-only): süzgeçli, en yeni önce. Veri alanı kişisel veri içermez (yazan modüller garanti eder). */
  async audit(f: { from: Date; to: Date; action?: string; actorId?: string; entityId?: string; limit?: number }) {
    const rows = await this.q<{
      id: string;
      at: Date | string;
      actor_kind: string;
      actor_id: string | null;
      action: string;
      entity_type: string | null;
      entity_id: string | null;
      data: unknown;
    }>(sql`
      SELECT id::text, at, actor_kind, actor_id, action, entity_type, entity_id, data
      FROM audit.log
      WHERE at >= ${f.from} AND at < ${f.to}
        ${f.action ? sql`AND action LIKE ${`${f.action.replace(/[%_]/g, '')}%`}` : sql``}
        ${f.actorId ? sql`AND actor_id = ${f.actorId}` : sql``}
        ${f.entityId ? sql`AND entity_id = ${f.entityId}` : sql``}
      ORDER BY at DESC, id DESC
      LIMIT ${Math.min(f.limit ?? 200, 1000)}`);
    return rows.map((r) => ({
      id: r.id,
      at: new Date(r.at).toISOString(),
      actorKind: r.actor_kind,
      actorId: r.actor_id,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      data: r.data,
    }));
  }

  /** Sistem sağlığı: outbox şeritleri ve DLQ, kuyruk, açık 112 süreçleri, kaçırılan düzenli aramalar, bağlı personel. */
  async health(now = new Date()) {
    const [o] = await this.q<{
      core: number;
      core_age: number | null;
      side: number;
      side_age: number | null;
      dlq: number;
      side_dead: number;
      queue: number;
      queue_age: number | null;
      dispatch_open: number;
      dispatch_late: number;
      wellness_missed_24h: number;
      staff_online: number;
    }>(sql`
      SELECT
        (SELECT count(*) FROM event.outbox WHERE processed_at IS NULL)::int AS core,
        (SELECT extract(epoch FROM ${now}::timestamptz - min(created_at)) FROM event.outbox WHERE processed_at IS NULL) AS core_age,
        (SELECT count(*) FROM event.outbox_side WHERE processed_at IS NULL AND dead_at IS NULL)::int AS side,
        (SELECT extract(epoch FROM ${now}::timestamptz - min(created_at)) FROM event.outbox_side WHERE processed_at IS NULL AND dead_at IS NULL) AS side_age,
        (SELECT count(*) FROM event.outbox_dlq)::int AS dlq,
        (SELECT count(*) FROM event.outbox_side WHERE dead_at IS NOT NULL)::int AS side_dead,
        (SELECT count(*) FROM event.event WHERE state = 'OPERATOR_QUEUE')::int AS queue,
        (SELECT extract(epoch FROM ${now}::timestamptz - min(coalesce(escalated_at, created_at))) FROM event.event WHERE state = 'OPERATOR_QUEUE') AS queue_age,
        (SELECT count(*) FROM event.dispatch WHERE status NOT IN ('COMPLETED', 'CANCELLED'))::int AS dispatch_open,
        (SELECT count(*) FROM event.dispatch WHERE status IN ('NOTIFIED', 'ACCEPTED', 'EN_ROUTE')
           AND notified_at < ${now}::timestamptz - make_interval(mins => ${Number(process.env.DISPATCH_ARRIVAL_SLA_MIN ?? 15)}))::int AS dispatch_late,
        (SELECT count(*) FROM event.check_call WHERE status = 'MISSED' AND completed_at > ${now}::timestamptz - interval '24 hours')::int AS wellness_missed_24h,
        (SELECT count(*) FROM identity.operator WHERE last_seen_at > ${now}::timestamptz - interval '90 seconds')::int AS staff_online`);
    const sec = (v: number | null) => (v === null || v === undefined ? null : Math.round(Number(v)));
    return {
      at: now.toISOString(),
      outbox: {
        core: o!.core,
        coreOldestSec: sec(o!.core_age),
        side: o!.side,
        sideOldestSec: sec(o!.side_age),
        dlq: o!.dlq,
        sideDead: o!.side_dead,
      },
      queue: { waiting: o!.queue, oldestSec: sec(o!.queue_age) },
      dispatch: { open: o!.dispatch_open, late: o!.dispatch_late },
      wellness: { missed24h: o!.wellness_missed_24h },
      staffOnline: o!.staff_online,
    };
  }
}
