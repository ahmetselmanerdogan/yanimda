import { ConflictException } from '@nestjs/common';
import { type DeviceCategory, type DeviceTier, type NotifyRequest, TOPICS } from '@yanimda/contracts';
import { t } from '@yanimda/messages';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import type { OutboxBus } from '../../common/outbox';
import type { Db, Tx } from '../../db/client';
import { deviceModel } from '../../db/schema';
import { DEFAULT_TIER, isWearable } from '../event/coverage';
import { activeDeviceCounts } from '../event/coverage.service';

/**
 * T-085 (S1.7) kişi başına cihaz sınırları: en çok 6 etkin cihaz, en çok 3 alarm sınıfı (A) giyilebilir, tam 1 yaşlı
 * telefonu (sesli arama yolu tek ve net kalsın; kayıtta "en çok 1" denetlenir). Kaldırılmış (revoked) ve emekli
 * (retired) cihazlar sayılmaz. Fiyat paketine bağlanması kararı açık (S10.2).
 */
export const DEVICE_LIMITS = { total: 6, alarmWearables: 3, phones: 1 } as const;

export interface DeviceClass {
  modelId: string | null;
  category: DeviceCategory;
  tier: DeviceTier;
}

/** Cihaz türünün kataloğdaki kategori ve sınıfı; katalog satırı yoksa türden türetilir. */
export async function classOf(tx: Pick<Db, 'select'>, kind: string): Promise<DeviceClass> {
  const [m] = await tx
    .select({ id: deviceModel.id, category: deviceModel.category, tier: deviceModel.tier })
    .from(deviceModel)
    .where(eq(deviceModel.id, kind));
  if (m) return { modelId: m.id, category: m.category as DeviceCategory, tier: m.tier as DeviceTier };
  const category: DeviceCategory = kind.endsWith('PHONE') ? 'PHONE' : 'WATCH';
  return { modelId: null, category, tier: DEFAULT_TIER[category] };
}

/** Sınır aşımı: problem gövdesinde katalog kodu F-DEVICE-LIMIT (409). */
export class DeviceLimitError extends ConflictException {
  constructor(readonly protectedPersonId: string) {
    super({ message: t('F-DEVICE-LIMIT', 'tr'), code: 'F-DEVICE-LIMIT' });
  }
}

/** Yeni cihaz eklenince sınır aşılıyor mu (transaction içinde çağrılır; `deviceId` yeniden kayıtta hariç tutulur). */
export async function assertDeviceLimits(
  tx: Pick<Tx, 'select'>,
  protectedPersonId: string,
  cls: DeviceClass,
  deviceId: string,
): Promise<void> {
  const c = await activeDeviceCounts(tx, protectedPersonId, deviceId);
  const over =
    c.total + 1 > DEVICE_LIMITS.total ||
    (cls.category === 'PHONE' && c.phones + 1 > DEVICE_LIMITS.phones) ||
    (cls.tier === 'A' && isWearable(cls) && c.alarmWearables + 1 > DEVICE_LIMITS.alarmWearables);
  if (over) throw new DeviceLimitError(protectedPersonId);
}

/** Aileye F-DEVICE-LIMIT (gün başına bir kez; dağıtım T-053). Reddedilen kaydın transaction'ı dışında yazılır. */
export async function notifyDeviceLimit(outbox: Pick<OutboxBus, 'publish'>, protectedPersonId: string, now: Date) {
  const payload: NotifyRequest = {
    code: 'F-DEVICE-LIMIT',
    audience: 'FAMILY',
    protectedPersonId,
    dedupeKey: `device-limit:${protectedPersonId}:${now.toISOString().slice(0, 10)}`,
  };
  await outbox.publish(TOPICS.notifyRequested, {
    eventId: uuidv7(),
    type: TOPICS.notifyRequested,
    version: 1,
    occurredAt: now.toISOString(),
    countryCode: process.env.COUNTRY_CODE ?? 'TR',
    subjectUserId: protectedPersonId,
    payload,
  });
}
