import type { Signal } from '@yanimda/contracts';

import {
  ALL_SIGNAL_KINDS,
  assertSupported,
  type DeviceAdapter,
  type DeviceCapabilities,
  type PromptRequest,
  type RingRequest,
} from '../device.types';
import type { PushPort } from '../push.port';
import { pushPrompt, pushRing } from './push-device';

/** Wear OS saat (Galaxy Watch). Sinyaller zaten kanonik (Signal veri sınıfı şemayla birebir, T-030): normalize no-op. */
export class WearOsAdapter implements DeviceAdapter {
  readonly kind = 'WEAROS_WATCH' as const;
  constructor(private readonly push: PushPort) {}

  capabilities(): DeviceCapabilities {
    return {
      role: 'WATCH',
      category: 'WATCH',
      tier: 'A',
      signals: [...ALL_SIGNAL_KINDS],
      fallDetection: true,
      offBodyDetection: true,
      heartRate: true,
      devicePrompt: true,
      tts: true,
      ring: true,
      voice: true,
      location: true,
    };
  }

  normalize(raw: Signal): Signal {
    assertSupported(this, raw);
    return raw;
  }

  promptUser(deviceId: string, req: PromptRequest) {
    return pushPrompt(this.push, deviceId, req);
  }

  ring(deviceId: string, req: RingRequest) {
    return pushRing(this.push, deviceId, req);
  }
}
