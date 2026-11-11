import type { CoverageView, DeviceSummary } from '@yanimda/contracts';
import { useCallback, useEffect, useState } from 'react';

import type { Api, DeviceCommandType, EventRecord } from '../lib/api';
import {
  categoryCode,
  deviceLabel,
  gapReasonCode,
  levelCode,
  reasonCode,
  ringAllTargets,
  seenText,
  stripOrder,
  voiceText,
} from '../lib/devices';
import { t } from '../lib/i18n';

const REFRESH_MS = 30_000;

/**
 * T-089 (docs/07 S7.1) olay ekranı: kişinin kapsama rozeti (seviye + nedenler), KAPSAMA BOŞLUĞU nedeni ve cihaz
 * şeridi (kategori/ad, pil, şarj, takılı, bağlı/son görülme, sesli arama sırası, olayı açan / iptal eden). Olay
 * operatördeyken komutlar: "Tümünü çaldır", "Bu cihazı çaldır", "Soru gönder", "Konum iste"
 * (`POST /v1/devices/{id}/commands`; sunucu açık olayı ve yetkiyi denetler, denetime yazar).
 */
export function DevicePanel({
  api,
  event,
  mine,
  now,
  onError,
}: {
  api: Api;
  event: EventRecord;
  /** Olay bu operatörde ve açık: komut düğmeleri. */
  mine: boolean;
  now: number;
  onError(message: string): void;
}) {
  const personId = event.protectedPersonId;
  const [view, setView] = useState<CoverageView | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api.coverage(personId).then(
        (v) => setView(v),
        () => setView(null), // kapsama yoksa (simülatör kişisi, yetki) şerit gösterilmez
      ),
    [api, personId],
  );
  useEffect(() => {
    setView(null);
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const send = async (targets: DeviceSummary[], type: DeviceCommandType) => {
    setBusy(true);
    setNote(null);
    try {
      const lines: string[] = [];
      for (const d of targets) {
        const r = await api.deviceCommand(d.id, type, event.id);
        lines.push(t(r.sent ? 'O-UI-DEV-SENT' : 'O-UI-DEV-UNSUPPORTED', { device: deviceLabel(d) }));
      }
      setNote(lines.join(' · '));
      void load();
    } catch (e) {
      onError(t('O-UI-ERROR', { detail: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const gap = event.type === 'COVERAGE_GAP' ? gapReasonCode(event.transitions) : null;
  if (!view) return null;
  const devices = stripOrder(view.devices);
  const ringAll = ringAllTargets(devices);
  const sources = new Set(event.sourceDeviceIds ?? []);
  return (
    <section className="devices" aria-labelledby="devices-title" data-testid="devices">
      <header className="devices-head">
        <h2 id="devices-title">{t('O-UI-DEVICES')}</h2>
        <span className={`coverage-badge c-${view.level}`} data-testid="coverage-level">
          {t('O-UI-COVERAGE')}: {t(levelCode(view.level))}
        </span>
        {view.reasons.length > 0 && (
          <span className="muted small" data-testid="coverage-reasons">
            {view.reasons.map((r) => t(reasonCode(r))).join(' · ')}
          </span>
        )}
        {mine && (
          <button
            type="button"
            className="ring-all"
            disabled={busy || ringAll.length === 0}
            onClick={() => void send(ringAll, 'RING')}
          >
            {t('O-UI-DEV-RING-ALL')}
          </button>
        )}
      </header>
      {gap && (
        <p className="gap-reason" data-testid="gap-reason">
          {t('O-UI-GAP-REASON', { reason: t(gap) })}
        </p>
      )}
      {note && (
        <p className="muted small" role="status">
          {note}
        </p>
      )}
      {devices.length === 0 ? (
        <p className="muted">{t('O-UI-DEV-NONE')}</p>
      ) : (
        <ul className="device-strip">
          {devices.map((d) => (
            <DeviceRow
              key={d.id}
              d={d}
              now={now}
              source={sources.has(d.id)}
              cancelled={event.cancelledByDeviceId === d.id}
              actions={mine}
              busy={busy}
              onCommand={(type) => void send([d], type)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function DeviceRow(p: {
  d: DeviceSummary;
  now: number;
  source: boolean;
  cancelled: boolean;
  actions: boolean;
  busy: boolean;
  onCommand(type: DeviceCommandType): void;
}) {
  const { d } = p;
  const voice = voiceText(d);
  return (
    <li className={`device${d.online ? '' : ' offline'}`} data-testid={`device-${d.category}`}>
      <div className="device-name">
        <strong>{deviceLabel(d)}</strong>
        {d.nickname && <span className="muted small"> · {t(categoryCode(d.category))}</span>}
      </div>
      <div className="device-facts small">
        {d.batteryPct !== null && <span>{t('O-UI-DEV-BATTERY', { pct: d.batteryPct })}</span>}
        {d.charging && <span className="warn">{t('O-UI-DEV-CHARGING')}</span>}
        {d.onBody !== null && (
          <span className={d.onBody ? '' : 'warn'}>{t(d.onBody ? 'O-UI-DEV-WORN' : 'O-UI-DEV-NOT-WORN')}</span>
        )}
        <span className={d.online ? 'ok' : 'warn'}>{t(d.online ? 'O-UI-DEV-ONLINE' : 'O-UI-DEV-OFFLINE')}</span>
        <span className="muted">{seenText(d.lastSeenAt, p.now)}</span>
        {voice && <span className="badge-voice">{voice}</span>}
        {p.source && <span className="badge-source">{t('O-UI-DEV-SOURCE')}</span>}
        {p.cancelled && <span className="badge-source">{t('O-UI-DEV-CANCELLED')}</span>}
      </div>
      {p.actions && (
        <div className="row device-actions">
          <button type="button" disabled={p.busy} onClick={() => p.onCommand('RING')}>
            {t('O-UI-DEV-RING')}
          </button>
          <button type="button" disabled={p.busy} onClick={() => p.onCommand('PROMPT')}>
            {t('O-UI-DEV-PROMPT')}
          </button>
          <button type="button" disabled={p.busy} onClick={() => p.onCommand('LOCATE')}>
            {t('O-UI-DEV-LOCATE')}
          </button>
        </div>
      )}
    </li>
  );
}
