import type { VitalContext, VitalQuality, VitalRule, VitalSlice } from '@yanimda/contracts';

import type { VitalsParams } from '../event/rules.loader';

/**
 * T-092 (docs/07 S6) değer kuralları — saf fonksiyonlar, tablo testiyle sabitlenir (test/vitals-rules.spec.ts).
 * Anormal değer teşhis değildir: "cihaz alışılmadık bir okuma gösterdi, kişiyi arayalım" tetikleyicisidir.
 *
 *  - Ortak şartlar (S6.4): örnek geldiği anda cihaz takılı, şarjda değil, ≥ wornMin dk takılı, pil ≥ batteryPct ve son
 *    stillMin dk'da hiçbir cihazda stillSteps adımdan az (örneğin `eligible` alanı); en az minSamples tutarlı örnek,
 *    aralar ≤ maxGapMin (süreklilik); 25–250 dışı nabız hiç kaydedilmez.
 *  - Kalite (S6.6): tek cihaz en çok Q2 sayılır; agreeMin dk içinde başka bir cihaz uyuşursa bir basamak güçlenir.
 *    Olay açan kurallar Q2 veya daha iyisini ister — Q3 (yüzük / kulak) tek başına hiçbir olay açmaz, yalnız aileye
 *    eğilime girer.
 *  - Öğrenme (S6.3, S10.1): ilk örnekten sonra learnDays boyunca değer olayı yok (yalnız düşme vurgusu).
 *  - Taban çizgisi oluşana kadar genel eşikler; düşük nabız kuralının "uyku tabanının 10 altında" koşulu taban
 *    yoksa aranmaz, tabandan sapma kuralı hiç çalışmaz.
 */
export type VitalKind = 'HR' | 'SPO2' | 'SKIN_TEMP';

export interface VitalPoint {
  deviceId: string;
  /** ms */
  at: number;
  value: number;
  /** Kayıtlı kalite (cihazın bildirdiği ile katalog kalitesinin kötüsü). */
  quality: VitalQuality;
  slice: VitalSlice;
  worn: boolean;
  still: boolean;
  /** Ortak şartlar örnek anında sağlanıyordu (takılı, şarjda değil, ≥5 dk takılı, pil, hareketsiz). */
  eligible: boolean;
}

export interface PersonVitals {
  /** Öğrenme süresinde (ilk örnekten sonra learnDays): değer olayı yok. */
  learning: boolean;
  /** Nabız taban çizgisi (dilim ortancaları); oluşmadıysa null. */
  baseline: Partial<Record<VitalSlice, number>> | null;
  /** S6.7 kişiye özel eşikler (aile onayı + doktor notu işaretiyle); KOAH profili oksijen eşiğini düşürür. */
  overrides?: { lowHr?: number | null; highHr?: number | null; spo2Low?: number | null; copd?: boolean };
}

export interface EvalInput {
  now: number;
  params: VitalsParams;
  person: PersonVitals;
  /** Son ~1 saatin nabız örnekleri (tüm cihazlar). */
  hr: VitalPoint[];
  /** Son ~1 saatin oksijen örnekleri (tüm cihazlar). */
  spo2: VitalPoint[];
  /** Son comboMin dk'da hiçbir cihazda hareket yok (adım sayacı hiç artmadı, ACTIVE bağlamı yok). */
  stillCombo: boolean;
  /** Kişinin açık bir düşme olayı var (S6.4 son satır: P1 kalır, operatöre vurgu). */
  fallOpen: boolean;
}

export type FindingTarget = 'OPERATOR' | 'FAMILY' | 'HIGHLIGHT';
export interface Finding {
  rule: VitalRule;
  target: FindingTarget;
  priority: 1 | 2 | 3 | 4;
  eventType?: 'HEART_ANOMALY' | 'SPO2_LOW';
  /** Kuyruğun başına (P2 kombinasyon). */
  headOfQueue?: boolean;
  /** Temsilî okuma (tutarlı okumanın ortancası). */
  value: number;
  /** Tutarlı okumanın başladığı an (ms): aynı süren okuma ikinci kez tetiklemez. */
  runStart: number;
  quality: VitalQuality;
}

const RANK: Record<VitalQuality, number> = { Q1: 1, Q2: 2, Q3: 3 };
const OF_RANK: VitalQuality[] = ['Q1', 'Q1', 'Q2', 'Q3'];
export const qualityRank = (q: VitalQuality) => RANK[q];
/** İki kalitenin kötüsü (cihazın bildirdiği katalogdan iyi olamaz). */
export const worseQuality = (a: VitalQuality, b: VitalQuality): VitalQuality => (RANK[a] >= RANK[b] ? a : b);
export const bestQuality = (qs: VitalQuality[]): VitalQuality | null =>
  qs.length ? qs.reduce((m, q) => (RANK[q] < RANK[m] ? q : m)) : null;

