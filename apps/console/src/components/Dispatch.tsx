import { useCallback, useEffect, useState } from 'react';

import {
  type Api,
  ApiError,
  DISPATCH_STAGES,
  type DispatchSource,
  type DispatchStage,
  type DispatchUpdate,
  type DispatchView,
} from '../lib/api';
import { t } from '../lib/i18n';

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
const SOURCES: Exclude<DispatchSource, 'SYSTEM'>[] = ['EMS', 'OPERATOR', 'FAMILY'];

/** Sıradaki aşamalar (ileri; iptal her an). */
export function nextStages(cur: DispatchStage): DispatchStage[] {
  if (cur === 'COMPLETED' || cur === 'CANCELLED') return [];
  const i = DISPATCH_STAGES.indexOf(cur as (typeof DISPATCH_STAGES)[number]);
  return [...DISPATCH_STAGES.slice(i + 1), 'CANCELLED'];
}

/**
 * 112 süreci paneli: aşama zaman çizelgesi, sıradaki aşama düğmeleri, vaka no / tahmini varış / hastane / not ve
 * bilgi kaynağı. Olay kapalıyken de (amir panosu) güncellenir; 15 sn'de bir yenilenir.
 */
export function DispatchPanel({ api, eventId, initial }: { api: Api; eventId: string; initial?: DispatchView }) {
  const [v, setV] = useState<DispatchView | null>(initial ?? null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({ caseRef: '', etaMin: '', hospital: '', note: '' });
  const [source, setSource] = useState<Exclude<DispatchSource, 'SYSTEM'>>('EMS');

  const load = useCallback(async () => {
    try {
      const d = await api.dispatch(eventId);
      setV(d);
      setMissing(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setMissing(true);
    }
  }, [api, eventId]);
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 15_000);
    return () => clearInterval(id);
  }, [load]);
  const caseRef = v?.caseRef ?? '';
  const etaMin = v?.etaMin?.toString() ?? '';
  const hospital = v?.hospital ?? '';
  useEffect(() => setForm((f) => ({ ...f, caseRef, etaMin, hospital })), [caseRef, etaMin, hospital]);

  if (missing || !v) return null;
  const save = async (status?: DispatchStage) => {
    setBusy(true);
    setErr(null);
    const b: DispatchUpdate = { source };
    if (status) b.status = status;
    if (form.caseRef !== (v.caseRef ?? '')) b.caseRef = form.caseRef || null;
    if (form.hospital !== (v.hospital ?? '')) b.hospital = form.hospital || null;
    if (form.etaMin !== (v.etaMin?.toString() ?? '')) b.etaMin = form.etaMin === '' ? null : Number(form.etaMin);
    if (form.note.trim()) b.note = form.note.trim();
    try {
      setV(await api.updateDispatch(eventId, b));
      setForm((f) => ({ ...f, note: '' }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const next = nextStages(v.status);
  return (
    <section className="dispatch" aria-labelledby={`dispatch-${eventId}`} data-testid="dispatch">
      <h2 id={`dispatch-${eventId}`}>
        {t('O-UI-DISPATCH')} ·{' '}
        <span className={`dispatch-status d-${v.status}`}>{t(`O-DISPATCH-STAGE-${v.status}`)}</span>
        {v.arrivalMin !== null && (
          <span className="muted small"> · {t('O-UI-DISPATCH-ARRIVAL', { min: v.arrivalMin })}</span>
        )}
        {v.arrivalLate && v.arrivalMin === null && <span className="badge-late"> {t('O-UI-DISPATCH-LATE')}</span>}
      </h2>
      <ol className="dispatch-stages">
        {[...DISPATCH_STAGES, 'CANCELLED' as const]
          .filter((s) => v.stages[s])
          .map((s) => (
            <li key={s}>
              <time>{hhmm(v.stages[s]!)}</time> {t(`O-DISPATCH-STAGE-${s}`)}
            </li>
          ))}
      </ol>
      {v.open && (
        <>
          <div className="row dispatch-next">
            {next.map((s) => (
              <button
                key={s}
                type="button"
                className={s === 'CANCELLED' ? 'danger' : s === next[0] ? 'primary' : ''}
                disabled={busy}
                onClick={() => void save(s)}
              >
                {t(`O-DISPATCH-STAGE-${s}`)}
              </button>
            ))}
          </div>
          <div className="dispatch-fields">
            <label>
              {t('O-UI-DISPATCH-CASE')}
              <input
                value={form.caseRef}
                maxLength={64}
                onChange={(e) => setForm({ ...form, caseRef: e.target.value })}
              />
            </label>
            <label>
              {t('O-UI-DISPATCH-ETA')}
              <input
                inputMode="numeric"
                value={form.etaMin}
                onChange={(e) => setForm({ ...form, etaMin: e.target.value.replace(/\D/g, '').slice(0, 3) })}
              />
            </label>
            <label>
              {t('O-UI-DISPATCH-HOSPITAL')}
              <input
                value={form.hospital}
                maxLength={160}
                onChange={(e) => setForm({ ...form, hospital: e.target.value })}
              />
            </label>
            <label>
              {t('O-UI-DISPATCH-SOURCE')}
              <select value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
                {SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {t(`O-UI-DISPATCH-SOURCE-${s}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="wide">
              {t('O-UI-DISPATCH-NOTE')}
              <textarea
                rows={2}
                maxLength={1000}
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
              />
            </label>
          </div>
          <div className="row end">
            <button type="button" disabled={busy} onClick={() => void save()}>
              {t('O-UI-DISPATCH-SAVE')}
            </button>
          </div>
        </>
      )}
      {v.timeline.some((x) => x.note) && (
        <ul className="dispatch-notes small">
          {v.timeline
            .filter((x) => x.note)
            .map((x, i) => (
              <li key={i}>
                <time>{hhmm(x.at)}</time> · {t(`O-UI-DISPATCH-SOURCE-${x.source}`)}: {x.note}
              </li>
            ))}
        </ul>
      )}
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
    </section>
  );
}
