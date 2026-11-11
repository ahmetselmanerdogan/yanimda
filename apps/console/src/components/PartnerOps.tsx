import type { PartnerHealth, WorkOrder } from '@yanimda/contracts';
import { useCallback, useEffect, useState } from 'react';

import type { Api } from '../lib/api';
import { action, t } from '../lib/i18n';

const sec = (ms: number | null) => (ms === null ? null : Math.round(ms / 100) / 10);
const day = (iso: string) => new Date(iso).toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' });

/** Ortak satırı: son 1 saatte olay yoksa "olay yok", varsa p95 / p99 (sn) ve olay sayısı. */
export function partnerLine(p: PartnerHealth): string {
  return p.samples === 0 || p.p99Ms === null
    ? t('O-UI-SUP-PARTNER-NODATA', { partner: p.partner })
    : t('O-UI-SUP-PARTNER-ROW', { partner: p.partner, p95: sec(p.p95Ms), p99: sec(p.p99Ms), n: p.samples });
}

/** İş emri nedeni katalog kodu (bilinmeyen neden gösterilmez). */
export const workOrderReasonCode = (r: WorkOrder['reason']) =>
  r === 'LOW_BATTERY' ? 'O-UI-WO-LOW_BATTERY' : r === 'PREDICTED_END' ? 'O-UI-WO-PREDICTED_END' : null;

/**
 * T-085 OEM amir görünümü (docs/07 S2.7, S4.9, S7.2): ortak gecikmesi (son 1 saat p95 / p99, "zayıf" rozeti) ve açık
 * kolye pili iş emirleri ("Değiştirildi"). Sunum; veri `PartnerOpsPanel`'den.
 */
export function PartnerOpsView({
  partners,
  orders,
  busy,
  onDone,
}: {
  partners: PartnerHealth[];
  orders: WorkOrder[];
  busy?: boolean;
  onDone(id: string): void;
}) {
  return (
    <section className="sup-panel wide" data-testid="sup-partner-ops" aria-labelledby="sup-partners-title">
      <h2 id="sup-partners-title">{t('O-UI-SUP-PARTNERS')}</h2>
      <ul className="alert-list">
        {partners.map((p) => (
          <li key={p.partner} className={`alert-item${p.degradedSince ? ' a-O-QUEUE-UNCLAIMED' : ''}`}>
            <span className="small">{p.degradedSince ? t('O-UI-SUP-PARTNER-DEGRADED') : ''}</span>
            <span>{partnerLine(p)}</span>
            <span />
          </li>
        ))}
      </ul>
      <h2>
        {t('O-UI-SUP-WORK-ORDERS')} ({orders.length})
      </h2>
      {orders.length === 0 ? (
        <p className="muted">{t('O-UI-SUP-WORK-ORDERS-NONE')}</p>
      ) : (
        <ul className="alert-list" data-testid="work-orders">
          {orders.map((o) => {
            const reason = workOrderReasonCode(o.reason);
            return (
              <li key={o.id} className="alert-item">
                <span className="small">{reason ? t(reason) : ''}</span>
                <span>{t('O-UI-SUP-WORK-ORDER-ROW', { pct: o.batteryPct, due: day(o.dueAt) })}</span>
                <button
                  type="button"
                  disabled={busy}
                  title={t('O-UI-SUP-WORK-ORDER-DONE')}
                  onClick={() => onDone(o.id)}
                >
                  {action('O-UI-SUP-WORK-ORDER-DONE')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Amir panosunda: 60 sn'de bir yeniler; "Değiştirildi" iş emrini kapatır (denetimde). */
export function PartnerOpsPanel({ api, onError }: { api: Api; onError(message: string): void }) {
  const [partners, setPartners] = useState<PartnerHealth[]>([]);
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    void api.supervisorPartners().then(setPartners, () => undefined);
    void api.workOrders('OPEN').then(setOrders, () => undefined);
  }, [api]);
  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);
  const done = (id: string) => {
    setBusy(true);
    void api
      .completeWorkOrder(id)
      .then(load, (e: Error) => onError(e.message))
      .finally(() => setBusy(false));
  };
  return <PartnerOpsView partners={partners} orders={orders} busy={busy} onDone={done} />;
}