export const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * S6.6 etkin kalite: tek cihaz en çok Q2; agreeMin içinde başka cihazın uyuşan okuması varsa bir basamak güçlü.
 */
export function effectiveQuality(
  p: VitalPoint,
  all: VitalPoint[],
  agreeMs: number,
  agrees: (a: number, b: number) => boolean,
): VitalQuality {
  let r = Math.max(RANK[p.quality], 2);
  if (all.some((o) => o.deviceId !== p.deviceId && Math.abs(o.at - p.at) <= agreeMs && agrees(o.value, p.value)))
    r -= 1;
  return OF_RANK[r]!;
}

/** Ölçüm dilimi: cihaz bağlamı varsa o, yoksa uyku penceresi → SLEEP, hareketsiz → REST, aksi ACTIVE. */
export function sliceOf(context: VitalContext | undefined, inSleepWindow: boolean, still: boolean): VitalSlice {
  if (context === 'SLEEP') return 'SLEEP';
  if (context === 'ACTIVE') return 'ACTIVE';
  if (context === 'RESTING') return inSleepWindow ? 'SLEEP' : 'REST';
  return inSleepWindow ? 'SLEEP' : still ? 'REST' : 'ACTIVE';
}

interface Run {
  start: number;
  end: number;
  points: VitalPoint[];
}

/**
 * Bir cihazın en yeni örneğinden geriye kesintisiz ihlal: her örnek `ok`'u sağlar, aralar ≤ maxGap, en yeni örnek
 * şimdiden en çok maxGap önce. En az minSamples örnek yoksa null.
 */
function breachRun(points: VitalPoint[], ok: (p: VitalPoint) => boolean, now: number, v: VitalsParams): Run | null {
  const maxGap = v.preconditions.maxGapMin * 60_000;
  const desc = [...points].sort((a, b) => b.at - a.at);
  if (!desc.length || now - desc[0]!.at > maxGap) return null;
  const run: VitalPoint[] = [];
  for (const p of desc) {
    if (!ok(p)) break;
    if (run.length && run[run.length - 1]!.at - p.at > maxGap) break;
    run.push(p);
  }
  if (run.length < v.preconditions.minSamples) return null;
  return { start: run[run.length - 1]!.at, end: run[0]!.at, points: run };
}

const byDevice = (ps: VitalPoint[]) => {
  const m = new Map<string, VitalPoint[]>();
  for (const p of ps) m.set(p.deviceId, [...(m.get(p.deviceId) ?? []), p]);
  return [...m.values()];
};

/** Cihaz başına en uzun tutarlı ihlal (süre ≥ minMin). */
function longestRun(
  points: VitalPoint[],
  ok: (p: VitalPoint) => boolean,
  minMin: number,
  now: number,
  v: VitalsParams,
): Run | null {
  let best: Run | null = null;
  for (const dev of byDevice(points)) {
    const r = breachRun(dev, ok, now, v);
    if (r && r.end - r.start >= minMin * 60_000 && (!best || r.end - r.start > best.end - best.start)) best = r;
  }
  return best;
}

export interface Thresholds {
  lowHr: number;
  highHr: number;
  spo2Low: number;
}
export function thresholdsOf(v: VitalsParams, person: PersonVitals): Thresholds {
  const o = person.overrides ?? {};
  return {
    lowHr: o.lowHr ?? v.hr.low,
    highHr: o.highHr ?? v.hr.highResting,
    spo2Low: o.spo2Low ?? (o.copd ? v.spo2.lowCopd : v.spo2.low),
  };
}

