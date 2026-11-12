import { localDate, localMinute } from './coverage';
import type { ChargeLearnParams } from './rules.loader';

/**
 * T-086 (docs/07 S4.3) öğrenilmiş şarj penceresi — saf fonksiyonlar. Girdi: kişinin A sınıfı giyilebilirlerinin
 * CHARGE_START / CHARGE_END sinyalleri (cihaz kimliği + an). Aynı cihazın başlangıcı sonraki bitişiyle eşlenir
 * (bitişi olmayan veya maxSessionH'den uzun oturum sayılmaz); minSessionMin'den kısa oturum "ana şarj" değildir.
 * Her yerel günün ana şarjı o gün başlayan en uzun oturumdur. En az minDays geçerli gün varsa pencere: başlangıçların
 * ortancası (roundMin'e aşağı) – bitişlerin ortancası (roundMin'e yukarı). Gece yarısını aşan şarj (23:30–01:00)
 * dairesel ortancayla doğru bulunur.
 */
export interface ChargeMark {
  deviceId: string;
  kind: 'CHARGE_START' | 'CHARGE_END';
  at: Date;
}
export interface ChargeSession {
  deviceId: string;
  start: Date;
  end: Date;
}
export interface LearnedWindow {
  start: string;
  end: string;
  validDays: number;
}

export function chargeSessions(marks: ChargeMark[], p: Pick<ChargeLearnParams, 'maxSessionH'>): ChargeSession[] {
  const sorted = [...marks].sort((a, b) => a.at.getTime() - b.at.getTime());
  const open = new Map<string, Date>();
  const out: ChargeSession[] = [];
  for (const m of sorted) {
    if (m.kind === 'CHARGE_START') {
      if (!open.has(m.deviceId)) open.set(m.deviceId, m.at); // tekrar gelen başlangıç ilkini değiştirmez
      continue;
    }
    const start = open.get(m.deviceId);
    if (!start) continue;
    open.delete(m.deviceId);
    if (m.at.getTime() - start.getTime() <= p.maxSessionH * 3_600_000)
      out.push({ deviceId: m.deviceId, start, end: m.at });
  }
  return out;
}

/** Günün ana şarjı: o yerel gün başlayan, minSessionMin'den uzun en uzun oturum. Gün → oturum. */
export function mainCharges(
  sessions: ChargeSession[],
  timezone: string,
  p: Pick<ChargeLearnParams, 'minSessionMin'>,
): Map<string, ChargeSession> {
  const days = new Map<string, ChargeSession>();
  const len = (s: ChargeSession) => s.end.getTime() - s.start.getTime();
  for (const s of sessions) {
    if (len(s) < p.minSessionMin * 60_000) continue;
    const day = localDate(s.start, timezone);
    const prev = days.get(day);
    if (!prev || len(s) > len(prev)) days.set(day, s);
  }
  return days;
}

/**
 * Gün dakikalarının (0–1439) dairesel ortancası: en büyük boşluğun hemen sonrasından açılır, sıradan ortanca alınır
 * (çift sayıda örnekte iki ortadakinin ortalaması), sonra 1440'a göre geri sarılır.
 */
export function circularMedian(mins: number[]): number {
  if (!mins.length) throw new Error('boş');
  const s = [...mins].map((m) => ((m % 1440) + 1440) % 1440).sort((a, b) => a - b);
  let gapAt = 0;
  let gap = s[0]! + 1440 - s[s.length - 1]!;
  for (let i = 1; i < s.length; i++)
    if (s[i]! - s[i - 1]! > gap) {
      gap = s[i]! - s[i - 1]!;
      gapAt = i;
    }
  const unrolled = [...s.slice(gapAt), ...s.slice(0, gapAt).map((m) => m + 1440)];
  const n = unrolled.length;
  const mid = n % 2 ? unrolled[(n - 1) / 2]! : (unrolled[n / 2 - 1]! + unrolled[n / 2]!) / 2;
  return Math.round(mid) % 1440;
}

const hhmm = (m: number) => {
  const x = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
};

/**
 * Son `days` günün ana şarjlarından pencere; yeterli geçerli gün yoksa null. `now`'dan geriye `days` gün içinde
 * başlayan oturumlar sayılır (bugün dahil).
 */
export function learnChargingWindow(
  marks: ChargeMark[],
  timezone: string,
  now: Date,
  p: ChargeLearnParams,
): LearnedWindow | null {
  const since = now.getTime() - p.days * 86_400_000;
  const sessions = chargeSessions(marks, p).filter((s) => s.start.getTime() >= since && s.end <= now);
  const days = [...mainCharges(sessions, timezone, p).values()];
  if (days.length < p.minDays) return null;
  const start = circularMedian(days.map((s) => localMinute(s.start, timezone)));
  const end = circularMedian(days.map((s) => localMinute(s.end, timezone)));
  const r = p.roundMin;
  const s0 = Math.floor(start / r) * r;
  let e0 = Math.ceil(end / r) * r;
  if (e0 % 1440 === s0 % 1440) e0 = s0 + r;
  return { start: hhmm(s0), end: hhmm(e0), validDays: days.length };
}
