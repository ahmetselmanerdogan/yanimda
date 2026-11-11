import type { Signal } from '@yanimda/contracts';

import {
  assertSupported,
  type DeviceAdapter,
  type DeviceCapabilities,
  type PromptRequest,
  type RingRequest,
} from '../device.types';
import type { PushPort } from '../push.port';
import { pushPrompt, pushRing } from './push-device';

/**
 * Android eşlikçi telefon (koruma modu B-06: SOS + hareketsizlik; düşme/bilek/nabız sensörü yok).
 * Saat sinyallerini köprülerken (B-03) cihaz kimliği saatinkidir; bu adaptör yalnız telefonun KENDİ sinyalleri içindir.
 */
export class AndroidPhoneAdapter implements DeviceAdapter {
  readonly kind = 'ANDROID_PHONE' as const;
  constructor(private readonly push: PushPort) {}

  capabilities(): DeviceCapabilities {
    return {
      role: 'PHONE',
      category: 'PHONE',
      tier: 'A',
      signals: [
        'SOS',
        'CANCEL',
        'OK',
        'STEPS',
        'INACTIVITY',
        'BATTERY',
        'LOCATION',
        'HEARTBEAT',
        'CALLBACK_REQUEST',
        'TEST',
        'CHARGE_START', // T-086 (S4.8): telefonun kendi şarjı (BLE köprüsü telefona bağlı)
        'CHARGE_END',
      ],
      fallDetection: false,
      offBodyDetection: false,
      heartRate: false,
      devicePrompt: true,
      tts: true,
      ring: true,
      voice: true,
      location: true,
    };
  }

  normalize(raw: Signal): Signal {
    assertSupported(this, raw);
    const s: Signal = structuredClone(raw);
    if (s.device) delete s.device.onWrist; // telefon bilek bilgisi taşıyamaz: koruma durumunu bozmasın
    if (s.location && !s.location.source) s.location.source = 'PHONE';
    return s;
  }

  promptUser(deviceId: string, req: PromptRequest) {
    return pushPrompt(this.push, deviceId, req);
  }

  ring(deviceId: string, req: RingRequest) {
    return pushRing(this.push, deviceId, req);
  }
}