/** S6.4 tablosu. Bulgular yorgunluk sınırlarından (S6.7) önceki ham sonuçtur; servis sınırları uygular. */
export function evaluate(input: EvalInput): Finding[] {
  const { now, params: v, person } = input;
  const thr = thresholdsOf(v, person);
  const agreeMs = v.agreeMin * 60_000;
  const hrAgree = (a: number, b: number) => Math.abs(a - b) <= (Math.max(a, b) * v.hr.agreePct) / 100;
  const spoAgree = (a: number, b: number) => Math.abs(a - b) <= v.spo2.agreePts;
  const hrQ = new Map(input.hr.map((p) => [p, effectiveQuality(p, input.hr, agreeMs, hrAgree)]));
  const spoQ = new Map(input.spo2.map((p) => [p, effectiveQuality(p, input.spo2, agreeMs, spoAgree)]));
  const strong = (q: VitalQuality | undefined) => !!q && RANK[q] <= 2;
  const out: Finding[] = [];
  const finding = (
    rule: VitalRule,
    target: FindingTarget,
    priority: Finding['priority'],
    run: Run,
    qualities: Map<VitalPoint, VitalQuality>,
    extra: Partial<Finding> = {},
  ): Finding => ({
    rule,
    target,
    priority,
    value: Math.round(median(run.points.map((p) => p.value)) * 10) / 10,
    runStart: run.start,
    quality: bestQuality(run.points.map((p) => qualities.get(p)!))!,
    ...extra,
  });

  // Düşme + alışılmadık nabız (S6.4): olay P1 kalır, operatöre vurgu. Hareket şartı aranmaz (düşme sonrası).
  if (input.fallOpen) {
    const odd = (p: VitalPoint) => p.worn && (p.value < thr.lowHr || p.value >= thr.highHr);
    const run = longestRun(input.hr, odd, 0, now, v);
    if (run) out.push(finding('FALL_HR_HIGHLIGHT', 'HIGHLIGHT', 1, run, hrQ));
  }
  if (person.learning) return out; // S10.1: öğrenme süresinde değer olayı yok

  // Nabız kuralları: ortak şartlar + olay için en az Q2.
  const hrOk = (p: VitalPoint) => p.eligible && strong(hrQ.get(p));
  const low = (p: VitalPoint) => hrOk(p) && p.value < thr.lowHr;
  const combo = input.stillCombo ? longestRun(input.hr, low, v.comboMin, now, v) : null;
  if (combo)
    out.push(finding('LOW_HR_STILL', 'OPERATOR', 2, combo, hrQ, { eventType: 'HEART_ANOMALY', headOfQueue: true }));
  else {
    const sleepBase = person.baseline?.SLEEP;
    const lowVsSleep = (p: VitalPoint) =>
      low(p) && (sleepBase === undefined || p.value <= sleepBase - v.hr.belowSleepBaseline);
    const run = longestRun(input.hr, lowVsSleep, v.sustainedMin, now, v);
    if (run) out.push(finding('LOW_HR', 'OPERATOR', 3, run, hrQ, { eventType: 'HEART_ANOMALY' }));
  }
  const high = (p: VitalPoint) => hrOk(p) && p.slice !== 'ACTIVE' && p.value >= thr.highHr;
  const highRun = longestRun(input.hr, high, v.sustainedMin, now, v);
  if (highRun) out.push(finding('HIGH_HR', 'OPERATOR', 3, highRun, hrQ, { eventType: 'HEART_ANOMALY' }));

  // Taban çizgisinden sapma (yalnız aileye P4 eğilim): dinlenme dilimi, Q3 de eğilime girer.
  const restBase = person.baseline?.REST;
  if (restBase) {
    const dev = (p: VitalPoint) =>
      p.eligible && p.slice === 'REST' && Math.abs(p.value - restBase) / restBase >= v.hr.deviationPct / 100;
    const run = longestRun(input.hr, dev, v.hr.deviationMin, now, v);
    if (run) out.push(finding('HR_BASELINE_DEVIATION', 'FAMILY', 4, run, hrQ));
  }

  // Oksijen: uyanık ve hareketsiz, apartMin arayla iki okuma ≤ eşik (arada eşik üstü okuma yok), Q2 cihaz veya iki
  // cihaz uyumlu (etkin kalite ≤ Q2). Aynı anda nabız ≥ comboHr ise P2.
  const spoOk = (p: VitalPoint) => p.eligible && p.slice !== 'SLEEP' && strong(spoQ.get(p));
  const spo = input.spo2.filter(spoOk).sort((a, b) => b.at - a.at);
  const maxGap = v.preconditions.maxGapMin * 60_000;
  const latest = spo[0];
  if (latest && now - latest.at <= maxGap && latest.value <= thr.spo2Low) {
    const run: VitalPoint[] = [];
    let first: VitalPoint | undefined;
    for (const p of spo) {
      if (p.value > thr.spo2Low) break;
      run.push(p);
      if (latest.at - p.at >= v.spo2.apartMin * 60_000) {
        first = p;
        break;
      }
    }
    if (first && latest.at - first.at <= 2 * v.spo2.apartMin * 60_000) {
      const r: Run = { start: first.at, end: latest.at, points: run };
      const recentHr = input.hr.filter((p) => p.eligible && now - p.at <= maxGap).map((p) => p.value);
      const fast = recentHr.length > 0 && median(recentHr) >= v.spo2.comboHr;
      out.push(
        fast
          ? finding('SPO2_LOW_HR', 'OPERATOR', 2, r, spoQ, { eventType: 'SPO2_LOW' })
          : finding('SPO2_LOW', 'OPERATOR', 3, r, spoQ, { eventType: 'SPO2_LOW' }),
      );
    }
  }
  return out;
}

/**
 * S6.7 sessizlik delinmesi: okuma, operatörün "iyi" dediği okumadan worsenPct daha kötü mü. Düşük nabız aşağı,
 * yüksek nabız yukarı, oksijen %100'e uzaklık olarak ölçülür.
 */
