import { Inject, Injectable, Optional } from '@nestjs/common';
import type { CoverageCapabilities, DeviceCategory, DeviceTier, Signal, SignalSource } from '@yanimda/contracts';
import { inArray, sql } from 'drizzle-orm';

import { DB, type Db } from '../../db/client';
import { device, deviceModel } from '../../db/schema';
import { AdapterRegistry } from './adapter.registry';
import { AndroidPhoneAdapter } from './adapters/android-phone.adapter';
import { IosPhoneAdapter } from './adapters/ios-phone.adapter';
import { SimulatorAdapter } from './adapters/simulator.adapter';
import { WearOsAdapter } from './adapters/wearos.adapter';
import { type DeviceAdapter, type PromptRequest, type RingRequest, UnsupportedSignalError } from './device.types';
import { PUSH, type PushPort, RecordingPush } from './push.port';

export const ADAPTER_REGISTRY = Symbol('ADAPTER_REGISTRY');

export function defaultRegistry(push: PushPort = new RecordingPush()): AdapterRegistry {
  return new AdapterRegistry([
    new WearOsAdapter(push),
    new AndroidPhoneAdapter(push),
    new IosPhoneAdapter(push),
    new SimulatorAdapter(),
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
        const s = adapter.normalize(raw);
        return { ...s, source: sourceOf(adapter, p) };
      } catch (e) {
        if (e instanceof UnsupportedSignalError) return null;
        throw e;
      }
    });
  }

  async adapterFor(deviceId: string): Promise<DeviceAdapter> {
    return this.registry.for((await this.kindsOf([deviceId])).get(deviceId) ?? null);
  }

  /** Cihazda soru göster (cihaz destekliyorsa). Desteklemiyorsa false. */
  async promptUser(deviceId: string, req: PromptRequest): Promise<boolean> {
    const a = await this.adapterFor(deviceId);
    if (!a.capabilities().devicePrompt) return false;
    await a.promptUser(deviceId, req);
    return true;
  }

  async ring(deviceId: string, req: RingRequest): Promise<boolean> {
    const a = await this.adapterFor(deviceId);
    if (!a.capabilities().ring) return false;
    await a.ring(deviceId, req);
    return true;
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
  };
}
