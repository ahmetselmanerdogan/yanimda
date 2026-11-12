import type { VitalQuality, VitalSlice } from '@yanimda/contracts';
import { catalogs } from '@yanimda/messages';
import { describe, expect, it } from 'vitest';

import { DEFAULT_VITALS, loadRulePack, ruleFor, vitalsEnabled, vitalsOf } from '../src/modules/event/rules.loader';
import { deliveryFor, familyNoticeFor } from '../src/modules/notify/policy';
import {
  baselineOf,
  buckets,
  effectiveQuality,
  type EvalInput,
  evaluate,
  moved,
  type PersonVitals,
  skinTempStreak,
  sliceOf,
  type VitalPoint,
  weekStartOf,
  worsened,
} from '../src/modules/vitals/vitals';

/**
 * T-092 (docs/07 S6.3–S6.7, S10.1 aşama 3) değer kuralları — saf tablo testleri. Saat sabit (gün içi saatten bağımsız).
 */
const NOW = Date.parse('2026-11-09T11:00:00Z');
const v = DEFAULT_VITALS;
const min = (m: number) => NOW - m * 60_000;

interface P {
  dev?: string;
  q?: VitalQuality;
  slice?: VitalSlice;
  eligible?: boolean;
  worn?: boolean;
}
/** `n` örnek, son örnek şimdi, `every` dk arayla. */
const series = (values: number | number[], n: number, every = 1, o: P = {}): VitalPoint[] =>
  Array.from({ length: n }, (_, i) => ({
    deviceId: o.dev ?? 'watch',
    at: min((n - 1 - i) * every),
    value: Array.isArray(values) ? values[i]! : values,
    quality: o.q ?? 'Q2',
    slice: o.slice ?? 'REST',
    worn: o.worn ?? true,
    still: true,
    eligible: o.eligible ?? true,
  }));
const adult: PersonVitals = { learning: false, baseline: null };
const input = (over: Partial<EvalInput>): EvalInput => ({
  now: NOW,
  params: v,
  person: adult,
  hr: [],
  spo2: [],
  stillCombo: false,
  fallOpen: false,
  ...over,
});
const rules = (i: Partial<EvalInput>) => evaluate(input(i)).map((f) => `${f.rule}:P${f.priority}`);