export function worsened(rule: VitalRule, value: number, ref: number, worsenPct: number): boolean {
  const f = worsenPct / 100;
  switch (rule) {
    case 'LOW_HR':
    case 'LOW_HR_STILL':
      return value <= ref * (1 - f);
    case 'HIGH_HR':
      return value >= ref * (1 + f);
    case 'SPO2_LOW':
    case 'SPO2_LOW_HR':
      return 100 - value >= (100 - ref) * (1 + f);
    default:
      return false;
  }
}

/**
 * Adım sayaçlarından hareket (S6.4 "son 5 dk'da 20 adımdan az"): cihazlar günlük kümülatif sayaç gönderir. Cihaz başına
 * pencere içindeki artış = penceredeki en büyük değer − pencere başındaki son değer (yoksa penceredeki ilk değer);
 * sayaç sıfırlandıysa penceredeki en büyük değer. Herhangi bir cihazda artış ≥ steps → hareket var.
 */
export function moved(
  counters: { deviceId: string; at: number; value: number }[],
  from: number,
  to: number,
  steps: number,
): boolean {
  for (const pts of groupBy(counters, (c) => c.deviceId)) {
    const sorted = pts.sort((a, b) => a.at - b.at);
    const before = sorted.filter((p) => p.at <= from).pop();
    const inside = sorted.filter((p) => p.at > from && p.at <= to);
    if (!inside.length) continue;
    const max = Math.max(...inside.map((p) => p.value));
    const base = before?.value ?? inside[0]!.value;
    const delta = max >= base ? max - base : max;
    if (delta >= steps) return true;
  }
  return false;
}

function groupBy<T>(xs: T[], key: (x: T) => string): T[][] {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return [...m.values()];
}

/** Kişinin yerel günü (YYYY-MM-DD). */
export function localDay(at: Date, timeZone: string): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    at,
  );
  return p;
}

/**
 * S6.3 taban çizgisi: dilim başına gün ortancası, yalnız takılı + (uyku/dinlenmede) hareketsiz + ≥ Q2 örneklerle;
 * gün geçerliyse (≥ validDaySamples örnek) sayılır; en az minValidDays geçerli gün yoksa o dilimde taban yok.
 */
export function baselineOf(
  samples: Pick<VitalPoint, 'at' | 'value' | 'quality' | 'slice' | 'worn' | 'still' | 'eligible'>[],
  timeZone: string,
  v: VitalsParams,
): { slice: VitalSlice; median: number; validDays: number }[] {
  const out: { slice: VitalSlice; median: number; validDays: number }[] = [];
  for (const slice of ['SLEEP', 'REST', 'ACTIVE'] as const) {
    const use = samples.filter(
      (s) => s.slice === slice && s.worn && RANK[s.quality] <= 2 && (slice === 'ACTIVE' ? true : s.eligible && s.still),
    );
    const days = groupBy(use, (s) => localDay(new Date(s.at), timeZone))
      .filter((d) => d.length >= v.validDaySamples)
      .map((d) => median(d.map((s) => s.value)));
    if (days.length >= v.minValidDays)
      out.push({ slice, median: Math.round(median(days) * 10) / 10, validDays: days.length });
  }
  return out;
}

/** Operatör grafiği (S6.8): bucketMin dk'lık ortancalar; dakika düzeyinde ham veri dışarı çıkmaz. */
export function buckets(
  points: { at: number; value: number }[],
  from: number,
  bucketMin: number,
): { at: string; value: number; n: number }[] {
  const size = bucketMin * 60_000;
  const m = new Map<number, number[]>();
  for (const p of points) {
    if (p.at < from) continue;
    const b = from + Math.floor((p.at - from) / size) * size;
    m.set(b, [...(m.get(b) ?? []), p.value]);
  }
  return [...m.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([b, vs]) => ({ at: new Date(b).toISOString(), value: Math.round(median(vs) * 10) / 10, n: vs.length }));
}

/** Haftanın başı (Pazartesi, kişinin yerel günü YYYY-MM-DD). */
export function weekStartOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - dow * 86_400_000).toISOString().slice(0, 10);
}

/** Cilt sıcaklığı (S6.4): ardışık `nights` gece ≥ deltaC sapma var mı (gün sırasıyla gece değerleri). */
export function skinTempStreak(nights: { day: string; value: number }[], deltaC: number, need: number): boolean {
  const sorted = [...nights].sort((a, b) => a.day.localeCompare(b.day));
  let streak = 0;
  let prev: string | null = null;
  for (const n of sorted) {
    const consecutive =
      prev !== null && Date.parse(`${n.day}T00:00:00Z`) - Date.parse(`${prev}T00:00:00Z`) === 86_400_000;
    streak = n.value >= deltaC ? (consecutive && streak > 0 ? streak + 1 : 1) : 0;
    if (streak >= need) return true;
    prev = n.day;
  }
  return false;
}
