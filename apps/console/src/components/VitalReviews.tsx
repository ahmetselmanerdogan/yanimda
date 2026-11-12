import type { VitalReview } from '@yanimda/contracts';
import { useCallback, useEffect, useState } from 'react';

import type { Api } from '../lib/api';
import { action, has, t } from '../lib/i18n';

const day = (iso: string) => new Date(iso).toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' });
const ruleName = (r: VitalReview['rule']) =>
  has(`O-UI-VITAL-RULE-${r}`) ? t(`O-UI-VITAL-RULE-${r}`) : t('O-UI-UNKNOWN');

/** İnceleme satırı: kişi, kuralın adı, açıldığı gün (değer yazılmaz). */
export function reviewLine(r: VitalReview): string {
  return t('O-UI-SUP-VITAL-REVIEW-ROW', {
    name: r.name ?? t('O-UI-UNKNOWN'),
    rule: ruleName(r.rule),
    date: day(r.createdAt),
  });
}

/**
 * T-092 (docs/07 S6.7) amirin değer eşiği incelemesi kuyruğu: haftada 2'den fazla değer kaynaklı kontrol araması ve
 * değerlerde tekrarlayan yanlış alarm. Açık inceleme yoksa (değer kuralları kapalıyken hep) panel çizilmez.
 */
export function VitalReviewsView({
  reviews,
  busy,
  onResolve,
}: {
  reviews: VitalReview[];
  busy?: boolean;
  onResolve(id: string): void;
}) {
  if (reviews.length === 0) return null;
  return (
    <section className="sup-panel wide" data-testid="sup-vital-reviews" aria-labelledby="sup-vital-reviews-title">
      <h2 id="sup-vital-reviews-title">
        {t('O-UI-SUP-VITAL-REVIEWS')} ({reviews.length})
      </h2>
      <ul className="alert-list">
        {reviews.map((r) => (
          <li key={r.id} className="alert-item">
            <span className="small">{t(`O-UI-VITAL-REVIEW-${r.reason}`)}</span>
            <span>{reviewLine(r)}</span>
            <button
              type="button"
              disabled={busy}
              title={t('O-UI-SUP-VITAL-REVIEW-DONE')}
              onClick={() => onResolve(r.id)}
            >
              {action('O-UI-SUP-VITAL-REVIEW-DONE')}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Amir panosunda: 60 sn'de bir yeniler; "İncelendi" incelemeyi kapatır (denetimde). */
export function VitalReviewsPanel({ api, onError }: { api: Api; onError(message: string): void }) {
  const [reviews, setReviews] = useState<VitalReview[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => void api.vitalReviews().then(setReviews, () => undefined), [api]);
  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);
  const resolve = (id: string) => {
    setBusy(true);
    void api
      .resolveVitalReview(id)
      .then(load, (e: Error) => onError(e.message))
      .finally(() => setBusy(false));
  };
  return <VitalReviewsView reviews={reviews} busy={busy} onResolve={resolve} />;
}
