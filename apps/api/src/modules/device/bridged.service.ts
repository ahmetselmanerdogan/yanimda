import { createHmac } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { BodyLocation, BridgedDeviceModel, BridgedDeviceView } from '@yanimda/contracts';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { OutboxBus } from '../../common/outbox';
import { safeError } from '../../common/safe-error';
import { DB, type Db } from '../../db/client';
import { auditLog, device } from '../../db/schema';
import { ProtectionService } from '../event/protection.service';
import { BRIDGED_MODELS, BRIDGED_PROFILES, isBridgedModel } from './adapters/ble-bridged.adapter';
import { assertDeviceLimits, classOf, DeviceLimitError, notifyDeviceLimit } from './device-limits';
import { deviceTokenSecret } from './device-token';
import type { DevicePrincipal } from './enrollment.service';

const PHONE_KINDS: readonly string[] = ['ANDROID_PHONE', 'IOS_PHONE'];
/** İstemcinin gönderdiği adres özeti: büyük harf, iki nokta ayraçlı MAC'in ("AA:BB:CC:DD:EE:FF") SHA-256'sı (hex). */
const SHA256_HEX = /^[0-9a-f]{64}$/;
const RAW_MAC = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$|^[0-9a-f]{12}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LOCATION: Record<BridgedDeviceModel, BodyLocation | null> = {
  BLE_HR: 'CHEST',
  BLE_PULSE_OX: 'FINGER',
  BLE_THERMO: null,
  BLE_PENDANT: 'NECK',
};

/**
 * Sunucu tarafı anahtar: BLE_ADDRESS_PEPPER (≥ 32 karakter), yoksa tek DEVICE_TOKEN_SECRET (döndürülen
 * DEVICE_TOKEN_SECRETS değil; üretimde biri zorunlu). Saklanan değer HMAC-SHA256(anahtar, "<telefonId>:<istemci
 * özeti>"): ham MAC hiç gelmez, istemci özeti de saklanmaz; aynı cihaz başka telefonda başka değer üretir (kişiler
 * arası eşleştirme yok).
 */
export function bridgeAddressKey(env: NodeJS.ProcessEnv = process.env): string {
  const p = env.BLE_ADDRESS_PEPPER;
  return p && p.length >= 32 ? p : deviceTokenSecret(env);
}
export const storedAddressHash = (key: string, phoneId: string, clientHash: string) =>
  createHmac('sha256', key).update(`${phoneId}:${clientHash}`).digest('hex');

type Row = typeof device.$inferSelect;
const view = (r: Row): BridgedDeviceView => {
  const model = r.kind as BridgedDeviceModel;
  const p = BRIDGED_PROFILES[model];
  return {
    deviceId: r.id,
    model,
    category: p.category,
    tier: p.tier,
    signals: [...p.signals],
    bridgeDeviceId: r.bridgeDeviceId!,
    nickname: r.nickname ?? null,
    createdAt: (r.enrolledAt ?? r.createdAt).toISOString(),
  };
};

/**
 * T-092 (docs/07 S2.1 B sınıfı, S4.8, S7.5) BLE köprülü cihaz sözleşmesi — yalnız sunucu tarafı:
 *  - `POST /devices/bridged`: yaşlının telefonu (cihaz token'ı, ANDROID_PHONE / IOS_PHONE) BLE cihazı kaydeder; cihaz
 *    aynı kişiye ve köprü telefona bağlanır. (telefon, adres özeti) başına tek etkin kayıt: yeniden kayıt aynı
 *    kimliği döner (200), yeni kayıt 201. Kişi başına cihaz sınırları (S1.7) geçerlidir.
 *  - Telefon sinyalleri mevcut yoldan (`POST /signals`, telefon token'ı) bu kimlikle iletir; CompanionService yalnız
 *    bu telefona bağlı etkin köprülü cihazları kabul eder, adaptör yalnız model profilindeki sinyal türlerini.
 *  - `DELETE /devices/bridged/{id}`: köprüyü kaldırır (cihaz iptal + emekli, kapsama yeniden hesaplanır). Telefon
 *    kaldırılınca (DELETE /devices/{telefon}) ona bağlı köprülü cihazlar da kaldırılır.
 * Log'da kişi / cihaz / adres yok.
 */
