import type { Signal } from '@yanimda/contracts';

import {
  assertSupported,
  type DeviceAdapter,
  type DeviceCapabilities,
  type DeviceCommand,
  type PromptRequest,
  type RingRequest,
} from '../device.types';
import type { PushPort } from '../push.port';
import { AndroidPhoneAdapter } from './android-phone.adapter';
import { pushCommand, pushPrompt, pushRing } from './push-device';

/**
 * iOS eşlikçi telefon (T-073, repo: yanimda-ios). Android telefonla aynı sinyal kümesi: SOS, hareketsizlik
 * (CMMotionActivity), konum (önemli konum değişikliği), HEARTBEAT (HealthKit nabız/adım payload'da).
 * Farklar: saat köprüsü yok (Galaxy Watch iOS'ta yok; Apple Watch v1.5), arka planda TTS yok (soru bildirimle
 * gösterilir). Push T-053'te APNs ile gider; komut biçimi FCM cihazlarıyla aynı tutulur.
 */
export class IosPhoneAdapter implements DeviceAdapter {
  readonly kind = 'IOS_PHONE' as const;
  constructor(private readonly push: PushPort) {}

  capabilities(): DeviceCapabilities {
    return {
      role: 'PHONE',
      category: 'PHONE',
      tier: 'A',
      signals: [...new AndroidPhoneAdapter(this.push).capabilities().signals],
      fallDetection: false,
      offBodyDetection: false,
      heartRate: false,
      devicePrompt: true,
      tts: false,
      ring: true,
      voice: true,
      location: true,
    };
  }

  normalize(raw: Signal): Signal {
    assertSupported(this, raw);
    const s: Signal = structuredClone(raw);
    if (s.device) delete s.device.onWrist; // telefon bilek bilgisi taşıyamaz
    if (s.location && !s.location.source) s.location.source = 'PHONE';
    return s;
  }

  promptUser(deviceId: string, req: PromptRequest) {
    return pushPrompt(this.push, deviceId, req);
  }

  ring(deviceId: string, req: RingRequest) {
    return pushRing(this.push, deviceId, req);
  }

  command(deviceId: string, cmd: DeviceCommand) {
    return pushCommand(this.push, deviceId, cmd);
  }
}
