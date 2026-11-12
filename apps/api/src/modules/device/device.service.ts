import { Inject, Injectable, Optional } from '@nestjs/common';
import type {
  ConnectionPath,
  CoverageCapabilities,
  DeviceCategory,
  DeviceTier,
  Signal,
  SignalSource,
} from '@yanimda/contracts';
import { inArray, sql } from 'drizzle-orm';

import { DB, type Db } from '../../db/client';
import { device, deviceModel } from '../../db/schema';
import { FakePendantAdapter } from '../partner/fake-pendant.adapter';
import {
  isPartnerAdapter,
  type PartnerAdapter,
  type PartnerGateway,
  RecordingPartnerGateway,
} from '../partner/partner.types';
import { AdapterRegistry } from './adapter.registry';
import { AndroidPhoneAdapter } from './adapters/android-phone.adapter';
import { BleBridgedAdapter, BRIDGED_MODELS } from './adapters/ble-bridged.adapter';
import { IosPhoneAdapter } from './adapters/ios-phone.adapter';
import { SimulatorAdapter } from './adapters/simulator.adapter';
import { WearOsAdapter } from './adapters/wearos.adapter';
import {
  type DeviceAdapter,
  type DeviceCapabilities,
  type DeviceCommand,
  type PromptRequest,
  type RingRequest,
  UnsupportedSignalError,
} from './device.types';
import { relayBridgeOf } from './device-push';
import { PUSH, type PushOutcome, type PushPort, RecordingPush } from './push.port';

export const ADAPTER_REGISTRY = Symbol('ADAPTER_REGISTRY');

export function defaultRegistry(
  push: PushPort = new RecordingPush(),
  partners: PartnerGateway = new RecordingPartnerGateway(),
): AdapterRegistry {
  return new AdapterRegistry([
    new WearOsAdapter(push),
    new AndroidPhoneAdapter(push),
    new IosPhoneAdapter(push),
    new SimulatorAdapter(),
    ...BRIDGED_MODELS.map((m) => new BleBridgedAdapter(m)), // T-092 telefon köprüsü
    // T-085 OEM: sahte ortak (test / geliştirme). Webhook'u yalnız sırrı tanımlıysa açılır (PartnerWebhookService).
    new FakePendantAdapter(partners),
  ]);
}

/**
 * T-015 device modülü: cihaz türünü bilir, sinyali türünün adaptöründen geçirir, cihaza komut gönderir.
 * Diğer modüller cihaz tablosunu okumaz; bu servisi kullanır.
 */