@Injectable()
export class BridgedDeviceService {
  private readonly log = new Logger('Bridged');
  private readonly key: string;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OutboxBus) private readonly outbox: Pick<OutboxBus, 'publish'>,
    @Optional() @Inject(ProtectionService) private readonly protection?: Pick<ProtectionService, 'coverage'>,
    @Optional() @Inject('BLE_ADDRESS_KEY') key?: string,
  ) {
    this.key = key ?? bridgeAddressKey();
  }

  async register(
    p: DevicePrincipal,
    body: unknown,
    now = new Date(),
  ): Promise<{ created: boolean; view: BridgedDeviceView }> {
    if (!PHONE_KINDS.includes(p.kind)) throw new ForbiddenException('Köprülü cihazı yalnız yaşlının telefonu kaydeder');
    const b = parseRegister(body);
    const hash = storedAddressHash(this.key, p.deviceId, b.addressHash);
    const cls = await classOf(this.db, b.model);
    try {
      return await this.db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(device)
          .where(
            and(eq(device.bridgeDeviceId, p.deviceId), eq(device.bridgeAddressHash, hash), isNull(device.revokedAt)),
          )
          .for('update');
        if (existing) {
          if (existing.kind !== b.model) throw new ConflictException('Bu adres başka bir modelle kayıtlı');
          if (b.name !== undefined && b.name !== existing.nickname) {
            await tx.update(device).set({ nickname: b.name }).where(eq(device.id, existing.id));
            existing.nickname = b.name;
          }
          return { created: false, view: view(existing) };
        }
        const id = uuidv7();
        await assertDeviceLimits(tx, p.protectedPersonId, cls, id);
        const [row] = await tx
          .insert(device)
          .values({
            id,
            protectedPersonId: p.protectedPersonId,
            kind: b.model,
            modelId: cls.modelId,
            category: cls.category,
            tier: cls.tier,
            bodyLocation: DEFAULT_LOCATION[b.model],
            connectionPath: 'PHONE_BRIDGE',
            bridgeDeviceId: p.deviceId,
            bridgeAddressHash: hash,
            nickname: b.name ?? null,
            enrolledAt: now,
          })
          .returning();
        await tx.insert(auditLog).values({
          actorKind: 'USER',
          actorId: p.deviceId,
          action: 'device.bridged',
          entityType: 'device',
          entityId: id,
          data: { model: b.model },
        });
        return { created: true, view: view(row!) };
      });
    } catch (e) {
      if (e instanceof DeviceLimitError)
        await notifyDeviceLimit(this.outbox, e.protectedPersonId, now).catch((err: unknown) =>
          this.log.warn(`F-DEVICE-LIMIT yazılamadı: ${safeError(err)}`),
        );
      throw e;
    }
  }

  async list(p: DevicePrincipal): Promise<BridgedDeviceView[]> {
    if (!PHONE_KINDS.includes(p.kind)) throw new ForbiddenException('Yalnız yaşlının telefonu');
    const rows = await this.db
      .select()
      .from(device)
      .where(
        and(eq(device.bridgeDeviceId, p.deviceId), inArray(device.kind, BRIDGED_MODELS), isNull(device.revokedAt)),
      );
    return rows.map(view).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Köprüyü kaldırır (yalnız bu telefona bağlı cihaz; yoksa 404). Zaten kaldırılmışsa sessizce biter. */
  async unbridge(p: DevicePrincipal, deviceId: string, now = new Date()): Promise<void> {
    if (!PHONE_KINDS.includes(p.kind)) throw new ForbiddenException('Yalnız yaşlının telefonu');
    if (!UUID.test(deviceId)) throw new NotFoundException('Cihaz bulunamadı');
    const id = deviceId.toLowerCase();
    const [r] = await this.db
      .select({ id: device.id, revokedAt: device.revokedAt })
      .from(device)
      .where(and(eq(device.id, id), eq(device.bridgeDeviceId, p.deviceId), inArray(device.kind, BRIDGED_MODELS)));
    if (!r) throw new NotFoundException('Cihaz bulunamadı');
    if (r.revokedAt) return;
    await this.revoke([id], p.protectedPersonId, { kind: 'USER', id: p.deviceId }, now);
  }

  /** Telefon kaldırılınca ona bağlı köprülü cihazlar da kaldırılır (S4.8: köprü yoksa koruma yok). */
  async revokeBridgedOf(
    phoneId: string,
    actor: { kind: string; id: string | null },
    now = new Date(),
  ): Promise<number> {
    const rows = await this.db
      .select({ id: device.id, personId: device.protectedPersonId })
      .from(device)
      .where(and(eq(device.bridgeDeviceId, phoneId), inArray(device.kind, BRIDGED_MODELS), isNull(device.revokedAt)));
    if (!rows.length) return 0;
    await this.revoke(
      rows.map((r) => r.id),
      rows[0]!.personId,
      actor,
      now,
    );
    return rows.length;
  }

  private async revoke(ids: string[], personId: string, actor: { kind: string; id: string | null }, now: Date) {
    await this.db.transaction(async (tx) => {
      await tx
        .update(device)
        .set({ revokedAt: now, retiredAt: now })
        .where(and(inArray(device.id, ids), isNull(device.revokedAt)));
      await tx.insert(auditLog).values(
        ids.map((id) => ({
          actorKind: actor.kind,
          actorId: actor.id,
          action: 'device.unbridged',
          entityType: 'device',
          entityId: id,
          data: null,
        })),
      );
    });
    for (const id of ids) await this.protection?.coverage.removeDevice(personId, id, now);
    this.log.log(`${ids.length} köprülü cihaz kaldırıldı`);
  }
}

function parseRegister(body: unknown): { model: BridgedDeviceModel; addressHash: string; name?: string | null } {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw new BadRequestException('Nesne bekleniyor');
  const b = body as Record<string, unknown>;
  const unknownKeys = Object.keys(b).filter((k) => !['model', 'addressHash', 'name'].includes(k));
  if (unknownKeys.length) throw new BadRequestException(`Bilinmeyen alan: ${unknownKeys.join(', ')}`);
  if (!isBridgedModel(b.model)) throw new BadRequestException(`model: ${BRIDGED_MODELS.join(' | ')}`);
  if (typeof b.addressHash !== 'string') throw new BadRequestException('addressHash zorunlu');
  if (RAW_MAC.test(b.addressHash)) throw new BadRequestException('Ham BLE adresi gönderilmez; SHA-256 özeti gönderin');
  if (!SHA256_HEX.test(b.addressHash)) throw new BadRequestException('addressHash 64 haneli küçük harf hex olmalı');
  let name: string | null | undefined;
  if (b.name !== undefined) {
    const n = typeof b.name === 'string' ? b.name.trim() : b.name;
    if (n !== null && (typeof n !== 'string' || n.length < 1 || n.length > 40))
      throw new BadRequestException('name 1–40 karakter olmalı');
    name = n as string | null;
  }
  return { model: b.model, addressHash: b.addressHash, ...(name !== undefined ? { name } : {}) };
}
