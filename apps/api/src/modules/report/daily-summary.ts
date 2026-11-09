/**
 * T-062 (C-07, B-10) günlük özet — saf hesap. Girdi: kişinin o gün (yerel) sinyalleri; çıktı: adım, nabız
 * min/ort/maks, bilekte süre, uyku penceresi tahmini.
 *
 *  - Adım: cihazlar günlük kümülatif sayaç gönderir (STEPS.value, HEARTBEAT payload.steps). Cihaz başına en büyük
 *    değer; saat ve telefon aynı adımları saydığı için cihazlar arasında toplam değil en büyüğü.
 *  - Nabız: HEART_RATE.value ve HEARTBEAT payload.hrAvg örnekleri (25–250 dışı atılır).
 *  - Bilekte: ON_BODY/OFF_BODY ve sinyallerdeki device.onWrist gözlemlerinden zaman çizelgesi; iki gözlem arası en
 *    çok 30 dk sayılır (veri yoksa bilinmiyor, takılı sayılmaz).
 *  - Uyku tahmini: gece 00:00–12:00 içinde adım sayacının artmadığı en uzun aralık (≥ 3 saat). Kaba bir tahmin;
 *    aileye "uyku" diye değil, ana ekranda "dinlenme" bilgisi olarak gösterilir.
 */
export interface SignalPoint {
  time: Date;
  deviceId: string;
  kind: string;
  value: number | null;
  steps?: number;
  hrAvg?: number;
  onWrist?: boolean;
}

export interface DailySummary {
  steps: number | null;
  hrMin: number | null;
  hrAvg: number | null;
  hrMax: number | null;
  wristMinutes: number;
  restStart: Date | null;
  restEnd: Date | null;
}

const GAP_CAP_MS = 30 * 60_000;
const MIN_REST_MS = 3 * 3600_000;
const HR_OK = (v: number) => v >= 25 && v <= 250;

export function summarize(points: SignalPoint[], dayStart: Date, dayEnd: Date): DailySummary {
  const ps = points
    .filter((p) => p.time >= dayStart && p.time < dayEnd)
    .sort((a, b) => a.time.getTime() - b.time.getTime());

  // Adım
  const perDevice = new Map<string, number>();
  for (const p of ps) {
    const v = p.kind === 'STEPS' ? p.value : p.steps;
    if (typeof v === 'number' && v >= 0) perDevice.set(p.deviceId, Math.max(perDevice.get(p.deviceId) ?? 0, v));
  }
  const steps = perDevice.size ? Math.round(Math.max(...perDevice.values())) : null;

  // Nabız
  const hr = ps
    .map((p) => (p.kind === 'HEART_RATE' ? p.value : p.hrAvg))
    .filter((v): v is number => typeof v === 'number' && HR_OK(v));
  const hrAvg = hr.length ? Math.round(hr.reduce((a, b) => a + b, 0) / hr.length) : null;

  // Bilekte
  const obs = ps
    .map((p) => ({
      t: p.time.getTime(),
      on: p.kind === 'ON_BODY' ? true : p.kind === 'OFF_BODY' ? false : p.onWrist,
    }))
    .filter((o): o is { t: number; on: boolean } => typeof o.on === 'boolean');
  let wristMs = 0;
  for (let i = 0; i < obs.length; i++) {
    if (!obs[i]!.on) continue;
    const end = i + 1 < obs.length ? obs[i + 1]!.t : Math.min(dayEnd.getTime(), obs[i]!.t + GAP_CAP_MS);
    wristMs += Math.min(end - obs[i]!.t, GAP_CAP_MS);
  }

  // Dinlenme (uyku tahmini): adım artışları arasındaki en uzun boşluk, gece yarısından öğlene.
  const noon = dayStart.getTime() + 12 * 3600_000;
  const moves: number[] = [dayStart.getTime()];
  const last = new Map<string, number>();
  for (const p of ps) {
    const v = p.kind === 'STEPS' ? p.value : p.steps;
    if (typeof v !== 'number') continue;
    const prev = last.get(p.deviceId);
    if (prev !== undefined && v > prev) moves.push(p.time.getTime());
    last.set(p.deviceId, v);
  }
  moves.push(noon);
  let rest: [number, number] | null = null;
  const inWindow = moves.filter((t) => t <= noon).sort((a, b) => a - b);
  for (let i = 1; i < inWindow.length; i++) {
    const [a, b] = [inWindow[i - 1]!, inWindow[i]!];
    if (b - a >= MIN_REST_MS && (!rest || b - a > rest[1] - rest[0])) rest = [a, b];
  }
  // Hiç hareket verisi yoksa tahmin yapma.
  if (last.size === 0) rest = null;

  return {
    steps,
    hrMin: hr.length ? Math.round(Math.min(...hr)) : null,
    hrAvg,
    hrMax: hr.length ? Math.round(Math.max(...hr)) : null,
    wristMinutes: Math.round(wristMs / 60_000),
    restStart: rest ? new Date(rest[0]) : null,
    restEnd: rest ? new Date(rest[1]) : null,
  };
}

/** `timeZone`'daki yerel tarih (YYYY-MM-DD) ve saat:dakika. */
export function localParts(at: Date, timeZone: string): { day: string; minutes: number } {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(at)
    .reduce<Record<string, string>>((acc, x) => ((acc[x.type] = x.value), acc), {});
  return { day: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/** Yerel günün [başlangıç, bitiş) anları (UTC). Yaz saati geçişi olan günlerde de doğru (ofset iki kez ölçülür). */
export function localDayBounds(day: string, timeZone: string): { start: Date; end: Date } {
  const at = (d: string) => {
    const guess = new Date(`${d}T00:00:00Z`);
    const off = offsetMs(guess, timeZone);
    const first = new Date(guess.getTime() - off);
    return new Date(guess.getTime() - offsetMs(first, timeZone));
  };
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return { start: at(day), end: at(next.toISOString().slice(0, 10)) };
}

function offsetMs(at: Date, timeZone: string): number {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(at)
    .reduce<Record<string, string>>((acc, x) => ((acc[x.type] = x.value), acc), {});
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

export const previousDay = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};
