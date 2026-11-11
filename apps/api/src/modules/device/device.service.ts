import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Signal } from '@yanimda/contracts';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { DB, type Db, type Tx } from '../../db/client';
import { device } from '../../db/schema';
import { AdapterRegistry } from './adapter.registry';
import { AndroidPhoneAdapter } from './adapters/android-phone.adapter';
import { IosPhoneAdapter } from './adapters/ios-phone.adapter';
import { SimulatorAdapter } from './adapters/simulator.adapter';
import { WearOsAdapter } from './adapters/wearos.adapter';
import { type DeviceAdapter, type PromptRequest, type RingRequest, UnsupportedSignalError } from './device.types';
import { classOf, type LadderDevice } from './device-class';
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
    const ids = [...new Set(deviceIds)];
    if (!ids.length) return new Map();
    const rows = await this.db
      .select({ id: sql<string>`${device.id}::text`, kind: device.kind })
      .from(device)
      .where(inArray(sql`${device.id}::text`, ids));
    return new Map(rows.map((r) => [r.id, r.kind]));
  }

  /**
   * Partiyi kanonik hâle getirir: her sinyal kendi cihaz türünün adaptöründen geçer ve sunucu `source`
   * alanını doldurur. Sinyal başına sonuç: desteklenmeyen sinyal (UnsupportedSignalError) yalnız kendisi için
   * `null` döner; partinin geri kalanı etkilenmez (D-01: SOS, yanındaki desteklenmeyen sinyal yüzünden kaybolmaz).
   */
  async prepareEach(batch: Signal[]): Promise<(Signal | null)[]> {
    const kinds = await this.kindsOf(batch.map((s) => s.deviceId));
    return batch.map((raw) => {
      try {
        const adapter = this.registry.for(kinds.get(raw.deviceId) ?? null);
        const s = adapter.normalize(raw);
        return { ...s, source: { kind: adapter.kind, role: adapter.capabilities().role } };
      } catch (e) {
        if (e instanceof UnsupportedSignalError) return null;
        throw e;
      }
    });
  }

  /**
   * T-087 merdiven: kişinin etkin (iptal edilmemiş) cihazları, sınıf ve sesli hedefiyle. Numara ve konum yok.
   * Çağıranın transaction'ında okunabilir (olay kilidi altında).
   */
  async ladderDevices(protectedPersonId: string, q: Db | Tx = this.db): Promise<LadderDevice[]> {
    if (!/^[0-9a-f-]{36}$/i.test(protectedPersonId)) return [];
    const rows = await q
      .select({
        id: sql<string>`${device.id}::text`,
        kind: device.kind,
        lastSeenAt: device.lastSeenAt,
        onWrist: device.onWrist,
      })
      .from(device)
      .where(and(eq(device.protectedPersonId, protectedPersonId), isNull(device.revokedAt)));
    return rows.map((r) => ({ ...r, ...classOf(r) }));
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
