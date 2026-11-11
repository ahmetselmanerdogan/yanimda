import type { AdminCoverageMetrics, LadderStepStat, SupervisorCoverageBoard } from '@yanimda/contracts';

import { ageText } from '../lib/devices';
import { has, t } from '../lib/i18n';

/** Merdiven adımı anahtarı (CALL_CONTACT:1 …) → katalog adım adı (O-STEP-*); bilinmeyen adım "bilinmiyor". */
const STEP_CODES: Record<string, string> = {
  CALL_WATCH: 'O-STEP-WATCH',
  CALL_VOICE_2: 'O-STEP-VOICE-2',
  CALL_PHONE: 'O-STEP-PHONE',
  CALL_REDIAL: 'O-STEP-REDIAL',
  CALL_CONTACT: 'O-STEP-CONTACT',
  CALL_NEIGHBOR: 'O-STEP-NEIGHBOR',
  CALL_KEY_HOLDER: 'O-STEP-KEY-HOLDER',
  CALL_112: 'O-STEP-112',
};
export function stepLabel(step: string): string {
  const [kind, n] = step.split(':');
  const code = STEP_CODES[kind ?? ''];
  return code && has(code) ? t(code, { n: n ?? '' }) : t('O-UI-UNKNOWN');
}
const pct = (x: number | null) => (x === null ? '–' : `%${Math.round(x * 100)}`);
const pct100 = (x: number | null) => (x === null ? '–' : `%${Math.round(x)}`);
const n1 = (v: number | null) => (v === null ? '–' : String(v));

/**
 * T-089 (docs/07 S7.2) amir kapsama panosu listeleri (durumsuz; test edilir): uyanıkken 20 dk+ YOK, kronik boşluk,
 * çevrimdışı telefon köprüleri, merdiven adımı başına ulaşılamama (7 / 30 gün), 90 sn üstlenilmeyen P1 ve
 * hareketsizlik / yerinde kontrol 112 bildirimleri. "Planlı şarj" görünümü filo kapsaması kutusunda kalır.
 */
