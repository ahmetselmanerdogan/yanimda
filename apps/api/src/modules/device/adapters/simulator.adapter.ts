import { Logger } from '@nestjs/common';
import type { Signal } from '@yanimda/contracts';

import {
  ALL_SIGNAL_KINDS,
  assertSupported,
  type DeviceAdapter,
  type DeviceCapabilities,
  type DeviceCommand,
  type PromptRequest,
  type RingRequest,
  UnsupportedSignalError,
} from '../device.types';
import { simulatorEnabled } from '../simulator-mode';

/**
 * packages/simulator ve kayıtsız cihazlar (geliştirme). Saat gibi davranır, push göndermez.
 * Üretimde kapalıdır (SIMULATOR_ENABLED, varsayılan NODE_ENV !== 'production'): sahte sinyal olay açmasın.
 */
export class SimulatorAdapter implements DeviceAdapter {
  readonly kind = 'SIMULATOR' as const;
  readonly commands: (
    | ({ type: 'PROMPT'; deviceId: string } & PromptRequest)
    | ({ type: 'RING'; deviceId: string } & RingRequest)
    | ({ deviceId: string } & DeviceCommand)
  )[] = [];
  private readonly log = new Logger('SimulatorAdapter');
  private readonly enabled: boolean;

  constructor(opts: { enabled?: boolean } = {}) {
    this.enabled = opts.enabled ?? simulatorEnabled(); // boş değer = tanımsız (.env.example)
  }

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
    if (!this.enabled) throw new UnsupportedSignalError('Kayıtsız cihaz (simülatör bu ortamda kapalı)');
    assertSupported(this, raw);
    return { ...raw, payload: { ...(raw.payload ?? {}), simulated: true } };
  }

  async promptUser(deviceId: string, req: PromptRequest) {
    this.commands.push({ type: 'PROMPT', deviceId, ...req });
    this.log.debug(`PROMPT ${req.tts} ${req.windowSec}s`);
  }

  async ring(deviceId: string, req: RingRequest) {
    this.commands.push({ type: 'RING', deviceId, ...req });
    this.log.debug('RING');
  }

  async command(deviceId: string, cmd: DeviceCommand) {
    this.commands.push({ deviceId, ...cmd });
    this.log.debug(cmd.type);
  }
}
