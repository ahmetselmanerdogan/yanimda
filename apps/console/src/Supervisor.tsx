import { useCallback, useEffect, useState } from 'react';

import { DispatchPanel } from './components/Dispatch';
import type { DispatchView, SupervisorAlertView } from './lib/api';
import {
  ApiError,
  OPERATOR_STATUSES,
  type OperatorCard,
  type OperatorStatus,
  type SlaBreach,
  type SupervisorDashboard,
} from './lib/api';
import type { Backend } from './lib/backend';
import { action, t } from './lib/i18n';
import { disablePush, enablePush, type PushState, pushState } from './lib/push';
import { clock } from './lib/sla';

const pct = (x: number) => `%${Math.round(x * 100)}`;
const sec = (n: number | null | undefined) => (n === null || n === undefined ? null : t('O-UI-SUP-SECONDS', { n }));
const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const hour = (iso: string) => new Date(iso).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

/**
 * T-074 amir panosu (E-11): kuyruk derinliği (24 saat), operatör kartları, SLA ihlalleri, olay dağılımı, yanlış
 * alarm oranı; eylemler: olayı kuyruğa döndür, operatör durumu, yedek merkeze taşma bayrağı. Veri WS'den 5 sn'de
 * bir (`dashboard`); ilk yükleme ve eylem sonrası REST.
 */
