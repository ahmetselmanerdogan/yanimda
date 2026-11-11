import type { DeviceRole, Signal } from '@yanimda/contracts';

import { type DeviceFact, isAlarmWearable } from './coverage';

/**
 * T-088 (docs/07 S3.3–S3.7) sinyal birleştirme kuralları — saf fonksiyonlar, olay motoru cihaz modeli bilmez:
 * cihazın kategori / sınıf / takılı / şarj bilgisi T-085 kapsama olgularından (sinyalin `source` alanı: adaptör +
 * katalog), süreler kural paketinden.
 */

/** Olay konumu + ölçüm anı (birleştirme için). */
export type FusedLocation = NonNullable<Signal['location']> & { at?: string };

/** S3.3: farklı bir cihazın düşmesi pencere içinde mi (ilk düşmenin açtığı olaya göre, sunucu saati). */
export function corroborates(eventCreatedAt: string, at: string, windowSec: number): boolean {
  const d = Date.parse(at) - Date.parse(eventCreatedAt);
  return Number.isFinite(d) && d <= windowSec * 1000;
}

/**
 * S3.3 + S3.4: doğrulama iki farklı, şarjda olmayan cihazın düşmesini ister. Şarjdaki cihazın düşmesi (şarjından
 * düşen saat en sık yanlış düşmedir) doğrulama sayılmaz; sinyal kendi "şarjda" bilgisini taşıyorsa zaten yok sayılır
 * (T-086), burada son bilinen şarj durumu da hesaba katılır — olay açılır ama soru süresi kısalmaz.
 */
export function corroborationPair(sourceDeviceIds: string[], by: string, charging: ReadonlySet<string>): boolean {
  return !charging.has(by) && sourceDeviceIds.some((d) => d !== by && !charging.has(d));
}

/** Takılı, şarjda olmayan A sınıfı giyilebilir (kapsama olgusu; takılı bilgisi bilinmiyorsa takılı sayılmaz). */
export const wornAlarm = (d: Pick<DeviceFact, 'category' | 'tier' | 'onBody' | 'charging'>) =>
  isAlarmWearable(d) && d.onBody === true && !d.charging;

/**
 * S3.6 "İyiyim" kimden kabul edilir: alarmı açan (veya ona eklenen) cihazdan; takılı A sınıfı giyilebilirden (saat,
 * kolye — kapsama olgusu, sinyal uygulandıktan sonra: sinyaldeki takılı bilgisi, yoksa son bilinen); telefonda yalnız
 * özel "İyiyim" ekranından (`payload.screen = IM_OK`). Aile uygulaması sinyal gönderemez (yalnız cihaz token'ı);
 * B/C sınıfı cihaz ve şarjdaki saat iptal edemez. Kaynak cihaz listesi olmayan eski olaylarda (0031 öncesi) her cihaz
 * kabul edilir.
 */
export type AnswerSource = {
  deviceId: string;
  /** Sinyali gönderen cihazın kapsama olgusu (yoksa yalnız rol bilinir). */
  device?: Pick<DeviceFact, 'category' | 'tier' | 'onBody' | 'charging'>;
  role?: DeviceRole;
  screen?: unknown;
};
export const IM_OK_SCREEN = 'IM_OK';

export function answerAllowed(sourceDeviceIds: string[], a: AnswerSource): boolean {
  if (!sourceDeviceIds.length || sourceDeviceIds.includes(a.deviceId)) return true;
  if (a.device && wornAlarm(a.device)) return true;
  const phone = a.device ? a.device.category === 'PHONE' : a.role === 'PHONE';
  return phone && a.screen === IM_OK_SCREEN;
}

/**
 * S3.7 konum sırası: 2 dk'dan yeni GPS (0) > diğer cihaz konumu (1) > telefonun ağ konumu (2). Daha eski ölçüm asla
 * yenisinin yerine geçmez; aynı sıradaysa yenisi kazanır.
 */
export function locationRank(l: FusedLocation, now: Date, gpsFreshSec: number): number {
  const age = l.at ? (now.getTime() - Date.parse(l.at)) / 1000 : Infinity;
  if (l.source === 'GPS' && age <= gpsFreshSec) return 0;
  return l.source === 'NETWORK' ? 2 : 1;
}

export function betterLocation(
  current: FusedLocation | null | undefined,
  incoming: FusedLocation,
  now: Date,
  gpsFreshSec: number,
): boolean {
  if (!current) return true;
  if (current.lat === incoming.lat && current.lng === incoming.lng && current.source === incoming.source) return false;
  if (incoming.at && current.at && Date.parse(incoming.at) < Date.parse(current.at)) return false;
  return locationRank(incoming, now, gpsFreshSec) <= locationRank(current, now, gpsFreshSec);
}
