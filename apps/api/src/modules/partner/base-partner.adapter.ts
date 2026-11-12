import type { Signal } from '@yanimda/contracts';

import { type DeviceCapabilities, type NormalizeContext, UnsupportedSignalError } from '../device/device.types';
import type { PushOutcome } from '../device/push.port';
import {
  assertProfileClass,
  capabilitiesOf,
  type ParsedPartnerEvent,
  type PartnerAdapter,
  type PartnerCommand,
  type PartnerGateway,
  type PartnerModelProfile,
} from './partner.types';

/**
 * Ortak adaptörlerinin ortak kısmı: model profilleri (kayıtta sınıf denetimi), profil başına sinyal kapısı ve komut
 * kapısı. Alt sınıf yalnız ortağın webhook biçimini (`parse`) yazar. Komutlar ortak merkezine PartnerGateway'den
 * gider; profilde olmayan komut 'unsupported' döner (ağa çıkmaz). Model kimliği bilinmeden (DeviceAdapter'ın
 * modelsiz yöntemleri) komut gönderilmez: DeviceService ortak cihazında `sendCommand`'ı model kimliğiyle çağırır.
 */
export abstract class BasePartnerAdapter implements PartnerAdapter {
  abstract readonly kind: PartnerAdapter['kind'];
  abstract readonly partner: string;
  abstract readonly dataRegion: string;
  private readonly byModel: Map<string, PartnerModelProfile>;

  constructor(
    private readonly gateway: PartnerGateway,
    private readonly models: readonly PartnerModelProfile[],
  ) {
    if (!models.length) throw new Error('Ortak adaptörünün en az bir model profili olmalı');
    for (const m of models) assertProfileClass(m);
    this.byModel = new Map(models.map((m) => [m.modelId, m]));
  }

  abstract parse(body: unknown): ParsedPartnerEvent[];

  profiles(): readonly PartnerModelProfile[] {
    return this.models;
  }

  profile(modelId: string | null | undefined): PartnerModelProfile | undefined {
    return modelId ? this.byModel.get(modelId) : undefined;
  }

  /** Modelsiz yetenek: hiçbir sinyal ve komut (model profili olmadan ortak cihazı hiçbir şey yapamaz). */
  capabilities(): DeviceCapabilities {
    return { ...capabilitiesOf(this.models[0]!), signals: [], voice: false, devicePrompt: false, ring: false };
  }

  capabilitiesFor(modelId: string | null | undefined): DeviceCapabilities {
    const p = this.profile(modelId);
    return p ? capabilitiesOf(p) : this.capabilities();
  }

  /** Profil dışı sinyal (ör. C sınıfından düşme) yalnız kendisi reddedilir; model bilinmiyorsa da. */
  normalize(raw: Signal, ctx?: NormalizeContext): Signal {
    const p = this.profile(ctx?.modelId);
    if (!p) throw new UnsupportedSignalError(`${this.partner}: model profili yok`);
    if (!p.signals.includes(raw.kind)) throw new UnsupportedSignalError(`${p.modelId} ${raw.kind} gönderemez`);
    return raw;
  }

  /** Yetenek kapılı komut: profilde yoksa 'unsupported' (ağa çıkmaz). */
  async sendCommand(deviceId: string, modelId: string | null | undefined, cmd: PartnerCommand): Promise<PushOutcome> {
    const p = this.profile(modelId);
    if (!p || !p.commands.includes(cmd.type)) return 'unsupported';
    return (await this.gateway.send(this.partner, deviceId, cmd)) ?? 'sent';
  }

  // DeviceAdapter'ın modelsiz yöntemleri: ortak cihazında DeviceService sendCommand'ı kullanır.
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