describe('kural paketi ve bayrak (S6 giriş, S8.4)', () => {
  const pack = loadRulePack('TR');
  it('değer kuralları varsayılan KAPALI; eşikler pakette', () => {
    expect(pack.vitals?.enabled).toBe(false);
    expect(vitalsEnabled(pack, {})).toBe(false);
    expect(vitalsOf(pack)).toMatchObject({
      learnDays: 14,
      minValidDays: 7,
      sustainedMin: 10,
      comboMin: 5,
      cooldownH: 24,
      worsenPct: 20,
      maxChecksPerWeek: 2,
      claimSlaMin: 15,
      preconditions: { wornMin: 5, batteryPct: 10, stillSteps: 20, minSamples: 3, hrMin: 25, hrMax: 250 },
      hr: { low: 40, belowSleepBaseline: 10, highResting: 130, deviationPct: 30, deviationMin: 30 },
      spo2: { low: 88, lowCopd: 85, apartMin: 10, comboHr: 120 },
      skinTemp: { deltaC: 1, nights: 2 },
      retention: { rawDays: 30, summaryMonths: 13 },
    });
    expect(pack.version).toBeGreaterThanOrEqual(8);
  });
  it('VITALS_ENABLED paketi geçersiz kılar (true / false); başka değer paketi bırakır', () => {
    const on = { ...pack, vitals: { ...pack.vitals!, enabled: true } };
    expect(vitalsEnabled(pack, { VITALS_ENABLED: 'true' })).toBe(true);
    expect(vitalsEnabled(on, { VITALS_ENABLED: 'false' })).toBe(false);
    expect(vitalsEnabled(on, { VITALS_ENABLED: 'evet' })).toBe(true);
  });
  it('değer olayları: P3, cihaz sorusu yok; önce V-VITAL-ASK sesli ön eleme, sonra cihaz → telefon → 1. yakın', () => {
    for (const t of ['HEART_ANOMALY', 'SPO2_LOW'] as const) {
      const r = ruleFor(pack, t)!;
      expect(r).toMatchObject({ priority: 3, operatorScript: 'O-SCRIPT-VITALS' });
      expect(r.chain).toEqual(['CALL_WATCH', 'CALL_PHONE', 'CALL_CONTACT:1']);
      expect(r.devicePrompt).toBeUndefined();
      expect(r.autoVoiceScreening).toMatchObject({ enabled: true, phrase: 'V-VITAL-ASK', timeoutSec: 120 });
    }
  });
  it('aile "iyi" olmayan değer sonucunu görür (F-VITAL-RESULT); "iyi" sonuç ve kuyruk bildirimi yok', () => {
    const ev = (type: 'HEART_ANOMALY' | 'SPO2_LOW', outcome: string | null) => ({
      id: 'e',
      type,
      isTest: false,
      confirmedOutcome: outcome,
    });
    expect(familyNoticeFor(ev('HEART_ANOMALY', 'UNREACHABLE'), { from: 'CONTACT_CHAIN', to: 'CLOSED' })).toBe(
      'F-VITAL-RESULT',
    );
    expect(familyNoticeFor(ev('SPO2_LOW', 'EMERGENCY'), { from: 'DISPATCH', to: 'CLOSED' })).toBe('F-VITAL-RESULT');
    expect(familyNoticeFor(ev('HEART_ANOMALY', 'OK'), { from: 'CONFIRMED_OK', to: 'CLOSED' })).toBeNull();
    expect(familyNoticeFor(ev('HEART_ANOMALY', null), { to: 'OPERATOR_QUEUE' })).toBeNull();
    expect(deliveryFor('F-VITAL-TREND')).toMatchObject({ urgency: 'INFO', smsFallbackSec: null });
  });
  it('S6.9: katalogda yasak iddia ve klinik skor adı yok', () => {
    const forbidden = [
      /tespit eder/i,
      /tıbbi izlem/i,
      /hayati bulgu/i,
      /doktora haber/i,
      /doktor takibi/i,
      /\bNEWS2?\b/,
      /kalp krizi/i,
      /ritim bozukluğu/i,
      /oksijen düşüklüğünü/i,
      /teşhis/i,
    ];
    const hits = Object.entries(catalogs.tr as Record<string, { text: string }>)
      .filter(([, m]) => forbidden.some((re) => re.test(m.text)))
      .map(([k]) => k);
    expect(hits).toEqual([]);
  });
});

describe('ortak şartlar ve süreklilik (S6.4, S6.5, S10.1)', () => {
  it('10 dk süreklilik olmadan uyarı yok: 9 dk düşük nabız → yok, 10 dk → P3', () => {
    expect(rules({ hr: series(38, 10) })).toEqual([]); // 0..9 dk
    expect(rules({ hr: series(38, 11) })).toEqual(['LOW_HR:P3']);
  });
  it('en az 3 tutarlı örnek: 10 dk arayla 2 örnek yetmez; 5 dk arayla 3 örnek yeter', () => {
    expect(rules({ hr: series(38, 2, 10) })).toEqual([]);
    expect(rules({ hr: series(38, 3, 5) })).toEqual(['LOW_HR:P3']);
  });
  it('süreklilik kopukluğu (> 5 dk boşluk) veya araya giren normal okuma süreyi sıfırlar', () => {
    expect(rules({ hr: series(38, 3, 6) })).toEqual([]);
    expect(rules({ hr: series([38, 38, 38, 38, 38, 60, 38, 38, 38, 38, 38], 11) })).toEqual([]);
  });
  it('takılı / hareketsiz / şarjda değil / pil şartı sağlanmayan örnek (eligible=false) kural çalıştırmaz', () => {
    expect(rules({ hr: series(38, 15, 1, { eligible: false }) })).toEqual([]);
    expect(rules({ hr: series(150, 15, 1, { eligible: false }) })).toEqual([]);
  });
  it("bayat veri (en yeni örnek 5 dk'dan eski) tetiklemez", () => {
    const old = series(38, 15).map((p) => ({ ...p, at: p.at - 6 * 60_000 }));
    expect(rules({ hr: old })).toEqual([]);
  });
  it('öğrenme süresinde değer olayı yok (yalnız düşme vurgusu)', () => {
    const person = { learning: true, baseline: null };
    expect(rules({ person, hr: series(35, 15), stillCombo: true })).toEqual([]);
    expect(rules({ person, hr: series(35, 15), fallOpen: true })).toEqual(['FALL_HR_HIGHLIGHT:P1']);
  });
});

