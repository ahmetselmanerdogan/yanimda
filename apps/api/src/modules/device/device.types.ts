import type { DeviceCategory, DeviceKind, DeviceRole, DeviceTier, Signal } from '@yanimda/contracts';

import type { PushOutcome } from './push.port';

export type { DeviceCategory, DeviceKind, DeviceRole, DeviceTier } from '@yanimda/contracts';

/**
 * T-015 cihaz adaptörü arayüzü. Olay motoru cihaz bilmez: cihaza özgü her şey (sinyal düzeltme,
 * yetenekler, cihaza komut) burada. Yeni cihaz türü (ör. iOS, Apple Watch) = yeni adaptör.
 * NOT: 03-teknik-mimari.md'deki tanım repoda yok; arayüz görev metninden türetildi, 03 ile karşılaştırılmalı.
 */
export interface DeviceCapabilities {
  role: DeviceRole;
  /** T-085: kategori ve sınıf (katalogda model satırı yoksa bunlar geçerli; device.device_model önceliklidir). */
  category: DeviceCategory;
  tier: DeviceTier;
  /** İki yönlü sesli görüşme (sesli arama sırası, kapsama "ses" yeteneği). */
  voice: boolean;
  /** Konum gönderebilir. */
  location: boolean;
  /** Bu cihazın gönderebileceği sinyal türleri; dışındakiler alımda reddedilir. */
  signals: Signal['kind'][];
  fallDetection: boolean;
  offBodyDetection: boolean;
  heartRate: boolean;
  /** Cihaz ekranda soru gösterebilir ("İyi misiniz?"). */
  devicePrompt: boolean;
  tts: boolean;
  /** Cihaz uzaktan çaldırılabilir (yüksek öncelikli push). */
  ring: boolean;
}

export interface PromptRequest {
  eventId: string;
  /** Olay türü (FALL, INACTIVITY …): telefon kendi soru metnini buna göre seçer. */
  kind: string;
  /** Mesaj kataloğu kodu (W-FALL-1 …); metin cihazda katalogdan okunur. */
  tts: string;
  /** Gönderim anında kalan süre (sn). */
  windowSec: number;
  /** Sorunun mutlak bitişi (ISO, sunucu saati): doğrulanmış düşmenin kısalan süresi dahil. */
  until: string;
  silent: boolean;
}

export interface RingRequest {
  eventId: string;
}

/** T-089 operatör komutları (S7.1, S8.3): konum iste (açık olay), cihaz testi (aylık deneme, S4.9). */
export type DeviceCommand = { type: 'LOCATE'; eventId: string } | { type: 'TEST' };

export interface DeviceAdapter {
  readonly kind: DeviceKind;
  capabilities(): DeviceCapabilities;
  /** Ham (şemaya uygun) sinyali kanonik biçime getirir. Girişi değiştirmez. Desteklenmeyen → UnsupportedSignalError. */
  normalize(raw: Signal): Signal;
  /** Sonuç push teslimidir (void: sonucu bilinmeyen / ağa çıkmayan uygulama, ör. simülatör = gönderildi). */
  promptUser(deviceId: string, req: PromptRequest): Promise<PushOutcome | void>;
  ring(deviceId: string, req: RingRequest): Promise<PushOutcome | void>;
  command(deviceId: string, cmd: DeviceCommand): Promise<PushOutcome | void>;
}

/** Cihaz bu sinyali gönderemez / tür bilinmiyor / simülatör kapalı → 400. */
export class UnsupportedSignalError extends Error {}

export const ALL_SIGNAL_KINDS: Signal['kind'][] = [
  'SOS',
  'FALL',
  'CANCEL',
  'OK',
  'HEART_RATE',
  'STEPS',
  'INACTIVITY',
  'OFF_BODY',
  'ON_BODY',
  'BATTERY',
  'LOCATION',
  'HEARTBEAT',
  'CALLBACK_REQUEST',
  'TEST',
  'CHARGE_START',
  'CHARGE_END',
  'SPO2', // T-092 (S6.2): yalnız kayıt; değer kuralları bayrakla kapalı
  'SKIN_TEMP_DEVIATION',
];

export function assertSupported(adapter: DeviceAdapter, s: Signal) {
  if (!adapter.capabilities().signals.includes(s.kind))
    throw new UnsupportedSignalError(`${adapter.kind} cihazı ${s.kind} sinyali gönderemez`);
}
