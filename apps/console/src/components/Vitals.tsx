import type { EventVitalsView } from '@yanimda/contracts';
import { useCallback, useEffect, useState } from 'react';

import { type Api, ApiError, type EventRecord } from '../lib/api';
import { t } from '../lib/i18n';
import { chartGeometry, hrBaseline, qualityCode, ruleCode, seriesCode } from '../lib/vitals';

const REFRESH_MS = 60_000;
const W = 320;
const H = 80;

/**
 * T-092 (docs/07 S6.8, S7.1) olay ekranında değer grafiği: son 2 saatin 5 dk ortancaları, kişisel taban çizgisi ve
 * kalite rozeti; düşme sırasında alışılmadık nabız vurgusu. Yalnız açık olayda görünür (sunucu kapalı olayda 403,
 * değer olmayan olayda / özellik kapalıyken 404 döner → bölüm hiç çizilmez). Dışa aktarma yok.
 */
export function VitalsPanel({ api, event }: { api: Api; event: Pick<EventRecord, 'id' | 'state'> }) {
  const [view, setView] = useState<EventVitalsView | null>(null);
  const load = useCallback(
    () =>
      api.vitals(event.id).then(
        (v) => setView(v),
        (e: unknown) => {
          // 404 (değer yok / kapalı) ve 403 (olay kapandı): bölüm gösterilmez. Diğer hatalarda son görünüm kalır.
          if (e instanceof ApiError && (e.status === 404 || e.status === 403)) setView(null);
        },
      ),
    [api, event.id],
  );
  useEffect(() => {
    setView(null);
    if (event.state === 'CLOSED') return;
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [load, event.state]);
  if (!view || event.state === 'CLOSED') return null;
  return <VitalsView view={view} now={Date.now()} />;
}

/** Görünüm (durumsuz). */
export function VitalsView({ view, now }: { view: EventVitalsView; now: number }) {
  const from = now - view.windowMin * 60_000;
  return (
    <section className="vitals" aria-labelledby="vitals-title" data-testid="vitals">
      <header className="vitals-head">
        <h2 id="vitals-title">{t('O-UI-VITALS')}</h2>
        {view.quality && <span className={`vitals-quality q-${view.quality}`}>{t(qualityCode(view.quality))}</span>}
      </header>
      {view.highlight && (
        <p className="vitals-highlight" role="alert">
          {t('O-UI-VITALS-HIGHLIGHT')}
        </p>
      )}
      {view.alerts.length > 0 && (
        <ul className="vitals-alerts">
          {view.alerts.map((a) => (
            <li key={`${a.rule}-${a.at}`}>
              {t(ruleCode(a.rule))}: <strong>{a.value}</strong>
            </li>
          ))}
        </ul>
      )}
      {view.series.length === 0 && <p className="muted">{t('O-UI-VITALS-NO-DATA')}</p>}
      {view.series.map((s) => {
        const base = s.kind === 'HR' ? hrBaseline(view) : null;
        const g = chartGeometry(s.points, { width: W, height: H, from, windowMin: view.windowMin, baseline: base });
        const label = t('O-UI-VITALS-CHART', { kind: t(seriesCode(s.kind)), min: g.min, max: g.max });
        return (
          <figure key={s.kind} className="vitals-chart">
            <figcaption>
              {t(seriesCode(s.kind))}
              {s.kind === 'HR' && (
                <span className="muted small">
                  {' · '}
                  {base != null ? t('O-UI-VITALS-BASELINE', { value: base }) : t('O-UI-VITALS-NO-BASELINE')}
                </span>
              )}
            </figcaption>
            <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} preserveAspectRatio="none">
              {g.baselineY !== null && <line className="vitals-base" x1={0} x2={W} y1={g.baselineY} y2={g.baselineY} />}
              <path className="vitals-line" d={g.path} />
              {g.dots.map((d, i) => (
                <circle key={i} className="vitals-dot" cx={d.x} cy={d.y} r={1.8} />
              ))}
            </svg>
          </figure>
        );
      })}
      <p className="muted small">{t(view.noteCode)}</p>
    </section>
  );
}