describe('nabız kuralları (S6.4)', () => {
  it('düşük nabız + hiçbir cihazda hareket yok ≥5 dk → P2, kuyruğun başına (her saatte, gece dahil)', () => {
    const f = evaluate(input({ hr: series(36, 6, 1, { slice: 'SLEEP' }), stillCombo: true }));
    expect(f).toEqual([
      expect.objectContaining({
        rule: 'LOW_HR_STILL',
        priority: 2,
        target: 'OPERATOR',
        eventType: 'HEART_ANOMALY',
        headOfQueue: true,
        value: 36,
      }),
    ]);
    expect(rules({ hr: series(36, 5), stillCombo: true })).toEqual([]); // 4 dk
    expect(rules({ hr: series(36, 6), stillCombo: false })).toEqual([]); // hareket var, 10 dk değil
  });
  it('düşük nabız: <40 ve uyku tabanının 10 altında; taban yoksa genel eşik', () => {
    const base = (SLEEP: number): PersonVitals => ({ learning: false, baseline: { SLEEP } });
    expect(rules({ person: base(45), hr: series(36, 11) })).toEqual([]); // 45 − 10 = 35'in üstünde
    expect(rules({ person: base(45), hr: series(35, 11) })).toEqual(['LOW_HR:P3']);
    expect(rules({ person: base(45), hr: series(39, 11) })).toEqual([]);
    expect(rules({ hr: series(39, 11) })).toEqual(['LOW_HR:P3']);
    expect(rules({ hr: series(40, 11) })).toEqual([]); // "<40"
  });
  it('yüksek nabız: dinlenirken ≥130 ≥10 dk → P3; hareketli dilimde yok', () => {
    expect(rules({ hr: series(130, 11) })).toEqual(['HIGH_HR:P3']);
    expect(rules({ hr: series(129, 11) })).toEqual([]);
    expect(rules({ hr: series(140, 11, 1, { slice: 'ACTIVE' }) })).toEqual([]);
  });
  it('taban çizgisinden ±%30 ≥30 dk → yalnız aileye P4 eğilim (operatör yok); taban yoksa çalışmaz', () => {
    const person: PersonVitals = { learning: false, baseline: { REST: 70 } };
    const f = evaluate(input({ person, hr: series(92, 31) }));
    expect(f.map((x) => [x.rule, x.target, x.priority])).toEqual([['HR_BASELINE_DEVIATION', 'FAMILY', 4]]);
    expect(rules({ person, hr: series(92, 30) })).toEqual([]);
    expect(rules({ person, hr: series(90, 31) })).toEqual([]); // %28,6
    expect(rules({ hr: series(92, 31) })).toEqual([]);
  });
  it('kişiye özel eşik (aile onayı + doktor notu) genel eşiğin yerine geçer', () => {
    const person: PersonVitals = { learning: false, baseline: null, overrides: { lowHr: 35, highHr: 150 } };
    expect(rules({ person, hr: series(38, 11) })).toEqual([]);
    expect(rules({ person, hr: series(140, 11) })).toEqual([]);
    expect(rules({ person, hr: series(34, 11) })).toEqual(['LOW_HR:P3']);
  });
  it('düşme + alışılmadık nabız → P1 kalır, operatöre vurgu (hareket şartı yok)', () => {
    const hr = series(150, 3, 1, { eligible: false });
    expect(rules({ hr, fallOpen: true })).toEqual(['FALL_HR_HIGHLIGHT:P1']);
    expect(rules({ hr: series(80, 3), fallOpen: true })).toEqual([]);
    expect(rules({ hr: series(150, 3, 1, { worn: false, eligible: false }), fallOpen: true })).toEqual([]);
  });
});

