import type { BridgedDeviceModel, DeviceCategory, DeviceTier, Signal } from '@yanimda/contracts';

import { assertSupported, type DeviceAdapter, type DeviceCapabilities } from '../device.types';
import type { PushOutcome } from '../push.port';

/**
 * T-092 (docs/07 S2.1 B sınıfı, S4.8, S7.5) yaşlının telefonuna BLE ile bağlı cihazlar. Kendi bağlantıları ve push
 * token'ları yoktur: telefon kaydeder (`POST /devices/bridged`) ve sinyallerini kendi token'ıyla, cihazın kimliğiyle
 * iletir. Model profili gönderilebilecek sinyalleri belirler; dışındaki sinyal yalnız kendisi reddedilir
 * (UNSUPPORTED_SIGNAL). Her sinyal köprülü sayılır (`device.connectivity = BLE`): telefon düşünce kapsamaları da düşer.
 *  - BLE_HR (0x180D nabız ölçer), BLE_PULSE_OX (0x1822 oksimetre), BLE_THERMO (cilt sıcaklığı): B sınıfı, olay
 *    açamaz; değerleri bayrakla kapalı değer kurallarına girer.
 *  - BLE_PENDANT: A sınıfı SOS düğmesi; yalnız telefon çevrimiçiyken korumaya sayılır (kapsama köprü kuralı).
 *    Düşme algılama ve ses yok.
 */
export const BRIDGED_PROFILES: Record<
  BridgedDeviceModel,
  { category: DeviceCategory; tier: DeviceTier; signals: Signal['kind'][]; heartRate: boolean }
> = {
  BLE_HR: {
    category: 'SENSOR',
    tier: 'B',
    signals: ['HEART_RATE', 'BATTERY', 'ON_BODY', 'OFF_BODY', 'HEARTBEAT'],
    heartRate: true,
  },
  BLE_PULSE_OX: {
    category: 'SENSOR',
    tier: 'B',
    signals: ['SPO2', 'HEART_RATE', 'BATTERY', 'ON_BODY', 'OFF_BODY', 'HEARTBEAT'],
    heartRate: true,
  },
  BLE_THERMO: {
    category: 'SENSOR',
    tier: 'B',
    signals: ['SKIN_TEMP_DEVIATION', 'BATTERY', 'ON_BODY', 'OFF_BODY', 'HEARTBEAT'],
    heartRate: false,
  },
  BLE_PENDANT: {
    category: 'PENDANT',
    tier: 'A',
    signals: ['SOS', 'CANCEL', 'OK', 'TEST', 'BATTERY', 'ON_BODY', 'OFF_BODY', 'HEARTBEAT'],
    heartRate: false,
  },
};
export const BRIDGED_MODELS = Object.keys(BRIDGED_PROFILES) as BridgedDeviceModel[];
export const isBridgedModel = (v: unknown): v is BridgedDeviceModel =>
  typeof v === 'string' && (BRIDGED_MODELS as string[]).includes(v);

export class BleBridgedAdapter implements DeviceAdapter {
  constructor(readonly kind: BridgedDeviceModel) {}

  capabilities(): DeviceCapabilities {
    const p = BRIDGED_PROFILES[this.kind];
    return {
      role: 'WATCH',
      category: p.category,
      tier: p.tier,
      signals: [...p.signals],
      fallDetection: false,
      offBodyDetection: p.signals.includes('OFF_BODY'),
      heartRate: p.heartRate,
      devicePrompt: false,
      tts: false,
      ring: false,
      voice: false,
      location: false,
    };
  }

  normalize(raw: Signal): Signal {
    assertSupported(this, raw);
    const s: Signal = structuredClone(raw);
    // Köprülü: telefon üzerinden geldi (S4.8). Konum varsa telefonundur (BLE cihazın GPS'i yok).
    s.device = { ...s.device, connectivity: 'BLE' };
    if (s.location && !s.location.source) s.location.source = 'PHONE';
    return s;
  }

  // Cihaza doğrudan komut yolu yok (soru / çaldırma telefona gider).
  async promptUser(): Promise<PushOutcome> {
    return 'unsupported';
  }
  async ring(): Promise<PushOutcome> {
    return 'unsupported';
  }
  async command(): Promise<PushOutcome> {
    return 'unsupported';
  }
}
