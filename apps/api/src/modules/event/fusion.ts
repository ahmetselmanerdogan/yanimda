import type { DeviceRole, Signal } from '@yanimda/contracts';

/**
 * T-088 (docs/07 S3.3–S3.7) sinyal birleştirme kuralları — saf fonksiyonlar, olay motoru cihaz modeli bilmez:
 * yalnız sunucunun doldurduğu cihaz rolünü (`signal.source.role`) ve kural paketindeki süreleri kullanır.
 */

/** Olay konumu + ölçüm anı (birleştirme için). */
export type FusedLocation = NonNullable<Signal['location']> & { at?: string };

/** S3.3: farklı bir cihazın düşmesi pencere içinde mi (ilk düşmenin açtığı olaya göre, sunucu saati). */
export function corroborates(eventCreatedAt: string, at: string, windowSec: number): boolean {
  const d = Date.parse(at) - Date.parse(eventCreatedAt);
  return Number.isFinite(d) && d <= windowSec * 1000;
}

/**
 * S3.6 "İyiyim" kimden kabul edilir: alarmı açan (veya ona eklenen) cihazdan; takılı A sınıfı cihazdan (bugün saat
 * rolü — T-085 kategori sütunu gelince oradan); telefonda yalnız özel "İyiyim" ekranından (`payload.screen = IM_OK`).
 * Aile uygulaması sinyal gönderemez (yalnız cihaz token'ı); B/C sınıfı cihazlar sinyal yolundan zaten gelmez.
 * Kaynak cihaz listesi olmayan eski olaylarda (0031 öncesi) her cihaz kabul edilir.
 */
export type AnswerSource = {
  deviceId: string;
  role?: DeviceRole;
  /** Sinyaldeki takılı bilgisi; yoksa cihazın son bilinen durumu (worn). */
  onWrist?: boolean;
  worn?: boolean | null;
  screen?: unknown;
};
export const IM_OK_SCREEN = 'IM_OK';

export function answerAllowed(sourceDeviceIds: string[], a: AnswerSource): boolean {
  if (!sourceDeviceIds.length || sourceDeviceIds.includes(a.deviceId)) return true;
  if (a.role === 'WATCH') return a.onWrist ?? a.worn === true;
  if (a.role === 'PHONE') return a.screen === IM_OK_SCREEN;
  return false;
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