describe('kalite (S6.6): Q3 tek başına olay açmaz', () => {
  it('yüzük (Q3) tek başına: nabız ve oksijen olayı yok, aileye eğilim var', () => {
    expect(rules({ hr: series(36, 15, 1, { q: 'Q3', dev: 'ring' }), stillCombo: true })).toEqual([]);
    expect(rules({ spo2: series(85, 11, 1, { q: 'Q3', dev: 'ring' }) })).toEqual([]);
    const person: PersonVitals = { learning: false, baseline: { REST: 70 } };
    expect(rules({ person, hr: series(95, 31, 1, { q: 'Q3', dev: 'ring' }) })).toEqual(['HR_BASELINE_DEVIATION:P4']);
  });
  it('iki cihaz 5 dk içinde uyuşursa bir basamak güçlenir: iki Q3 → Q2 (olay açabilir)', () => {
    const spo2 = [...series(85, 11, 1, { q: 'Q3', dev: 'ring' }), ...series(86, 11, 1, { q: 'Q3', dev: 'ear' })];
    expect(rules({ spo2 })).toEqual(['SPO2_LOW:P3']);
    const p = spo2[0]!;
    expect(effectiveQuality(p, spo2, 5 * 60_000, (a, b) => Math.abs(a - b) <= 3)).toBe('Q2');
    expect(effectiveQuality({ ...p, quality: 'Q1' }, [p], 5 * 60_000, () => true)).toBe('Q2'); // tek cihaz en çok Q2
    const q2 = { ...p, quality: 'Q2' as const };
    expect(effectiveQuality(q2, [q2, { ...q2, deviceId: 'x' }], 5 * 60_000, () => true)).toBe('Q1');
    expect(effectiveQuality(q2, [q2, { ...q2, deviceId: 'x', value: 70 }], 5 * 60_000, (a, b) => a === b)).toBe('Q2');
  });
});

describe('oksijen (S6.4)', () => {
  it('≤%88, uyanık ve hareketsiz, 10 dk arayla 2 okuma, Q2 → P3; nabız ≥120 ile P2', () => {
    expect(rules({ spo2: series(88, 2, 10) })).toEqual(['SPO2_LOW:P3']);
    expect(rules({ spo2: series(88, 2, 9) })).toEqual([]); // 10 dk arayla değil
    expect(rules({ spo2: series(89, 2, 10) })).toEqual([]);
    expect(rules({ spo2: series([86, 93, 86], 3, 5) })).toEqual([]); // arada normal okuma
    expect(rules({ spo2: series(86, 2, 10), hr: series(125, 3) })).toEqual(['SPO2_LOW_HR:P2']);
  });
  it('uykuda veya hareketliyken (eligible=false) yok', () => {
    expect(rules({ spo2: series(85, 2, 10, { slice: 'SLEEP' }) })).toEqual([]);
    expect(rules({ spo2: series(85, 2, 10, { eligible: false }) })).toEqual([]);
  });
  it('KOAH profili: eşik ≤%85', () => {
    const person: PersonVitals = { learning: false, baseline: null, overrides: { copd: true } };
    expect(rules({ person, spo2: series(87, 2, 10) })).toEqual([]);
    expect(rules({ person, spo2: series(85, 2, 10) })).toEqual(['SPO2_LOW:P3']);
  });
});