export function SupervisorBoard({
  backend,
  operatorName,
  onBack,
  onLogout,
  onAdmin,
}: {
  backend: Backend;
  operatorName: string;
  onBack(): void;
  onLogout(): void;
  /** Yönetim paneline geçiş. */
  onAdmin?(): void;
}) {
  const api = backend.api;
  const [d, setD] = useState<SupervisorDashboard | null>(null);
  const [online, setOnline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(
    () =>
      api
        .dashboard()
        .then(setD)
        .catch((e: Error) => setError(t('O-UI-ERROR', { detail: e.message }))),
    [api],
  );
  // Kalıcı amir uyarıları (gördüm): 15 sn'de bir ve WS uyarısı gelince.
  const [alerts, setAlerts] = useState<SupervisorAlertView[]>([]);
  const loadAlerts = useCallback(() => void api.alerts(true).then(setAlerts, () => undefined), [api]);
  useEffect(() => {
    loadAlerts();
    const id = setInterval(loadAlerts, 15_000);
    return () => clearInterval(id);
  }, [loadAlerts]);
  const ackAlert = (id: string) =>
    void api.ackAlert(id).then(
      () => setAlerts((xs) => xs.filter((x) => x.id !== id)),
      (e: Error) => setError(e.message),
    );
  // PWA web push: amir uyarıları bu cihaza.
  const [push, setPush] = useState<PushState>('unsupported');
  useEffect(() => void pushState(api).then(setPush, () => undefined), [api]);
  const togglePush = () =>
    void (push === 'on' ? disablePush(api) : enablePush(api)).then(setPush, (e: Error) => setError(e.message));
  // 112 süreçleri (olay kapansa da sürer): 15 sn'de bir.
  const [dispatches, setDispatches] = useState<DispatchView[]>([]);
  useEffect(() => {
    const load = () => void api.dispatches(true).then(setDispatches, () => undefined);
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [api]);
  useEffect(() => void reload(), [reload]);
  useEffect(
    () =>
      backend.connect({
        onStatus: setOnline,
        onMessage: (m) => {
          if (m.type === 'dashboard') setD(m.dashboard);
        },
      }),
    [backend],
  );

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409
          ? t('O-UI-CONFLICT')
          : t('O-UI-ERROR', { detail: (e as Error).message }),
      );
    } finally {
      setBusy(false);
    }
  };

  const waiting = d?.queue.reduce((a, q) => a + q.waiting, 0) ?? 0;
  return (
    <div className="supervisor">
      <header className="topbar">
        <span className="brand">{t('O-UI-SUP-TITLE')}</span>
        <span className={`conn ${online ? 'on' : 'off'}`} role="status">
          {online ? t('O-UI-ONLINE') : t('O-UI-OFFLINE')}
        </span>
        {d && <span className="muted small">{t('O-UI-SUP-UPDATED', { time: hhmm(d.at) })}</span>}
        <span className="spacer" />
        {(push === 'on' || push === 'off') && (
          <button type="button" aria-pressed={push === 'on'} onClick={togglePush}>
            {t(push === 'on' ? 'O-UI-PUSH-ON' : 'O-UI-PUSH-OFF')}
          </button>
        )}
        {push === 'denied' && <span className="muted small">{t('O-UI-PUSH-DENIED')}</span>}
        {onAdmin && (
          <button type="button" onClick={onAdmin}>
            {t('O-UI-ADM-TITLE')}
          </button>
        )}
        <button type="button" onClick={onBack}>
          {t('O-UI-SUP-BACK')}
        </button>
        <span className="operator">{operatorName}</span>
        <button type="button" onClick={onLogout}>
          {t('O-UI-LOGOUT')}
        </button>
      </header>
      {error && (
        <p className="error pad" role="alert">
          {error}
        </p>
      )}
      {d && (
        <main className="sup-grid">
          <section className="sup-tiles" aria-label={t('O-UI-SUP-TITLE')}>
            <Tile label={t('O-UI-SUP-WAITING')} value={waiting} testId="tile-waiting" />
            <Tile
              label={t('O-UI-SUP-INBOUND')}
              value={d.inbound.queued}
              testId="tile-inbound"
              note={
                d.inbound.queued || d.inbound.ringing
                  ? t('O-UI-SUP-INBOUND-NOTE', {
                      ringing: d.inbound.ringing,
                      wait: d.inbound.oldestQueuedSec === null ? '–' : clock(d.inbound.oldestQueuedSec),
                    })
                  : undefined
              }
            />
            <Tile label={t('O-UI-SUP-IN-PROGRESS')} value={d.inProgress} />
            <Tile label={t('O-UI-SUP-ACTIVE-OPS')} value={d.activeOperators} />
            <Tile label={t('O-UI-SUP-CLOSED-24H')} value={d.last24h.closed} />
            <Tile
              label={t('O-UI-SUP-CLAIM')}
              value={`${sec(d.last24h.claim.p50Sec) ?? '–'} / ${sec(d.last24h.claim.p95Sec) ?? '–'}`}
            />
            <Tile
              label={t('O-UI-SUP-FALSE-ALARM', { days: d.falseAlarms.windowDays })}
              value={pct(d.falseAlarms.ratio)}
              note={[
                ...Object.entries(d.falseAlarms.byCause)
                  .filter(([, n]) => n > 0)
                  .map(([c, n]) => `${t(`O-UI-SUP-CAUSE-${c}`)}: ${n}`),
                t('O-UI-SUP-REPEAT', { n: d.falseAlarms.repeatPersons }),
              ].join(' · ')}
            />
            <div className={`tile overflow${d.overflow.enabled ? ' on' : ''}`} data-testid="overflow">
              <span className="muted small">{t('O-UI-SUP-OVERFLOW')}</span>
              <strong>{t(d.overflow.enabled ? 'O-UI-SUP-OVERFLOW-ON' : 'O-UI-SUP-OVERFLOW-OFF')}</strong>
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(() => api.setOverflow(!d.overflow.enabled))}
              >
                {action(d.overflow.enabled ? 'O-UI-SUP-OVERFLOW-ON' : 'O-UI-SUP-OVERFLOW-OFF')}
              </button>
            </div>
          </section>

          <section className="sup-panel">
            <h2>{t('O-UI-SUP-QUEUE-DEPTH')}</h2>
            <DepthChart points={d.queueDepth24h} />
          </section>

          <section className="sup-panel">
            <h2>{t('O-UI-SUP-BY-TYPE')}</h2>
            <Bars
              rows={Object.entries(d.byType24h).map(([k, n]) => ({ label: t(`O-TYPE-${k}`), n }))}
              empty={t('O-UI-SUP-BY-TYPE-NONE')}
            />
          </section>

          <section className="sup-panel wide" data-testid="alerts" aria-labelledby="alerts-title">
            <h2 id="alerts-title">
              {t('O-UI-ALERTS')} ({alerts.length})
            </h2>
            {alerts.length === 0 ? (
              <p className="muted">{t('O-UI-ALERTS-NONE')}</p>
            ) : (
              <ul className="alert-list">
                {alerts.map((a) => (
                  <li key={a.id} className={`alert-item a-${a.code}`}>
                    <time className="muted small">{hhmm(a.at)}</time>
                    <span>{t(a.code, { type: t(`O-TYPE-${a.eventType}`) })}</span>
                    <button type="button" onClick={() => ackAlert(a.id)}>
                      {t('O-UI-ALERT-ACK')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="sup-panel wide" data-testid="dispatches">
            <h2>{t('O-UI-DISPATCH-OPEN-LIST')}</h2>
            {dispatches.length === 0 ? (
              <p className="muted">{t('O-UI-DISPATCH-NONE')}</p>
            ) : (
              dispatches.map((x) => <DispatchPanel key={x.eventId} api={api} eventId={x.eventId} initial={x} />)
            )}
          </section>

          <section className="sup-panel wide">
            <h2>{t('O-UI-SUP-BREACHES')}</h2>
            <Breaches rows={d.slaBreaches} sla={d.sla} operators={d.operators} />
          </section>

          <section className="sup-panel wide">
            <h2>{t('O-UI-SUP-OPERATORS')}</h2>
            {d.operators.length === 0 ? (
              <p className="muted">{t('O-UI-SUP-OPERATORS-NONE')}</p>
            ) : (
              <div className="op-cards">
                {d.operators.map((o) => (
                  <OperatorTile
                    key={o.subject}
                    o={o}
                    busy={busy}
                    onStatus={(s) => void act(() => api.setOperatorStatus(o.subject, s))}
                    onUnclaim={(id) => void act(() => api.unclaim(id))}
                  />
                ))}
              </div>
            )}
          </section>
        </main>
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  note,
  testId,
}: {
  label: string;
  value: string | number;
  note?: string;
  testId?: string;
}) {
  return (
    <div className="tile" data-testid={testId}>
      <span className="muted small">{label}</span>
      <strong>{value}</strong>
      {note && <span className="muted small">{note}</span>}
    </div>
  );
}

/** Saatlik kuyruk derinliği: çubuk = saat sonundaki bekleyen; üstte en yüksek değer. */
function DepthChart({ points }: { points: SupervisorDashboard['queueDepth24h'] }) {
  const max = Math.max(1, ...points.map((p) => p.depth));
  const w = 12;
  const gap = 3;
  const h = 80;
  return (
    <svg
      className="depth"
      viewBox={`0 -14 ${points.length * (w + gap)} ${h + 28}`}
      role="img"
      aria-label={t('O-UI-SUP-QUEUE-DEPTH')}
    >
      {points.map((p, i) => {
        const bh = Math.max(p.depth ? 2 : 0, (p.depth / max) * h);
        return (
          <g key={p.at}>
            <title>{t('O-UI-SUP-DEPTH-POINT', { hour: hour(p.at), depth: p.depth, entered: p.entered })}</title>
            <rect x={i * (w + gap)} y={h - bh} width={w} height={bh} rx={2} className="bar" />
            <rect x={i * (w + gap)} y={0} width={w} height={h} className="hit" />
            {i % 6 === 0 && (
              <text x={i * (w + gap)} y={h + 12} className="axis">
                {hour(p.at)}
              </text>
            )}
          </g>
        );
      })}
      <text x={0} y={-4} className="axis">
        {t('O-UI-SUP-DEPTH-MAX', { n: max })}
      </text>
    </svg>
  );
}

function Bars({ rows, empty }: { rows: { label: string; n: number }[]; empty: string }) {
  if (!rows.length) return <p className="muted">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.n));
  return (
    <ul className="bars">
      {rows
        .sort((a, b) => b.n - a.n)
        .map((r) => (
          <li key={r.label}>
            <span>{r.label}</span>
            <span className="track">
              <span className="fill" style={{ width: `${(r.n / max) * 100}%` }} />
            </span>
            <strong>{r.n}</strong>
          </li>
        ))}
    </ul>
  );
}

function Breaches({
  rows,
  sla,
  operators,
}: {
  rows: SlaBreach[];
  sla: SupervisorDashboard['sla'];
  operators: OperatorCard[];
}) {
  if (!rows.length) return <p className="muted">{t('O-UI-SUP-BREACHES-NONE')}</p>;
  const name = (sub: string | null) => (sub ? (operators.find((o) => o.subject === sub)?.name ?? sub) : '');
  return (
    <table className="breaches">
      <tbody>
        {rows.map((b) => (
          <tr
            key={`${b.eventId}:${b.kind}`}
            data-testid="sla-breach"
            data-event-id={b.eventId}
            className={b.live ? 'live' : undefined}
          >
            <td>{hhmm(b.at)}</td>
            <td>
              {t('O-UI-PRIORITY', { n: b.priority })} {t(`O-TYPE-${b.type}`)}
            </td>
            <td>{t(`O-UI-SUP-BREACH-${b.kind}`, { sec: b.kind === 'CLAIM' ? sla.claimSec : sla.firstCallSec })}</td>
            <td>{sec(b.waitedSec)}</td>
            <td>{name(b.operatorId)}</td>
            <td>{b.live && <span className="badge-live">{t('O-UI-SUP-LIVE')}</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OperatorTile({
  o,
  busy,
  onStatus,
  onUnclaim,
}: {
  o: OperatorCard;
  busy: boolean;
  onStatus(s: OperatorStatus): void;
  onUnclaim(eventId: string): void;
}) {
  return (
    <article className={`op-card s-${o.status}`} data-testid="operator-card" data-subject={o.subject}>
      <header>
        <span className={`dot ${o.online ? 'on' : 'off'}`} />
        <strong>{o.name ?? o.subject}</strong>
        <span className="muted small">{t(o.online ? 'O-UI-SUP-CONNECTED' : 'O-UI-SUP-DISCONNECTED')}</span>
      </header>
      <label className="small">
        {t('O-UI-SUP-STATUS')}{' '}
        <select value={o.status} disabled={busy} onChange={(e) => onStatus(e.target.value as OperatorStatus)}>
          {OPERATOR_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`O-UI-SUP-STATUS-${s}`)}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">
        {t('O-UI-SUP-OP-STATS', { claims: o.claims24h, avg: o.avgClaimSec ?? '–', closed: o.closed24h })}
      </p>
      {o.open.map((e) => (
        <div key={e.eventId} className="op-event">
          <span>
            {t('O-UI-PRIORITY', { n: e.priority })} {t(`O-TYPE-${e.type}`)} · {t(`O-STATE-${e.state}`)}
          </span>
          <button type="button" disabled={busy} title={t('O-UI-SUP-UNCLAIM')} onClick={() => onUnclaim(e.eventId)}>
            {action('O-UI-SUP-UNCLAIM')}
          </button>
        </div>
      ))}
    </article>
  );
}
