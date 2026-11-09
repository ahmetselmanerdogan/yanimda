import type { ActivitySample } from '../../src/modules/event/learning';

/** T-070 sentetik etkinlik verisi (öğrenme testleri). İstanbul UTC+3, yaz saati yok. */
export const TZ = 'Europe/Istanbul'; // UTC+3, yaz saati yok
export const DAY = 86_400_000;
/** İstanbul duvar saati → UTC Date. */
export const ist = (day: number, hh: number, mm = 0) => new Date(Date.UTC(2026, 9, 1 + day, hh - 3, mm));
/** Deterministik "rastgele" (testler tekrarlanabilir). */
const jitter = (seed: number, span: number) => (((seed * 7919) % 101) / 100) * span - span / 2;

export interface Persona {
  wake: [number, number];
  bed: [number, number];
  /** Gündüz hareketsiz dönemleri: [başlangıç saati, dakika]. */
  rests: [number, number][];
  stepEveryMin: number;
}

/** 30 günlük sentetik sinyal: uyanınca ON_BODY, uyanıkken düzenli STEPS, yatarken OFF_BODY. */
export function synth(p: Persona, days = 30): ActivitySample[] {
  const out: ActivitySample[] = [];
  for (let d = 0; d < days; d++) {
    const wakeMin = p.wake[0] * 60 + p.wake[1] + Math.round(jitter(d + 1, 30));
    const bedMin = p.bed[0] * 60 + p.bed[1] + Math.round(jitter(d + 7, 20));
    out.push({ at: ist(d, 0, wakeMin), kind: 'ON_BODY', value: null });
    const rests = p.rests.map(([h, len], i) => {
      const s = h * 60 + Math.round(jitter(d * 3 + i, 40));
      return [s, s + len + Math.round(jitter(d * 5 + i, 10))] as const;
    });
    for (let m = wakeMin; m < bedMin; m += p.stepEveryMin) {
      if (rests.some(([s, e]) => m > s && m < e)) continue;
      out.push({ at: ist(d, 0, m), kind: 'STEPS', value: 40 + (m % 17) });
      out.push({ at: ist(d, 0, m + 1), kind: 'HEART_RATE', value: 72 });
    }
    out.push({ at: ist(d, 0, bedMin + 5), kind: 'OFF_BODY', value: null });
    // Gece: saat şarjda, ara ara HEARTBEAT (hareket değil)
    for (let m = bedMin + 30; m < 24 * 60 + wakeMin - 30; m += 60)
      out.push({ at: ist(d, 0, m), kind: 'HEARTBEAT', value: null });
  }
  return out;
}