describe('yardımcılar', () => {
  it("%20 kötüleşme: düşük nabız aşağı, yüksek nabız yukarı, oksijen %100'e uzaklık", () => {
    expect(worsened('LOW_HR', 30, 38, 20)).toBe(true);
    expect(worsened('LOW_HR', 31, 38, 20)).toBe(false);
    expect(worsened('HIGH_HR', 162, 135, 20)).toBe(true);
    expect(worsened('HIGH_HR', 160, 135, 20)).toBe(false);
    expect(worsened('SPO2_LOW', 85, 88, 20)).toBe(true); // 15 ≥ 14,4
    expect(worsened('SPO2_LOW', 86, 88, 20)).toBe(false);
  });
  it('hareket: herhangi bir cihazda pencere içinde ≥20 adım; sayaç sıfırlanması', () => {
    const c = (deviceId: string, m: number, value: number) => ({ deviceId, at: min(m), value });
    expect(moved([c('w', 6, 1000), c('w', 2, 1015)], min(5), NOW, 20)).toBe(false);
    expect(moved([c('w', 6, 1000), c('w', 2, 1025)], min(5), NOW, 20)).toBe(true);
    expect(moved([c('w', 6, 1000), c('p', 6, 50), c('p', 1, 80)], min(5), NOW, 20)).toBe(true);
    expect(moved([c('w', 6, 5000), c('w', 1, 30)], min(5), NOW, 20)).toBe(true); // gece yarısı sıfırlandı
    expect(moved([], min(5), NOW, 20)).toBe(false);
  });
  it('dilim: cihaz bağlamı, yoksa uyku penceresi / hareketsizlik', () => {
    expect(sliceOf('SLEEP', false, false)).toBe('SLEEP');
    expect(sliceOf('ACTIVE', true, true)).toBe('ACTIVE');
    expect(sliceOf(undefined, true, false)).toBe('SLEEP');
    expect(sliceOf(undefined, false, true)).toBe('REST');
    expect(sliceOf(undefined, false, false)).toBe('ACTIVE');
  });
  it('taban çizgisi: ≥7 geçerli gün (gün ≥ validDaySamples), yalnız takılı + hareketsiz + ≥Q2; dilim ayrı', () => {
    const day = (d: number, value: number, o: Partial<VitalPoint> = {}) =>
      Array.from({ length: 30 }, (_, i) => ({
        at: Date.parse('2026-10-01T09:00:00Z') + d * 86_400_000 + i * 60_000,
        value,
        quality: 'Q2' as VitalQuality,
        slice: 'REST' as VitalSlice,
        worn: true,
        still: true,
        eligible: true,
        ...o,
      }));
    const six = [0, 1, 2, 3, 4, 5].flatMap((d) => day(d, 60 + d));
    expect(baselineOf(six, 'Europe/Istanbul', v)).toEqual([]);
    const seven = [...six, ...day(6, 70), ...day(7, 90, { quality: 'Q3' }), ...day(8, 90, { still: false })];
    expect(baselineOf(seven, 'Europe/Istanbul', v)).toEqual([{ slice: 'REST', median: 63, validDays: 7 }]);
  });
  it('5 dk ortancalar (ham dakika verisi çıkmaz); hafta başı; cilt sıcaklığı iki gece', () => {
    const pts = [0, 1, 2, 3, 4, 5, 6].map((m) => ({ at: min(10) + m * 60_000, value: 60 + m }));
    expect(buckets(pts, min(10), 5)).toEqual([
      { at: new Date(min(10)).toISOString(), value: 62, n: 5 },
      { at: new Date(min(5)).toISOString(), value: 65.5, n: 2 },
    ]);
    expect(weekStartOf('2026-11-12')).toBe('2026-11-09');
    expect(weekStartOf('2026-11-09')).toBe('2026-11-09');
    const n = (day: string, value: number) => ({ day, value });
    expect(skinTempStreak([n('2026-11-01', 1.1), n('2026-11-02', 1.0)], 1, 2)).toBe(true);
    expect(skinTempStreak([n('2026-11-01', 1.1), n('2026-11-03', 1.2)], 1, 2)).toBe(false);
    expect(skinTempStreak([n('2026-11-01', 1.1), n('2026-11-02', 0.4), n('2026-11-03', 1.2)], 1, 2)).toBe(false);
  });
});
