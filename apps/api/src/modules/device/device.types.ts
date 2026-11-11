import type { DeviceCategory, DeviceKind, DeviceRole, DeviceTier, Signal } from '@yanimda/contracts';

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
  /** Mesaj kataloğu kodu (W-FALL-1 …); metin cihazda katalogdan okunur. */
  tts: string;
  windowSec: number;
  silent: boolean;
}

export interface RingRequest {
  eventId: string;
}

export interface DeviceAdapter {
  readonly kind: DeviceKind;
  capabilities(): DeviceCapabilities;
  /** Ham (şemaya uygun) sinyali kanonik biçime getirir. Girişi değiştirmez. Desteklenmeyen → UnsupportedSignalError. */
  normalize(raw: Signal): Signal;
  promptUser(deviceId: string, req: PromptRequest): Promise<void>;
  ring(deviceId: string, req: RingRequest): Promise<void>;
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
];

export function assertSupported(adapter: DeviceAdapter, s: Signal) {
  if (!adapter.capabilities().signals.includes(s.kind))
    throw new UnsupportedSignalError(`${adapter.kind} cihazı ${s.kind} sinyali gönderemez`);
}
