import type { AdminCoverageMetrics } from '@yanimda/contracts';
import { useCallback, useEffect, useState } from 'react';

import { CoverageMetricsView } from './components/CoverageBoard';
import { DispatchPanel } from './components/Dispatch';
import type { AdminAnalytics, AdminCall, AdminHealth, AuditRow, DispatchView, WellnessCheck } from './lib/api';
import type { Backend } from './lib/backend';
import { t } from './lib/i18n';

/**
 * Yönetim ve çağrı merkezi paneli (/yonetim; amir ve yönetici). Sekmeler: genel bakış (analiz + sağlık), çağrılar
 * (kim kimi aradı, cevap, süre, ses kaydı — dinleme gerekçeli ve denetimli), 112 süreçleri, düzenli aramalar,
 * denetim kaydı. Masaüstünde tablo, telefonda kart.
 */
type Tab = 'overview' | 'coverage' | 'events' | 'calls' | 'dispatch' | 'wellness' | 'audit';
const TABS: Tab[] = ['overview', 'coverage', 'events', 'calls', 'dispatch', 'wellness', 'audit'];
const PERIODS = [1, 7, 30, 90];

const dt = (iso: string) =>
  new Date(iso).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const pct = (v: number) => `%${Math.round(v * 100)}`;
const n1 = (v: number | null | undefined, unit = '') => (v === null || v === undefined ? '–' : `${v}${unit}`);

export function AdminBoard({
  backend,
  operatorName,
  onBack,
  onLogout,
}: {
  backend: Backend;
  operatorName: string;
  onBack(): void;
  onLogout(): void;
}) {
  const api = backend.api;
  const [tab, setTab] = useState<Tab>('overview');
  const [days, setDays] = useState(7);
  const [error, setError] = useState<string | null>(null);
  // Vaka dosyası: herhangi bir sekmeden olay kimliğiyle açılır.
  const [caseId, setCaseId] = useState<string | null>(null);

  return (
    <div className="admin">
      <header className="topbar">
        <span className="brand">{t('O-UI-ADM-TITLE')}</span>
        <label className="period">
          <span className="muted small">{t('O-UI-ADM-PERIOD')}</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {PERIODS.map((d) => (
              <option key={d} value={d}>
                {t('O-UI-ADM-DAYS', { n: d })}
              </option>
            ))}
          </select>
        </label>
        <span className="spacer" />
        <button type="button" onClick={onBack}>
          {t('O-UI-SUP-BACK')}
        </button>
        <span className="operator">{operatorName}</span>
        <button type="button" onClick={onLogout}>
          {t('O-UI-LOGOUT')}
        </button>
      </header>
      <nav className="admin-tabs" aria-label={t('O-UI-ADM-TITLE')}>
        {TABS.map((x) => (
          <button
            key={x}
            type="button"
            className={tab === x ? 'on' : ''}
            aria-current={tab === x ? 'page' : undefined}
            onClick={() => setTab(x)}
          >
            {t(`O-UI-ADM-TAB-${x.toUpperCase()}`)}
          </button>
        ))}
      </nav>
      {error && (
        <p className="error pad" role="alert">
          {error}
        </p>
      )}
      <main className="admin-main">
        {caseId && <CaseFile api={api} eventId={caseId} onClose={() => setCaseId(null)} onError={setError} />}
        {tab === 'overview' && <Overview api={api} days={days} onError={setError} />}
        {tab === 'coverage' && <CoverageTab api={api} days={days} onError={setError} />}
        {tab === 'events' && <Events api={api} days={days} onError={setError} onOpen={setCaseId} />}
        {tab === 'calls' && <Calls api={api} days={days} onError={setError} onOpen={setCaseId} />}
        {tab === 'dispatch' && <Dispatches api={api} onError={setError} />}
        {tab === 'wellness' && <Wellness api={api} days={days} onError={setError} />}
        {tab === 'audit' && <Audit api={api} days={days} onError={setError} />}
      </main>
    </div>
  );
}

