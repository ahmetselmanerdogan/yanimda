import type { VitalReview } from '@yanimda/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { t } from '../lib/i18n';
import { reviewLine, VitalReviewsView } from './VitalReviews';

/** T-092 (docs/07 S6.7) amirin değer eşiği incelemesi kuyruğu: kişi, kural, neden; değer yok, metinler katalogdan. */
const review = (o: Partial<VitalReview> = {}): VitalReview => ({
  id: '00000000-0000-0000-0000-0000000000r1',
  protectedPersonId: 'pp-1',
  name: 'Ayşe Demo',
  rule: 'HIGH_HR',
  reason: 'WEEKLY_LIMIT',
  note: null,
  createdAt: '2026-11-12T10:00:00.000Z',
  resolvedAt: null,
  resolvedBy: null,
  ...o,
});

describe('Değer eşiği incelemeleri (amir)', () => {
  it('satır: ad, kuralın katalog adı, tarih; ad yoksa "bilinmiyor"', () => {
    expect(reviewLine(review())).toBe(
      t('O-UI-SUP-VITAL-REVIEW-ROW', {
        name: 'Ayşe Demo',
        rule: t('O-UI-VITAL-RULE-HIGH_HR'),
        date: new Date('2026-11-12T10:00:00.000Z').toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' }),
      }),
    );
    expect(reviewLine(review({ name: null }))).toContain(t('O-UI-UNKNOWN'));
  });

  it('neden rozeti ve "İncelendi" düğmesi; liste boşsa panel hiç çizilmez (özellik kapalıyken gürültü yok)', () => {
    const html = renderToStaticMarkup(
      createElement(VitalReviewsView, {
        reviews: [review(), review({ id: 'r2', rule: 'SPO2_LOW', reason: 'FALSE_ALARMS' })],
        onResolve: () => undefined,
      }),
    );
    expect(html).toContain(t('O-UI-SUP-VITAL-REVIEWS'));
    expect(html).toContain(t('O-UI-VITAL-REVIEW-WEEKLY_LIMIT'));
    expect(html).toContain(t('O-UI-VITAL-REVIEW-FALSE_ALARMS'));
    expect(html).toContain(t('O-UI-VITAL-RULE-SPO2_LOW'));
    expect(html).toContain('İncelendi');
    expect(html).not.toMatch(/\d{2,3} ?(bpm|%)/);
    expect(renderToStaticMarkup(createElement(VitalReviewsView, { reviews: [], onResolve: () => undefined }))).toBe('');
  });
});
