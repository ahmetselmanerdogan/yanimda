import type { CoverageDay, CoverageLevel, CoverageSegment } from '@yanimda/contracts';

import { hhmm, inRange, tzOffsetMin } from './coverage';

/**
 * T-085 (docs/07 S7.3, S7.4) uyanık zaman kapsama yüzdesi ve kapsama zaman çizelgesi — saf fonksiyonlar.
 * Kaynak event.coverage_history: her satır o andan sonraki seviyeyi verir (reasons ON_HOLD içeriyorsa "hastanede /
 * seyahatte" modu). Uyanık dakika = kişinin gece penceresi dışı (event.threshold, kişinin saat diliminde). Uyanık
 * dakikalar korunan (FULL / BASIC), yalnız telefon (PHONE_ONLY) ve YOK (NONE) diye sayılır; hold dakikaları ve geçmişi
 * bilinmeyen dakikalar (ilk satırdan önce, uyanıkken NIGHT görülen tarama gecikmesi) yüzdeye girmez.
 */
export interface HistoryRow {
  at: Date;
  level: CoverageLevel;
  reasons: string[];
}
export interface Span {
  from: Date;
  to: Date;
  level: CoverageLevel;
  hold: boolean;
}
export interface SleepRange {
  timezone: string;
  start: string;
  end: string;
}

/**
 * Satırlar (artan sırada; `from` öncesindeki son satır dahil) → [from, to) aralığına kırpılmış dilimler. Ardışık aynı
 * seviye + hold dilimleri birleşir. İlk satırdan önceki süre dilim değildir (bilinmiyor).
 */
export function spansOf(rows: HistoryRow[], from: Date, to: Date): Span[] {
  const out: Span[] = [];
  const sorted = [...rows].sort((a, b) => a.at.getTime() - b.at.getTime());
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i]!;
    const next = sorted[i + 1]?.at ?? to;
    const a = r.at > from ? r.at : from;
    const b = next < to ? next : to;
    if (b <= a) continue;
    const hold = r.reasons.includes('ON_HOLD');
    const last = out[out.length - 1];
    if (last && last.level === r.level && last.hold === hold && last.to.getTime() === a.getTime()) last.to = b;
    else out.push({ from: a, to: b, level: r.level, hold });
  }
  return out;
}

export const toSegments = (spans: Span[]): CoverageSegment[] =>
  spans.map((s) => ({ from: s.from.toISOString(), to: s.to.toISOString(), level: s.level, hold: s.hold }));

const pctOf = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
const dateOf = (localMs: number) => new Date(localMs).toISOString().slice(0, 10);

/**
 * Yerel gün başına uyanık dakika dağılımı. `from`–`to` arasındaki her yerel gün (boş olsa da) bir satırdır.
 * Saat dilimi farkı saat başına bir kez alınır (yaz saati geçişi saat çözünürlüğünde).
 */
export function dailyCoverage(spans: Span[], from: Date, to: Date, sleep: SleepRange): CoverageDay[] {
  const [ss, se] = [hhmm(sleep.start), hhmm(sleep.end)];
  const days = new Map<string, CoverageDay>();
  const day = (d: string) => {
    let x = days.get(d);
    if (!x) {
      x = {
        date: d,
        awakeMin: 0,
        protectedMin: 0,
        phoneOnlyMin: 0,
        noneMin: 0,
        holdMin: 0,
        unknownMin: 0,
        protectedPct: null,
        phoneOnlyPct: null,
        nonePct: null,
      };
      days.set(d, x);
    }
    return x;
  };
  const start = Math.ceil(from.getTime() / 60_000) * 60_000;
  const end = to.getTime();
  let hourKey = -1;
  let offset = 0;
  let si = 0;
  for (let t = start; t < end; t += 60_000) {
    const hk = Math.floor(t / 3_600_000);
    if (hk !== hourKey) {
      hourKey = hk;
      offset = tzOffsetMin(new Date(t), sleep.timezone);
    }
    const local = t + offset * 60_000;
    const d = day(dateOf(local));
    const minute = Math.floor((local % 86_400_000) / 60_000);
    if (inRange(minute, ss, se)) continue;
    d.awakeMin++;
    while (si < spans.length && spans[si]!.to.getTime() <= t) si++;
    const s = spans[si];
    if (!s || s.from.getTime() > t) d.unknownMin++;
    else if (s.hold) d.holdMin++;
    else if (s.level === 'FULL' || s.level === 'BASIC') d.protectedMin++;
    else if (s.level === 'PHONE_ONLY') d.phoneOnlyMin++;
    else if (s.level === 'NONE') d.noneMin++;
    else d.unknownMin++; // uyanıkken NIGHT: tarama gecikmesi
  }
  const out = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const d of out) {
    const measured = d.protectedMin + d.phoneOnlyMin + d.noneMin;
    d.protectedPct = pctOf(d.protectedMin, measured);
    d.phoneOnlyPct = pctOf(d.phoneOnlyMin, measured);
    d.nonePct = pctOf(d.noneMin, measured);
  }
  return out;
}

/** Günlerin toplamı (yüzdeler toplam ölçülen dakikaya göre). */
export function summarize(days: CoverageDay[]): Omit<CoverageDay, 'date'> {
  const sum = (k: 'awakeMin' | 'protectedMin' | 'phoneOnlyMin' | 'noneMin' | 'holdMin' | 'unknownMin') =>
    days.reduce((a, d) => a + d[k], 0);
  const protectedMin = sum('protectedMin');
  const phoneOnlyMin = sum('phoneOnlyMin');
  const noneMin = sum('noneMin');
  const measured = protectedMin + phoneOnlyMin + noneMin;
  return {
    awakeMin: sum('awakeMin'),
    protectedMin,
    phoneOnlyMin,
    noneMin,
    holdMin: sum('holdMin'),
    unknownMin: sum('unknownMin'),
    protectedPct: pctOf(protectedMin, measured),
    phoneOnlyPct: pctOf(phoneOnlyMin, measured),
    nonePct: pctOf(noneMin, measured),
  };
}

/** Kişinin yerel `days` gününün başı: bugünün yerel gece yarısından `days - 1` gün önce (UTC an). */
export function windowStart(now: Date, days: number, timezone: string): Date {
  const off = tzOffsetMin(now, timezone);
  const local = now.getTime() + off * 60_000;
  const midnight = local - (local % 86_400_000);
  const startLocal = midnight - (days - 1) * 86_400_000;
  return new Date(startLocal - tzOffsetMin(new Date(startLocal - off * 60_000), timezone) * 60_000);
}
