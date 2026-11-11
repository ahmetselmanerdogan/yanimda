import type { CoverageReason, PartnerHealth, WorkOrder } from '@yanimda/contracts';
import catalog from '@yanimda/messages/tr.json';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { reasonCode } from '../lib/devices';
import { t } from '../lib/i18n';
import { partnerLine, PartnerOpsView, workOrderReasonCode } from './PartnerOps';

/**
 * T-085 OEM amir görünümü (docs/07 S2.7, S4.9, S7.2): ortak gecikmesi ve kolye pili iş emirleri; metinler katalogdan.
 */
const partner = (o: Partial<PartnerHealth> = {}): PartnerHealth => ({
  partner: 'FAKE_PENDANT',
  samples: 42,
  p95Ms: 8_400,
  p99Ms: 71_250,
  degradedSince: '2026-11-12T10:00:00.000Z',
  checkedAt: '2026-11-12T10:05:00.000Z',
  ...o,
});
const order = (o: Partial<WorkOrder> = {}): WorkOrder => ({
  id: '00000000-0000-0000-0000-0000000000a1',
  kind: 'PENDANT_BATTERY',
  status: 'OPEN',
  reason: 'LOW_BATTERY',
  deviceId: '00000000-0000-0000-0000-0000000000d1',
  protectedPersonId: '00000000-0000-0000-0000-0000000000p1',
  batteryPct: 18,
  predictedEndAt: null,
  dueAt: '2026-11-26T10:00:00.000Z',
  createdAt: '2026-11-12T10:00:00.000Z',
  closedAt: null,
  ...o,
});

describe('Ortak gecikmesi ve kolye iş emirleri (amir)', () => {
  it('ortak satırı: p95 / p99 saniye, olay yoksa "olay yok"', () => {
    expect(partnerLine(partner())).toBe('FAKE_PENDANT: p95 8.4 sn, p99 71.3 sn (42 olay)');
    expect(partnerLine(partner({ samples: 0, p95Ms: null, p99Ms: null }))).toBe(
      t('O-UI-SUP-PARTNER-NODATA', { partner: 'FAKE_PENDANT' }),
    );
  });

  it('bozuk ortak "Zayıf" rozetiyle; açık iş emri nedeni, pil ve son tarih; düğme katalogdan', () => {
    const html = renderToStaticMarkup(
      createElement(PartnerOpsView, {
        partners: [partner()],
        orders: [order(), order({ id: 'x', reason: 'PREDICTED_END', batteryPct: 24 })],
        onDone: () => undefined,
      }),
    );
    expect(html).toContain(t('O-UI-SUP-PARTNER-DEGRADED'));
    expect(html).toContain(t('O-UI-WO-LOW_BATTERY').replace("'", '&#x27;'));
    expect(html).toContain(t('O-UI-WO-PREDICTED_END'));
    expect(html).toContain('Pil %18');
    expect(html).toContain('Değiştirildi');
    const none = renderToStaticMarkup(
      createElement(PartnerOpsView, {
        partners: [partner({ degradedSince: null })],
        orders: [],
        onDone: () => undefined,
      }),
    );
    expect(none).toContain(t('O-UI-SUP-WORK-ORDERS-NONE'));
    expect(none).not.toContain(t('O-UI-SUP-PARTNER-DEGRADED'));
  });

  it('dinamik kodlar katalogda: yeni kapsama nedenleri, boşluk nedeni NOT_WORN, iş emri nedenleri, ortak uyarısı', () => {
    const reasons: CoverageReason[] = ['PARTNER_LATENCY', 'HOME_UNIT_POWER_LOSS', 'LINE_LOSS'];
    const codes = [
      ...reasons.map(reasonCode),
      'O-UI-GAP-NOT_WORN',
      ...(['LOW_BATTERY', 'PREDICTED_END'] as const).map((r) => workOrderReasonCode(r)!),
      'O-OEM-LATENCY',
      'O-TYPE-PARTNER',
    ];
    expect(codes.filter((c) => !(c in catalog))).toEqual([]);
    expect(workOrderReasonCode('X' as never)).toBeNull();
  });
});