type Api = Backend['api'];
type Part = { api: Api; days: number; onError(e: string | null): void };

function useLoad<T>(fn: () => Promise<T>, onError: (e: string | null) => void, deps: unknown[]) {
  const [v, setV] = useState<T | null>(null);
  const load = useCallback(async () => {
    try {
      setV(await fn());
      onError(null);
    } catch (e) {
      onError(t('O-UI-ERROR', { detail: (e as Error).message }));
    }
  }, deps);
  useEffect(() => void load(), [load]);
  return [v, load] as const;
}

function Kpi({ label, value, note, warn }: { label: string; value: string | number; note?: string; warn?: boolean }) {
  return (
    <div className={`tile${warn ? ' warn' : ''}`}>
      <span className="muted small">{label}</span>
      <strong>{value}</strong>
      {note && <span className="muted small">{note}</span>}
    </div>
  );
}

/** T-085 (S7.3) kapsama ve cihaz ölçüleri (yalnız toplamlar; en çok 90 gün). */
function CoverageTab({ api, days, onError }: Part) {
  const [m] = useLoad<AdminCoverageMetrics>(() => api.adminCoverageMetrics(days), onError, [api, days]);
  if (!m) return <p className="muted pad">{t('O-UI-LOGGING-IN')}</p>;
  return (
    <section className="sup-panel wide" aria-label={t('O-UI-ADM-TAB-COVERAGE')}>
      <CoverageMetricsView m={m} />
    </section>
  );
}