export function CoverageBoardView({ board, now }: { board: SupervisorCoverageBoard; now: number }) {
  const empty = <p className="muted">{t('O-UI-SUP-EMPTY')}</p>;
  const name = (x: { name: string | null }) => x.name ?? t('O-UI-UNKNOWN');
  return (
    <div className="cov-grid" data-testid="coverage-board">
      <section aria-labelledby="cov-none-title">
        <h3 id="cov-none-title">{t('O-UI-SUP-NONE-AWAKE')}</h3>
        {board.noneAwake.length === 0 ? (
          empty
        ) : (
          <ol className="cov-list" data-testid="none-awake">
            {board.noneAwake.map((x) => (
              <li key={x.protectedPersonId}>{t('O-UI-SUP-NONE-ROW', { name: name(x), n: x.awakeMin })}</li>
            ))}
          </ol>
        )}
      </section>
      <section aria-labelledby="cov-chronic-title">
        <h3 id="cov-chronic-title">{t('O-UI-SUP-CHRONIC')}</h3>
        {board.chronic.length === 0 ? (
          empty
        ) : (
          <ul className="cov-list" data-testid="chronic">
            {board.chronic.map((x) => (
              <li key={x.protectedPersonId}>
                {t('O-UI-SUP-CHRONIC-ROW', { name: name(x), pct: pct100(x.protectedPct) })}
                {x.chronicSince && <span className="warn"> · {t('O-UI-SUP-CHRONIC-PLAN')}</span>}
                {x.toleranceMin > 0 && (
                  <span className="muted small"> · {t('O-UI-SUP-TOLERANCE', { n: x.toleranceMin })}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="cov-bridge-title">
        <h3 id="cov-bridge-title">{t('O-UI-SUP-BRIDGES')}</h3>
        {board.offlineBridges.length === 0 ? (
          empty
        ) : (
          <ul className="cov-list" data-testid="offline-bridges">
            {board.offlineBridges.map((x) => (
              <li key={x.protectedPersonId}>
                {t('O-UI-SUP-BRIDGE-ROW', {
                  name: name(x),
                  seen: x.phoneSeenAt ? ageText(x.phoneSeenAt, now) : t('O-UI-UNKNOWN'),
                  n: x.bridgedDevices,
                })}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="cov-unreach-title">
        <h3 id="cov-unreach-title">{t('O-UI-SUP-UNREACHABLE')}</h3>
        <StepTable title={t('O-UI-SUP-DAYS', { n: 7 })} rows={board.unreachable.days7} testId="unreach-7" />
        <StepTable title={t('O-UI-SUP-DAYS', { n: 30 })} rows={board.unreachable.days30} testId="unreach-30" />
      </section>
      <section aria-labelledby="cov-p1-title">
        <h3 id="cov-p1-title">{t('O-UI-SUP-UNCLAIMED-P1')}</h3>
        {board.unclaimedP1.length === 0 ? (
          empty
        ) : (
          <ul className="cov-list" data-testid="unclaimed-p1">
            {board.unclaimedP1.map((x) => (
              <li key={`${x.eventId}:${x.at}`}>
                {t(`O-TYPE-${x.eventType}`)} · {ageText(x.at, now)}
                {!x.acked && <span className="warn"> · {t('O-UI-SUP-NOT-ACKED')}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="cov-112-title">
        <h3 id="cov-112-title">{t('O-UI-SUP-DISPATCH-112')}</h3>
        {board.dispatch112.length === 0 ? (
          empty
        ) : (
          <ul className="cov-list" data-testid="dispatch-112">
            {board.dispatch112.map((x) => (
              <li key={x.eventId}>
                {name(x)} · {t(`O-TYPE-${x.eventType}`)} · {ageText(x.notifiedAt, now)} ·{' '}
                {has(`O-DISPATCH-STAGE-${x.status}`) ? t(`O-DISPATCH-STAGE-${x.status}`) : t('O-UI-UNKNOWN')}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function StepTable({ title, rows, testId }: { title: string; rows: LadderStepStat[]; testId: string }) {
  return (
    <table className="cov-table" data-testid={testId}>
      <caption className="muted small">{title}</caption>
      <thead>
        <tr>
          <th>{t('O-UI-SUP-COL-STEP')}</th>
          <th>{t('O-UI-SUP-COL-ATTEMPTS')}</th>
          <th>{t('O-UI-SUP-COL-UNREACHED')}</th>
          <th>{t('O-UI-SUP-COL-STALLED')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={4} className="muted">
              {t('O-UI-SUP-EMPTY')}
            </td>
          </tr>
        ) : (
          rows.map((r) => (
            <tr key={r.step}>
              <td>{stepLabel(r.step)}</td>
              <td>{r.attempted}</td>
              <td>{pct(r.unreachableRate)}</td>
              <td>{r.stalledHere}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

/**
 * T-085 (docs/07 S7.3) yönetim panelinde kapsama ve cihaz ölçüleri (durumsuz; yalnız toplamlar): kişi-gün kapsama
 * yüzdesi, model / sürüm başına yanlış alarm, sınıf / adaptör başına gecikme p95, şarj uyumu, 100 kişi-gün başına
 * olay, model başına pil sağlığı.
 */
export function CoverageMetricsView({ m }: { m: AdminCoverageMetrics }) {
  const c = m.coverage;
  return (
    <div className="cov-grid" data-testid="coverage-metrics">
      <section>
        <h3>{t('O-UI-ADM-COV-PERSON-DAY')}</h3>
        <p data-testid="cov-summary">
          {t('O-UI-ADM-COV-SUMMARY', {
            avg: pct100(c.avgProtectedPct),
            median: pct100(c.medianProtectedPct),
            below: pct(c.belowTargetShare),
            n: c.personDays,
          })}
        </p>
        <table className="cov-table">
          <tbody>
            {c.buckets.map((b) => (
              <tr key={b.label}>
                <td>%{b.label}</td>
                <td>{b.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <h3>{t('O-UI-ADM-COV-FALSE-ALARM')}</h3>
        <table className="cov-table" data-testid="cov-false-alarm">
          <thead>
            <tr>
              <th>{t('O-UI-ADM-COL-MODEL')}</th>
              <th>{t('O-UI-ADM-COL-VERSION')}</th>
              <th>{t('O-UI-ADM-COL-EVENTS')}</th>
              <th>{t('O-UI-ADM-COL-RATE')}</th>
            </tr>
          </thead>
          <tbody>
            {m.falseAlarms.map((r) => (
              <tr key={`${r.model}:${r.appVersion}`}>
                <td>{r.model}</td>
                <td>{r.appVersion}</td>
                <td>{r.events}</td>
                <td>{pct(r.rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <h3>{t('O-UI-ADM-COV-LATENCY')}</h3>
        <table className="cov-table" data-testid="cov-latency">
          <thead>
            <tr>
              <th>{t('O-UI-ADM-COL-TIER')}</th>
              <th>{t('O-UI-ADM-COL-ADAPTER')}</th>
              <th>{t('O-UI-ADM-COL-SIGNALS')}</th>
              <th>{t('O-UI-ADM-COL-P95')}</th>
            </tr>
          </thead>
          <tbody>
            {m.latency.map((r) => (
              <tr key={`${r.tier}:${r.adapter}`}>
                <td>{r.tier}</td>
                <td>{r.adapter}</td>
                <td>{r.signals}</td>
                <td>{r.p95Sec === null ? '–' : t('O-UI-SUP-SECONDS', { n: r.p95Sec })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <h3>{t('O-UI-ADM-COV-CHARGING')}</h3>
        <p data-testid="cov-charging">
          {t('O-UI-ADM-COV-CHARGING-ROW', {
            n: m.charging.sessions,
            median: n1(m.charging.medianToWearMin),
            p90: n1(m.charging.p90ToWearMin),
            early: pct(m.charging.beforeReminderShare),
          })}
        </p>
      </section>
      <section>
        <h3>{t('O-UI-ADM-COV-EVENTS')}</h3>
        <table className="cov-table" data-testid="cov-events">
          <tbody>
            {Object.entries(m.eventsPer100PersonDays).map(([type, n]) => (
              <tr key={type}>
                <td>{t(`O-TYPE-${type}`)}</td>
                <td>{n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <h3>{t('O-UI-ADM-COV-BATTERY')}</h3>
        <table className="cov-table" data-testid="cov-battery">
          <thead>
            <tr>
              <th>{t('O-UI-ADM-COL-MODEL')}</th>
              <th>{t('O-UI-ADM-COL-DEVICES')}</th>
              <th>{t('O-UI-ADM-COL-DRAIN')}</th>
            </tr>
          </thead>
          <tbody>
            {m.battery.map((r) => (
              <tr key={r.model}>
                <td>{r.model}</td>
                <td>{r.devices}</td>
                <td>{pct100(r.medianDailyDrainPct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
