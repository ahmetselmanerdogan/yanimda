/**
 * T-070 (D-06) öğrenme: son `historyDays` günün sinyal özetinden kişiye özel eşikler. Saf fonksiyon; cihaz bilmez,
 * yalnız sinyal türlerine bakar (hareket = STEPS > 0).
 *
 *  - Uyku penceresi: kişinin saat diliminde her saat için "dinlenme" (hareketsiz; saat bilekte değilken de hareket
 *    yoktur) günlerinin oranı; günlerin çoğunda dinlenme olan saatlerin (mod) en uzun döngüsel dizisi.
 *    Başlangıç = dizinin ilk saati.
 *  - Uyanma saati: her gün dizinin bitişi çevresindeki (±3 saat) ilk hareketin ortancası, 15 dk'ya yuvarlanmış.
 *  - Hareketsizlik eşiği: uyanık saatlerde iki hareket arasındaki ≥ `min` dk boşlukların `percentile` yüzdeliği,
 *    [min, max] aralığına kırpılmış. Yeterli boşluk yoksa öneri yok (varsayılan kalır).
 *  - `minDays` günden az veri: öneri yok.
 */
export interface ActivitySample {
  at: Date;
  kind: string;
  value: number | null;
}
export interface LearnOptions {
  timezone: string;
  now: Date;
  historyDays: number;
  minDays: number;
  percentile: number;
  /** Hareketsizlik eşiğinin sınırları (kural paketi thresholdMin.min / max). */
  min: number;
  max: number;
}
export interface Learned {
  /** Sinyal görülen gün sayısı. */
  days: number;
  sleep: { start: string; end: string } | null;
  inactivityMin: number | null;
}

const DAY_MIN = 1440;
/** p95 için asgari boşluk sayısı; daha azıyla öneri yapılmaz. */
const MIN_GAPS = 10;
const WAKE_SEARCH_MIN = 180;

const hhmm = (m: number) => {
  const x = ((Math.round(m) % DAY_MIN) + DAY_MIN) % DAY_MIN;
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
};
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
/** En yakın sıra yöntemi. */
export const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)]!;
};

/** Duvar saati: yerel tarih (gün anahtarı) ve gün içi dakika. */
function wallClock(timeZone: string) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return (at: Date) => {
    const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
  };
}

/** [start, end) döngüsel dakika aralığında mı (gece yarısını aşabilir). */
const inWindow = (m: number, start: number, end: number) =>
  start <= end ? m >= start && m < end : m >= start || m < end;

export function learnThresholds(samples: ActivitySample[], o: LearnOptions): Learned {
  const from = o.now.getTime() - o.historyDays * DAY_MIN * 60_000;
  const clock = wallClock(o.timezone);
  const recent = samples
    .filter((s) => s.at.getTime() >= from && s.at.getTime() <= o.now.getTime())
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const moves = recent
    .filter((s) => s.kind === 'STEPS' && (s.value ?? 0) > 0)
    .map((s) => ({ t: s.at.getTime(), ...clock(s.at) }));
  const days = new Set(recent.map((s) => clock(s.at).date));
  const none: Learned = { days: days.size, sleep: null, inactivityMin: null };
  if (days.size < o.minDays || !moves.length) return none;

  // 1. Saat başına dinlenme oranı → çoğunluk (mod) dinlenme saatleri → en uzun döngüsel dizi.
  const activeHours = new Map<string, Set<number>>();
  for (const m of moves) {
    const set = activeHours.get(m.date) ?? new Set<number>();
    set.add(Math.floor(m.minute / 60));
    activeHours.set(m.date, set);
  }
  const rest = Array.from({ length: 24 }, (_, h) => {
    let n = 0;
    for (const d of days) if (!activeHours.get(d)?.has(h)) n++;
    return n / days.size > 0.5;
  });
  let best = { start: -1, len: 0 };
  for (let s = 0; s < 24; s++) {
    if (!rest[s] || rest[(s + 23) % 24]) continue; // dizi başı değil
    let len = 0;
    while (len < 24 && rest[(s + len) % 24]) len++;
    if (len > best.len) best = { start: s, len };
  }
  let sleep: Learned['sleep'] = null;
  if (best.len > 0 && best.len < 24) {
    const startMin = best.start * 60;
    const endMin = ((best.start + best.len) % 24) * 60;
    // 2. Uyanma: her gün bitiş çevresindeki ilk hareket.
    const wakes = new Map<string, number>();
    for (const m of moves) {
      const delta = (((m.minute - endMin) % DAY_MIN) + DAY_MIN + WAKE_SEARCH_MIN) % DAY_MIN; // endMin−180 → 0
      if (delta >= 2 * WAKE_SEARCH_MIN) continue;
      const prev = wakes.get(m.date);
      if (prev === undefined || delta < prev) wakes.set(m.date, delta);
    }
    const wake = wakes.size ? endMin - WAKE_SEARCH_MIN + median([...wakes.values()]) : endMin;
    sleep = { start: hhmm(startMin), end: hhmm(Math.round(wake / 15) * 15) };
  }

  // 3. Uyanık saatlerdeki hareketsizlik boşlukları (uykuya taşan boşluk sayılmaz).
  const win = sleep ?? null;
  const s0 = win ? Number(win.start.slice(0, 2)) * 60 + Number(win.start.slice(3)) : 0;
  const e0 = win ? Number(win.end.slice(0, 2)) * 60 + Number(win.end.slice(3)) : 0;
  const gaps: number[] = [];
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1]!;
    const gap = (moves[i]!.t - a.t) / 60_000;
    if (gap < o.min) continue;
    if (win) {
      if (inWindow(a.minute, s0, e0)) continue;
      const untilSleep = (s0 - a.minute + DAY_MIN) % DAY_MIN;
      if (gap > untilSleep) continue;
    } else if (gap > DAY_MIN / 2) continue;
    gaps.push(gap);
  }
  const inactivityMin =
    gaps.length >= MIN_GAPS ? Math.min(o.max, Math.max(o.min, Math.round(percentile(gaps, o.percentile)))) : null;
  return { days: days.size, sleep, inactivityMin };
}