function Overview({ api, days, onError }: Part) {
  const [a] = useLoad<AdminAnalytics>(() => api.adminAnalytics(days), onError, [api, days]);
  const [h] = useLoad<AdminHealth>(() => api.adminHealth(), onError, [api]);
  if (!a || !h) return <p className="muted pad">{t('O-UI-LOGGING-IN')}</p>;
  const maxDaily = Math.max(1, ...a.daily.map((d) => d.events));
  return (
    <>
      <section className="sup-tiles" aria-label={t('O-UI-ADM-TAB-OVERVIEW')}>
        <Kpi
          label={t('O-UI-ADM-EVENTS')}
          value={a.events.real}
          note={t('O-UI-ADM-EMERGENCIES', { n: a.events.byOutcome.EMERGENCY ?? 0 })}
        />
        <Kpi
          label={t('O-UI-ADM-CLAIM-SLA')}
          value={`${n1(a.sla.claimP50Sec, ' sn')} / ${n1(a.sla.claimP95Sec, ' sn')}`}
        />
        <Kpi
          label={t('O-UI-ADM-FIRST-CALL')}
          value={`${n1(a.sla.firstCallP50Sec, ' sn')} / ${n1(a.sla.firstCallP95Sec, ' sn')}`}
        />
        <Kpi
          label={t('O-UI-ADM-ANSWER-RATE')}
          value={pct(a.calls.answerRate)}
          note={t('O-UI-ADM-CALLS', { n: a.calls.total })}
        />
        <Kpi
          label={t('O-UI-ADM-112-ARRIVAL')}
          value={`${n1(a.dispatch.arrivalP50Min, ' dk')} / ${n1(a.dispatch.arrivalP90Min, ' dk')}`}
          note={t('O-UI-ADM-112-COUNT', { n: a.dispatch.total, late: a.dispatch.late })}
          warn={a.dispatch.late > 0}
        />
        <Kpi
          label={t('O-UI-ADM-WELLNESS')}
          value={
            a.wellness.planned
              ? pct((a.wellness.done + a.wellness.help + a.wellness.notified) / Math.max(1, a.wellness.planned))
              : '–'
          }
          note={t('O-UI-ADM-WELLNESS-MISSED', { n: a.wellness.missed })}
          warn={a.wellness.missed > 0}
        />
        <Kpi
          label={t('O-UI-ADM-INBOUND')}
          value={a.inbound.total}
          note={t('O-UI-ADM-INBOUND-NOTE', { answered: a.inbound.answered, abandoned: a.inbound.abandoned })}
        />
        <Kpi label={t('O-UI-ADM-FALSE-ALARM')} value={pct(a.falseAlarmRatio)} />
      </section>

      <section className="sup-panel" aria-labelledby="adm-health">
        <h2 id="adm-health">{t('O-UI-ADM-HEALTH')}</h2>
        <dl className="kv">
          <dt>{t('O-UI-ADM-HEALTH-QUEUE')}</dt>
          <dd>
            {h.queue.waiting} · {n1(h.queue.oldestSec, ' sn')}
          </dd>
          <dt>{t('O-UI-ADM-HEALTH-STAFF')}</dt>
          <dd>{h.staffOnline}</dd>
          <dt>{t('O-UI-ADM-HEALTH-OUTBOX')}</dt>
          <dd className={h.outbox.dlq > 0 ? 'late' : ''}>
            {h.outbox.core} / {h.outbox.side} · DLQ {h.outbox.dlq} / {h.outbox.sideDead}
          </dd>
          <dt>{t('O-UI-ADM-HEALTH-112')}</dt>
          <dd className={h.dispatch.late > 0 ? 'late' : ''}>
            {h.dispatch.open} · {t('O-UI-DISPATCH-LATE')}: {h.dispatch.late}
          </dd>
          <dt>{t('O-UI-ADM-WELLNESS-MISSED-24H')}</dt>
          <dd className={h.wellness.missed24h > 0 ? 'late' : ''}>{h.wellness.missed24h}</dd>
        </dl>
      </section>

      <section className="sup-panel" aria-labelledby="adm-daily">
        <h2 id="adm-daily">{t('O-UI-ADM-DAILY')}</h2>
        <ol className="bars">
          {a.daily.slice(-14).map((d) => (
            <li key={d.day}>
              <span className="small muted">{d.day.slice(5)}</span>
              <span className="bar" style={{ width: `${(d.events / maxDaily) * 100}%` }} />
              <span className="small">
                {d.events} · {d.emergencies}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section className="sup-panel wide" aria-labelledby="adm-ops">
        <h2 id="adm-ops">{t('O-UI-ADM-OPERATORS')}</h2>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('O-UI-ADM-COL-OPERATOR')}</th>
                <th>{t('O-UI-ADM-COL-CLAIMS')}</th>
                <th>{t('O-UI-ADM-COL-CLOSED')}</th>
                <th>{t('O-UI-ADM-COL-CALLS')}</th>
                <th>{t('O-UI-ADM-COL-CLAIM-AVG')}</th>
                <th>{t('O-UI-ADM-COL-HANDLE')}</th>
              </tr>
            </thead>
            <tbody>
              {a.operators.map((o) => (
                <tr key={o.operatorId}>
                  <td data-label={t('O-UI-ADM-COL-OPERATOR')}>{o.operatorId}</td>
                  <td data-label={t('O-UI-ADM-COL-CLAIMS')}>{o.claims}</td>
                  <td data-label={t('O-UI-ADM-COL-CLOSED')}>{o.closed}</td>
                  <td data-label={t('O-UI-ADM-COL-CALLS')}>
                    {o.calls} ({o.answered})
                  </td>
                  <td data-label={t('O-UI-ADM-COL-CLAIM-AVG')}>{n1(o.avgClaimSec, ' sn')}</td>
                  <td data-label={t('O-UI-ADM-COL-HANDLE')}>{n1(o.avgHandleMin, ' dk')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function Calls({ api, days, onError, onOpen }: Part & { onOpen(id: string): void }) {
  const [only, setOnly] = useState<'all' | 'answered' | 'missed'>('all');
  const [rows] = useLoad<AdminCall[]>(
    () => api.adminCalls(days, only === 'all' ? undefined : only === 'answered'),
    onError,
    [api, days, only],
  );
  const [playing, setPlaying] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => () => void (playing && URL.revokeObjectURL(playing.url)), [playing]);
  const play = async (id: string) => {
    const reason = window.prompt(t('O-UI-ADM-PLAY-REASON')) ?? '';
    if (!reason.trim()) return;
    try {
      setPlaying({ id, url: await api.recordingUrl(id, reason.trim()) });
    } catch (e) {
      onError(t('O-UI-ERROR', { detail: (e as Error).message }));
    }
  };
  return (
    <section className="sup-panel wide" aria-labelledby="adm-calls">
      <h2 id="adm-calls">{t('O-UI-ADM-TAB-CALLS')}</h2>
      <div className="row" role="group" aria-label={t('O-UI-ADM-FILTER')}>
        {(['all', 'answered', 'missed'] as const).map((f) => (
          <button
            key={f}
            type="button"
            className={only === f ? 'on' : ''}
            aria-pressed={only === f}
            onClick={() => setOnly(f)}
          >
            {t(`O-UI-ADM-CALLS-${f.toUpperCase()}`)}
          </button>
        ))}
      </div>
      {playing && (
        <div className="row">
          <audio controls autoPlay src={playing.url} aria-label={t('O-UI-ADM-RECORDING')} />
        </div>
      )}
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{t('O-UI-ADM-COL-TIME')}</th>
              <th>{t('O-UI-ADM-COL-DIRECTION')}</th>
              <th>{t('O-UI-ADM-COL-PERSON')}</th>
              <th>{t('O-UI-ADM-COL-PARTY')}</th>
              <th>{t('O-UI-ADM-COL-OPERATOR')}</th>
              <th>{t('O-UI-ADM-COL-ANSWER')}</th>
              <th>{t('O-UI-ADM-COL-DURATION')}</th>
              <th>{t('O-UI-ADM-RECORDING')}</th>
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((c) => (
              <tr key={c.id}>
                <td data-label={t('O-UI-ADM-COL-TIME')}>{dt(c.at)}</td>
                <td data-label={t('O-UI-ADM-COL-DIRECTION')}>
                  {t(`O-UI-ADM-DIR-${c.direction}`)}
                  {c.eventType ? ` · ${t(`O-TYPE-${c.eventType}`)}` : ''}
                  {c.eventId && (
                    <button type="button" className="link" onClick={() => onOpen(c.eventId!)}>
                      {t('O-UI-ADM-OPEN-CASE')}
                    </button>
                  )}
                </td>
                <td data-label={t('O-UI-ADM-COL-PERSON')}>{c.person ?? '–'}</td>
                <td data-label={t('O-UI-ADM-COL-PARTY')}>{partyLabel(c.party)}</td>
                <td data-label={t('O-UI-ADM-COL-OPERATOR')}>
                  {('operatorName' in c && c.operatorName) || c.operatorId || '–'}
                </td>
                <td data-label={t('O-UI-ADM-COL-ANSWER')} className={c.answered ? '' : 'late'}>
                  {c.answered ? t('O-UI-ADM-ANSWERED') : t('O-UI-ADM-NOT-ANSWERED')}
                  {c.result ? ` · ${c.result}` : ''}
                </td>
                <td data-label={t('O-UI-ADM-COL-DURATION')}>{n1(c.durationSec, ' sn')}</td>
                <td data-label={t('O-UI-ADM-RECORDING')}>
                  {c.recording ? (
                    <button type="button" onClick={() => void play(c.id)}>
                      {t('O-UI-ADM-PLAY')}
                    </button>
                  ) : (
                    '–'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows && rows.length === 0 && <p className="muted">{t('O-UI-ADM-EMPTY')}</p>}
    </section>
  );
}

const partyLabel = (p: string) => {
  const [kind, idx] = p.split(':');
  return idx ? `${t(`O-UI-ADM-PARTY-${kind}`)} ${idx}` : t(`O-UI-ADM-PARTY-${kind}`);
};

function Dispatches({ api, onError }: Omit<Part, 'days'>) {
  const [rows] = useLoad<DispatchView[]>(() => api.dispatches(false), onError, [api]);
  return (
    <section className="sup-panel wide" aria-labelledby="adm-112">
      <h2 id="adm-112">{t('O-UI-ADM-TAB-DISPATCH')}</h2>
      {(rows ?? []).length === 0 && <p className="muted">{t('O-UI-ADM-EMPTY')}</p>}
      {(rows ?? []).map((d) =>
        d.open ? (
          <DispatchPanel key={d.eventId} api={api} eventId={d.eventId} initial={d} />
        ) : (
          <p key={d.eventId} className="dispatch-closed small">
            {dt(d.notifiedAt)} · {t(`O-DISPATCH-STAGE-${d.status}`)}
            {d.arrivalMin !== null ? ` · ${t('O-UI-DISPATCH-ARRIVAL', { min: d.arrivalMin })}` : ''}
            {d.hospital ? ` · ${d.hospital}` : ''}
            {d.caseRef ? ` · ${d.caseRef}` : ''}
          </p>
        ),
      )}
    </section>
  );
}

function Wellness({ api, days, onError }: Part) {
  const [rows] = useLoad<WellnessCheck[]>(() => api.wellnessChecks(days), onError, [api, days]);
  return (
    <section className="sup-panel wide" aria-labelledby="adm-well">
      <h2 id="adm-well">{t('O-UI-ADM-TAB-WELLNESS')}</h2>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{t('O-UI-ADM-COL-TIME')}</th>
              <th>{t('O-UI-ADM-COL-PERSON')}</th>
              <th>{t('O-UI-ADM-COL-CHANNEL')}</th>
              <th>{t('O-UI-ADM-COL-STATUS')}</th>
              <th>{t('O-UI-ADM-COL-OPERATOR')}</th>
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((c) => (
              <tr key={c.id} className={c.status === 'MISSED' ? 'late' : ''}>
                <td data-label={t('O-UI-ADM-COL-TIME')}>{dt(c.dueAt)}</td>
                <td data-label={t('O-UI-ADM-COL-PERSON')}>{c.person ?? '–'}</td>
                <td data-label={t('O-UI-ADM-COL-CHANNEL')}>{t(`O-UI-ADM-CHANNEL-${c.channel}`)}</td>
                <td data-label={t('O-UI-ADM-COL-STATUS')}>
                  {t(`O-UI-ADM-CHECK-${c.status}`)}
                  {c.status === 'SKIPPED' && c.outcome ? ` · ${t(`O-UI-ADM-SKIP-${c.outcome}`)}` : ''}
                  {c.status === 'MISSED' && c.outcome ? ` · ${t(`O-UI-ADM-MISS-${c.outcome}`)}` : ''}
                </td>
                <td data-label={t('O-UI-ADM-COL-OPERATOR')}>{c.operatorId ?? '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows && rows.length === 0 && <p className="muted">{t('O-UI-ADM-EMPTY')}</p>}
    </section>
  );
}

function Audit({ api, days, onError }: Part) {
  const [action, setAction] = useState('');
  const [rows] = useLoad<AuditRow[]>(() => api.adminAudit(days, action || undefined), onError, [api, days, action]);
  return (
    <section className="sup-panel wide" aria-labelledby="adm-audit">
      <h2 id="adm-audit">{t('O-UI-ADM-TAB-AUDIT')}</h2>
      <label className="row">
        <span className="muted small">{t('O-UI-ADM-AUDIT-ACTION')}</span>
        <input
          value={action}
          placeholder="recording., dispatch., event."
          onChange={(e) => setAction(e.target.value.trim())}
        />
      </label>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{t('O-UI-ADM-COL-TIME')}</th>
              <th>{t('O-UI-ADM-COL-ACTOR')}</th>
              <th>{t('O-UI-ADM-COL-ACTION')}</th>
              <th>{t('O-UI-ADM-COL-ENTITY')}</th>
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((r) => (
              <tr key={r.id}>
                <td data-label={t('O-UI-ADM-COL-TIME')}>{dt(r.at)}</td>
                <td data-label={t('O-UI-ADM-COL-ACTOR')}>
                  {r.actorKind}
                  {r.actorId ? ` · ${r.actorId}` : ''}
                </td>
                <td data-label={t('O-UI-ADM-COL-ACTION')}>{r.action}</td>
                <td data-label={t('O-UI-ADM-COL-ENTITY')} className="small">
                  {r.entityType} {r.entityId?.slice(0, 8)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

type CaseFileView = Awaited<ReturnType<Api['adminCase']>>;
type EventRow = Awaited<ReturnType<Api['adminEvents']>>[number];

function Events({ api, days, onError, onOpen }: Part & { onOpen(id: string): void }) {
  const [q, setQ] = useState('');
  const [rows] = useLoad<EventRow[]>(() => api.adminEvents(days, q || undefined), onError, [api, days, q]);
  return (
    <section className="sup-panel wide" aria-labelledby="adm-events">
      <h2 id="adm-events">{t('O-UI-ADM-TAB-EVENTS')}</h2>
      <label className="row">
        <span className="muted small">{t('O-UI-ADM-SEARCH')}</span>
        <input value={q} onChange={(e) => setQ(e.target.value.trim())} />
      </label>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{t('O-UI-ADM-COL-TIME')}</th>
              <th>{t('O-UI-ADM-COL-PERSON')}</th>
              <th>{t('O-UI-ADM-COL-TYPE')}</th>
              <th>{t('O-UI-ADM-COL-STATUS')}</th>
              <th>{t('O-UI-ADM-COL-112')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((e) => (
              <tr key={e.id}>
                <td data-label={t('O-UI-ADM-COL-TIME')}>{dt(e.createdAt)}</td>
                <td data-label={t('O-UI-ADM-COL-PERSON')}>{e.person ?? '–'}</td>
                <td data-label={t('O-UI-ADM-COL-TYPE')}>
                  P{e.priority} {t(`O-TYPE-${e.type}`)}
                  {e.isTest ? ` · ${t('O-UI-TEST')}` : ''}
                </td>
                <td data-label={t('O-UI-ADM-COL-STATUS')}>
                  {t(`O-STATE-${e.state}`)}
                  {e.outcome ? ` · ${t(`O-OUT-${e.outcome}`)}` : ''}
                </td>
                <td data-label={t('O-UI-ADM-COL-112')}>{e.dispatch ? t(`O-DISPATCH-STAGE-${e.dispatch}`) : '–'}</td>
                <td>
                  <button type="button" onClick={() => onOpen(e.id)}>
                    {t('O-UI-ADM-OPEN-CASE')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows && rows.length === 0 && <p className="muted">{t('O-UI-ADM-EMPTY')}</p>}
    </section>
  );
}

/** Vaka dosyası: olayın tüm izi (kim, ne zaman, kime, sonuç, 112, bildirim teslimi, uyarılar, denetim). */
function CaseFile({
  api,
  eventId,
  onClose,
  onError,
}: {
  api: Api;
  eventId: string;
  onClose(): void;
  onError(e: string | null): void;
}) {
  const [c] = useLoad<CaseFileView>(() => api.adminCase(eventId), onError, [api, eventId]);
  if (!c) return null;
  const ev = c.event;
  return (
    <section className="sup-panel wide case" aria-labelledby="case-title" data-testid="case-file">
      <header className="row">
        <h2 id="case-title">
          {t('O-UI-ADM-CASE')} · P{ev.priority} {t(`O-TYPE-${ev.type}`)} · {ev.person ?? '–'}
        </h2>
        <span className="spacer" />
        <button type="button" onClick={onClose}>
          {t('O-UI-CANCEL')}
        </button>
      </header>
      <p className="muted small">
        {dt(ev.createdAt!)} · {t(`O-STATE-${ev.state}`)}
        {ev.outcome ? ` · ${t(`O-OUT-${ev.outcome}`)}` : ''} · {t('O-UI-ADM-SIGNALS', { n: ev.signals })}
      </p>
      <h3>{t('O-UI-ADM-CASE-TIMELINE')}</h3>
      <ol className="case-list">
        {c.transitions.map((x, i) => (
          <li key={i}>
            <time>{dt(x.at!)}</time> {t(`O-STATE-${x.to}`)} · {x.actorKind}
            {x.actorId ? ` ${x.actorId}` : ''}
            {x.note ? ` · ${x.note}` : ''}
          </li>
        ))}
      </ol>
      <h3>{t('O-UI-STEPS')}</h3>
      <ol className="case-list">
        {c.steps.map((s) => (
          <li key={s.n}>
            {s.n}. {t(`O-UI-ADM-PARTY-${s.kind}`)}
            {s.contactIndex ? ` ${s.contactIndex}` : ''} · {s.result ?? '–'}
            {s.assessment ? ` · ${s.assessment}` : ''}
            {s.reason ? ` · ${s.reason}` : ''}
            {s.note ? ` · ${s.note}` : ''}
          </li>
        ))}
      </ol>
      <h3>{t('O-UI-ADM-TAB-CALLS')}</h3>
      <ol className="case-list">
        {c.calls.map((x) => (
          <li key={x.id}>
            <time>{dt(x.at)}</time> {partyLabel(x.party)} ·{' '}
            {x.answered ? t('O-UI-ADM-ANSWERED') : t('O-UI-ADM-NOT-ANSWERED')}
            {x.durationSec !== null ? ` · ${x.durationSec} sn` : ''} · {x.operatorName ?? x.operatorId ?? '–'}
            {x.recording ? ` · ${t('O-UI-ADM-RECORDING')}` : ''}
          </li>
        ))}
      </ol>
      {c.dispatch && (
        <>
          <h3>{t('O-UI-DISPATCH')}</h3>
          <ol className="case-list">
            {c.dispatch.timeline.map((u, i) => (
              <li key={i}>
                <time>{dt(u.at!)}</time> {t(`O-DISPATCH-STAGE-${u.status}`)} · {t(`O-UI-DISPATCH-SOURCE-${u.source}`)}
                {u.note ? ` · ${u.note}` : ''}
              </li>
            ))}
          </ol>
        </>
      )}
      <h3>
        {t('O-UI-ADM-NOTIFICATIONS')} ({c.notifications.delivered}/{c.notifications.total})
      </h3>
      <ol className="case-list">
        {c.notifications.items.map((n, i) => (
          <li key={i} className={n.status === 'failed' ? 'late' : ''}>
            <time>{dt(n.createdAt!)}</time> {n.code} · {n.recipientKind} · {n.channel} · {n.status}
            {n.fallback ? ` · ${t('O-UI-ADM-FALLBACK')}` : ''}
            {n.deliveredAt ? ` · ${dt(n.deliveredAt)}` : ''}
          </li>
        ))}
      </ol>
      {c.alerts.length > 0 && (
        <>
          <h3>{t('O-UI-ALERTS')}</h3>
          <ol className="case-list">
            {c.alerts.map((a, i) => (
              <li key={i}>
                <time>{dt(a.at!)}</time> {a.code}
                {a.ackedBy ? ` · ${t('O-UI-ALERTS-ACKED', { by: a.ackedBy, time: dt(a.ackedAt!) })}` : ''}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
