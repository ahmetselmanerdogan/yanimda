/**
 * Gece penceresi (D-05). Varsayılan 22:00–08:00, KİŞİNİN saat diliminde; başlangıç dahil, bitiş hariç.
 * T-014: kişiye özel pencere event.threshold'dan gelir.
 */
export const DEFAULT_SLEEP_WINDOW = { start: '22:00', end: '08:00' } as const;
export const DEFAULT_TIMEZONE = 'Europe/Istanbul';

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** `at` anı, `timeZone`'daki duvar saatine göre [start, end) aralığında mı? Gece yarısını aşan pencere desteklenir. */
export function isInWindow(
  at: Date,
  timeZone: string,
  start: string = DEFAULT_SLEEP_WINDOW.start,
  end: string = DEFAULT_SLEEP_WINDOW.end,
): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(at)
    .reduce<Record<string, string>>((acc, p) => ((acc[p.type] = p.value), acc), {});
  const now = Number(parts.hour) * 60 + Number(parts.minute);
  const s = minutesOf(start);
  const e = minutesOf(end);
  return s <= e ? now >= s && now < e : now >= s || now < e;
}
