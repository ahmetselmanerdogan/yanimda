import type { VitalQuality, VitalRule } from '@yanimda/contracts';
import catalog from '@yanimda/messages/tr.json';
import { describe, expect, it } from 'vitest';

import type { QueueItem } from './api';
import { queueReducer } from './queue';
import { chartGeometry, hrBaseline, qualityCode, ruleCode, seriesCode } from './vitals';

/** T-092 (S6.8, S7.1) değer grafiği yardımcıları ve P2 değer kombinasyonunun kuyruk sırası. */
const FROM = Date.parse('2026-11-09T09:00:00.000Z');
const at = (min: number) => new Date(FROM + min * 60_000).toISOString();

describe('değer grafiği', () => {
  it('noktalar zaman ve değer eksenine yerleşir; taban çizgisi aralığa dahil; değer yukarı doğru artar', () => {
    const g = chartGeometry(
      [
        { at: at(0), value: 60 },
        { at: at(60), value: 80 },
        { at: at(120), value: 70 },
      ],
      { width: 100, height: 50, from: FROM, windowMin: 120, baseline: 50, pad: 0 },
    );
    expect(g.dots.map((d) => d.x)).toEqual([0, 50, 100]);
    expect(g.dots[1]!.y).toBeLessThan(g.dots[0]!.y); // 80 > 60 → daha yukarıda
    expect(g.baselineY).toBeGreaterThan(g.dots[0]!.y); // taban 50 en altta
    expect(g.path).toMatch(/^M 0 [\d.]+ L 50 [\d.]+ L 100 [\d.]+$/);
    expect([g.min, g.max]).toEqual([60, 80]);
  });
  it('tek nokta kısa çizgi; boş seri; pencere dışı zaman kenara kırpılır', () => {
    const one = chartGeometry([{ at: at(30), value: 40 }], { width: 100, height: 50, from: FROM, windowMin: 120 });
    expect(one.path).toMatch(/^M [\d.]+ [\d.]+ L [\d.]+ [\d.]+$/);
    expect(one.baselineY).toBeNull();
    expect(chartGeometry([], { width: 100, height: 50, from: FROM, windowMin: 120 }).path).toBe('');
    const late = chartGeometry([{ at: at(500), value: 40 }], {
      width: 100,
      height: 50,
      from: FROM,
      windowMin: 120,
      pad: 0,
    });
    expect(late.dots[0]!.x).toBe(100);
  });
  it('nabız tabanı: dinlenme, yoksa uyku', () => {
    expect(hrBaseline({ baseline: { HR: { REST: 68, SLEEP: 55 } } })).toBe(68);
    expect(hrBaseline({ baseline: { HR: { SLEEP: 55 } } })).toBe(55);
    expect(hrBaseline({ baseline: null })).toBeNull();
  });
  it('dinamik kodlar katalogda (kalite, kural, seri, not)', () => {
    const qs: VitalQuality[] = ['Q1', 'Q2', 'Q3'];
    const rules: VitalRule[] = [
      'LOW_HR_STILL',
      'LOW_HR',
      'HIGH_HR',
      'HR_BASELINE_DEVIATION',
      'SPO2_LOW',
      'SPO2_LOW_HR',
      'FALL_HR_HIGHLIGHT',
    ];
    const codes = [
      ...qs.map(qualityCode),
      ...rules.map(ruleCode),
      seriesCode('HR'),
      seriesCode('SPO2'),
      'O-UI-VITALS-NOTE',
      'O-TYPE-SPO2_LOW',
      'O-VITAL-UNCLAIMED',
    ];
    expect(codes.filter((c) => !(c in catalog))).toEqual([]);
  });
});

describe('kuyruk sırası (T-092 S6.4)', () => {
  const item = (id: string, priority: number, createdAt: string, headOfQueue = false): QueueItem => ({
    eventId: id,
    type: 'HEART_ANOMALY',
    priority,
    state: 'OPERATOR_QUEUE',
    createdAt,
    escalatedAt: createdAt,
    lockedBy: null,
    lockUntil: null,
    isTest: false,
    headOfQueue,
    person: null,
  });
  it('P2 değer kombinasyonu aynı öncelikte önce; P1 her zaman önde', () => {
    const s = queueReducer(
      { items: [] },
      {
        type: 'snapshot',
        items: [item('a', 2, at(0)), item('b', 2, at(5), true), item('c', 1, at(10))],
      },
    );
    expect(s.items.map((i) => i.eventId)).toEqual(['c', 'b', 'a']);
  });
});
