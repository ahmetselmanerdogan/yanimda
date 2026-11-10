/**
 * Düzenli arama zamanlaması — saf fonksiyonlar (tablo testiyle sabitlenir). Saatler KİŞİNİN saat diliminde.
 */
export type Frequency = 'DAILY' | 'WEEKLY' | 'BIWEEKLY';
export interface PlanFacts {
  frequency: Frequency;
  /** ISO hafta günü 1 (Pzt) … 7 (Paz). */
  weekday: number;
  localTime: string;
  timezone: string;
}

const parts = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  })
    .formatToParts(at)
    .reduce<Record<string, string>>((a, p) => ((a[p.type] = p.value), a), {});

/** `timeZone`'daki duvar saati (yıl, ay, gün, ss:dd) → UTC anı (yaz saati dahil). */
export function zonedToUtc(y: number, m: number, d: number, hhmm: string, timeZone: string): Date {
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  // Saat dilimi farkını iki adımda düzelt (DST sınırında da doğru).
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const p = parts(new Date(t), timeZone);
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    t += guess - asUtc;
  }
  return new Date(t);
}

const ISO_DAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** `after`'dan SONRAKİ ilk planlı an (UTC). BIWEEKLY: ISO hafta numarası çift olan haftalar. */
export function nextDue(plan: PlanFacts, after: Date): Date {
  const p = parts(after, plan.timezone);
  for (let i = 0; i < 21; i++) {
    const day = new Date(Date.UTC(+p.year, +p.month - 1, +p.day + i));
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    const at = zonedToUtc(y, m, d, plan.localTime, plan.timezone);
    if (at <= after) continue;
    const wd = ISO_DAY[parts(at, plan.timezone).weekday!]!;
    if (plan.frequency === 'DAILY') return at;
    if (wd !== plan.weekday) continue;
    if (plan.frequency === 'WEEKLY' || isoWeek(at, plan.timezone) % 2 === 0) return at;
  }
  throw new Error('plan zamanı bulunamadı');
}

export function isoWeek(at: Date, timeZone: string): number {
  const p = parts(at, timeZone);
  const d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}