@Injectable()
export class DeviceService {
  private readonly registry: AdapterRegistry;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(ADAPTER_REGISTRY) registry?: AdapterRegistry,
    @Optional() @Inject(PUSH) push?: PushPort,
  ) {
    this.registry = registry ?? defaultRegistry(push);
  }

  /** Kayıtlı cihazların türü (kimlik → tür); kayıtsızlar listede yok. Tek sorgu. */
  async kindsOf(deviceIds: string[]): Promise<Map<string, string>> {
    return new Map([...(await this.profilesOf(deviceIds))].map(([id, p]) => [id, p.kind]));
  }

  /**
   * T-085: kayıtlı cihazların profili (tür, kategori, sınıf, katalog yetenekleri, pil ömrü). Yetenek model ×
   * entegrasyon yoluna aittir (S1.5): kayıttaki kategori/sınıf, yoksa kataloğun (device.device_model) değeri.
   */
  async profilesOf(deviceIds: string[]): Promise<Map<string, DeviceProfile>> {
    const ids = [...new Set(deviceIds)];
    if (!ids.length) return new Map();
    const rows = await this.db
      .select({
        id: sql<string>`${device.id}::text`,
        kind: device.kind,
        modelId: sql<string>`coalesce(${device.modelId}, ${device.kind})`,
        connectionPath: device.connectionPath,
        category: sql<string | null>`coalesce(${device.category}, ${deviceModel.category})`,
        tier: sql<string | null>`coalesce(${device.tier}, ${deviceModel.tier})`,
        capabilities: deviceModel.capabilities,
        batteryLifeH: deviceModel.batteryLifeH,
      })
      .from(device)
      .leftJoin(deviceModel, sql`${deviceModel.id} = coalesce(${device.modelId}, ${device.kind})`)
      .where(inArray(sql`${device.id}::text`, ids));
    return new Map(
      rows.map((r) => [
        r.id,
        {
          kind: r.kind,
          modelId: r.modelId,
          connectionPath: (r.connectionPath as ConnectionPath | null) ?? null,
          category: (r.category as DeviceCategory | null) ?? null,
          tier: (r.tier as DeviceTier | null) ?? null,
          caps: r.capabilities ? capsOf(r.capabilities as CatalogCapabilities) : null,
          batteryLifeH: r.batteryLifeH ?? null,
        },
      ]),
    );
  }

  /**
   * Partiyi kanonik hâle getirir: her sinyal kendi cihaz türünün adaptöründen geçer ve sunucu `source`
   * alanını doldurur. Sinyal başına sonuç: desteklenmeyen sinyal (UnsupportedSignalError) yalnız kendisi için
   * `null` döner; partinin geri kalanı etkilenmez (D-01: SOS, yanındaki desteklenmeyen sinyal yüzünden kaybolmaz).
   */
  async prepareEach(batch: Signal[]): Promise<(Signal | null)[]> {
    const profiles = await this.profilesOf(batch.map((s) => s.deviceId));
    return batch.map((raw) => {
      try {
        const p = profiles.get(raw.deviceId);
        const adapter = this.registry.for(p?.kind ?? null);
        const s = adapter.normalize(raw, { modelId: p?.modelId ?? null });
        return { ...s, source: sourceOf(adapter, p) };
      } catch (e) {
        if (e instanceof UnsupportedSignalError) return null;
        throw e;
      }
    });
  }

  /** T-085 OEM: ortak kodu (= cihaz türü) için kayıtlı ortak adaptörü; yoksa null. */
  partnerAdapter(partner: string): PartnerAdapter | null {
    try {
      const a = this.registry.for(partner);
      return isPartnerAdapter(a) ? a : null;
    } catch (e) {
      if (e instanceof UnsupportedSignalError) return null;
      throw e;
    }
  }

  /** Kayıtlı ortak adaptörleri (gecikme taraması). */
  partners(): PartnerAdapter[] {
    return this.registry
      .kinds()
      .map((k) => this.registry.for(k))
      .filter(isPartnerAdapter);
  }

  async adapterFor(deviceId: string): Promise<DeviceAdapter> {
    return (await this.resolve(deviceId)).adapter;
  }

  /** Adaptör, model ve modele özgü yetenekler (T-085 OEM: ortak cihazında komut kapısı modele göre). */
  private async resolve(deviceId: string) {
    const p = (await this.profilesOf([deviceId])).get(deviceId);
    const adapter = this.registry.for(p?.kind ?? null);
    const modelId = p?.modelId ?? null;
    const caps: DeviceCapabilities = adapter.capabilitiesFor?.(modelId) ?? adapter.capabilities();
    return { adapter, modelId, caps };
  }

  /**
   * Cihazda soru göster. Sonuç gerçek teslimdir: 'sent' / 'relayed' (köprü telefon üzerinden) ulaştı; 'unsupported'
   * cihaz soru gösteremez; diğerleri push sonucu (token yok, sağlayıcı hatası …). Ulaştı mı: `delivered()`.
   */
  async promptUser(deviceId: string, req: PromptRequest): Promise<PushOutcome> {
    const { adapter: a, modelId, caps } = await this.resolve(deviceId);
    if (!caps.devicePrompt) return 'unsupported';
    if (isPartnerAdapter(a))
      return a.sendCommand(deviceId, modelId, {
        type: 'PROMPT',
        eventId: req.eventId,
        tts: req.tts,
        windowSec: req.windowSec,
      });
    return (await a.promptUser(deviceId, req)) ?? 'sent';
  }

  async ring(deviceId: string, req: RingRequest): Promise<PushOutcome> {
    const { adapter: a, modelId, caps } = await this.resolve(deviceId);
    if (!caps.ring) return 'unsupported';
    if (isPartnerAdapter(a)) return a.sendCommand(deviceId, modelId, { type: 'RING', eventId: req.eventId });
    return (await a.ring(deviceId, req)) ?? 'sent';
  }

  /**
   * T-089: konum iste (cihaz konum gönderebiliyorsa) veya cihaz testi (push alabiliyorsa). T-085 OEM: ortak cihazında
   * komut ortak merkezine gider ve modelin profilindeki komutlarla sınırlıdır (ör. radyo kolyede konum yok).
   */
  async command(deviceId: string, cmd: DeviceCommand): Promise<PushOutcome> {
    const { adapter: a, modelId, caps } = await this.resolve(deviceId);
    if (isPartnerAdapter(a))
      return a.sendCommand(deviceId, modelId, cmd.type === 'LOCATE' ? { type: 'LOCATE', eventId: cmd.eventId } : cmd);
    if (cmd.type === 'LOCATE' ? !caps.location : !caps.ring) return 'unsupported';
    return (await a.command(deviceId, cmd)) ?? 'sent';
  }

  /** Bu cihaza giden komutun aktarılacağı köprü telefon (cihazın kendi push token'ı yoksa); yoksa null. */
  relayBridgeOf(deviceId: string): Promise<string | null> {
    return relayBridgeOf(this.db, deviceId);
  }
}

/** Katalogdaki yetenek biçimi (device.device_model.capabilities). */
type CatalogCapabilities = Partial<Record<keyof CoverageCapabilities, { available?: boolean }>>;
const capsOf = (c: CatalogCapabilities): CoverageCapabilities => ({
  sos: !!c.sos?.available,
  fall: !!c.fall?.available,
  voice: !!c.voice?.available,
  location: !!c.location?.available,
});

export interface DeviceProfile {
  kind: string;
  /** Katalog modeli (kayıttaki model, yoksa tür). */
  modelId: string;
  connectionPath: ConnectionPath | null;
  category: DeviceCategory | null;
  tier: DeviceTier | null;
  caps: CoverageCapabilities | null;
  batteryLifeH: number | null;
}

/** Sunucunun sinyale eklediği cihaz profili: kayıt/katalog, yoksa adaptörün varsayılanları (kayıtsız simülatör). */
function sourceOf(adapter: DeviceAdapter, p?: DeviceProfile): SignalSource {
  const c = adapter.capabilities();
  return {
    kind: adapter.kind,
    role: c.role,
    category: p?.category ?? c.category,
    tier: p?.tier ?? c.tier,
    caps: p?.caps ?? {
      sos: c.signals.includes('SOS'),
      fall: c.fallDetection,
      voice: c.voice,
      location: c.location,
    },
    batteryLifeH: p?.batteryLifeH ?? null,
    ...(p?.connectionPath ? { connectionPath: p.connectionPath } : {}),
  };
}
