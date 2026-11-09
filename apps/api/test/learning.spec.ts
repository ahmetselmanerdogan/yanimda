import { describe, expect, it } from 'vitest';

import { type LearnOptions, learnThresholds } from '../src/modules/event/learning';
import { DAY, ist, type Persona, synth, TZ } from './support/synthetic';

/**
 * T-070 (D-06) öğrenme: son 14 günün özetinden uyku penceresi, uyanma saati ve hareketsizlik p95 (15–90 dk).
 * Kabul: sentetik 30 günlük veriyle eşikler beklenen aralıkta.
 */
const opts = (over: Partial<LearnOptions> = {}): LearnOptions => ({
  timezone: TZ,
  now: ist(30, 12),
  historyDays: 14,
  minDays: 7,
  percentile: 95,
  min: 15,
  max: 90,
  ...over,
});
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

describe('learnThresholds (sentetik 30 gün)', () => {
  const regular: Persona = {
    wake: [6, 50],
    bed: [22, 30],
    rests: [
      [10, 25],
      [14, 40],
      [19, 30],
    ],
    stepEveryMin: 5,
  };

  it('düzenli kişi: uyku ~23:00–07:00, hareketsizlik eşiği 35–55 dk', () => {
    const r = learnThresholds(synth(regular), opts());
    expect(r.days).toBeGreaterThanOrEqual(13);
    expect(r.days).toBeLessThanOrEqual(15);
    expect(r.sleep).not.toBeNull();
    expect(minutes(r.sleep!.start)).toBeGreaterThanOrEqual(22 * 60 + 30);
    expect(minutes(r.sleep!.start)).toBeLessThanOrEqual(23 * 60 + 30);
    expect(minutes(r.sleep!.end)).toBeGreaterThanOrEqual(6 * 60 + 30);
    expect(minutes(r.sleep!.end)).toBeLessThanOrEqual(7 * 60 + 15);
    expect(r.sleep!.end).toMatch(/^\d\d:(00|15|30|45)$/);
    expect(r.inactivityMin).toBeGreaterThanOrEqual(35);
    expect(r.inactivityMin).toBeLessThanOrEqual(55);
  });

  it('geç yatan / geç kalkan kişi: pencere kayar (01:00–09:30 civarı)', () => {
    const late: Persona = { ...regular, wake: [9, 30], bed: [0 + 24, 30] };
    const r = learnThresholds(synth(late), opts());
    expect(minutes(r.sleep!.start)).toBeGreaterThanOrEqual(60);
    expect(minutes(r.sleep!.start)).toBeLessThanOrEqual(2 * 60);
    expect(minutes(r.sleep!.end)).toBeGreaterThanOrEqual(9 * 60);
    expect(minutes(r.sleep!.end)).toBeLessThanOrEqual(10 * 60);
  });

  it('uzun oturan kişi: eşik üst sınırla (90) kırpılır; çok hareketli kişi: alt sınır (15) altına inmez', () => {
    const sitter: Persona = {
      ...regular,
      rests: [
        [9, 120],
        [13, 150],
        [17, 140],
        [20, 100],
      ],
    };
    expect(learnThresholds(synth(sitter), opts()).inactivityMin).toBe(90);
    const active: Persona = { ...regular, rests: [[10, 16], [11, 17], [12, 16], [13, 18], [14, 16], [15, 17], [16, 18], [17, 16], [18, 17], [19, 16]] }; // prettier-ignore
    const r = learnThresholds(synth(active), opts());
    expect(r.inactivityMin).toBeGreaterThanOrEqual(15);
    expect(r.inactivityMin).toBeLessThanOrEqual(25);
  });

  it('yalnız son 14 gün kullanılır (eski alışkanlık unutulur)', () => {
    const old = synth({ ...regular, wake: [10, 0], bed: [2 + 24, 0] }, 30).filter((s) => s.at < ist(14, 0));
    const recent = synth(regular, 30).filter((s) => s.at >= ist(14, 0));
    const r = learnThresholds([...old, ...recent], opts());
    expect(minutes(r.sleep!.end)).toBeLessThanOrEqual(7 * 60 + 15);
  });

  it('veri az (< minDays gün): öneri yok', () => {
    const r = learnThresholds(
      synth(regular, 30).filter((s) => s.at >= ist(26, 0)),
      opts(),
    );
    expect(r.days).toBeLessThan(7);
    expect(r).toMatchObject({ sleep: null, inactivityMin: null });
  });

  it('sinyal yok: gün 0, öneri yok', () => {
    expect(learnThresholds([], opts())).toEqual({ days: 0, sleep: null, inactivityMin: null });
  });

  it('gelecekteki ve pencereden eski örnekler sayılmaz', () => {
    const s = synth(regular, 30);
    const future = s.map((x) => ({ ...x, at: new Date(x.at.getTime() + 60 * DAY) }));
    expect(learnThresholds(future, opts()).days).toBe(0);
  });
});
