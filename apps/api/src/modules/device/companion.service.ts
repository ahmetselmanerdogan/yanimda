import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { type KafkaEnvelope, type NotifyRequest, TOPICS } from '@yanimda/contracts';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { v7 as uuidv7 } from 'uuid';

import { OutboxBus } from '../../common/outbox';
import { safeError } from '../../common/safe-error';
import { DB, type Db } from '../../db/client';
import { device } from '../../db/schema';
import { loadRulePack, RULES, type RulesProvider, staticRules } from '../event/rules.loader';
import { REDIS } from '../signal/idempotency.store';
import type { SignalRejectReason } from '../signal/signal-reject';
import { assertDeviceLimits, classOf, DeviceLimitError, notifyDeviceLimit } from './device-limits';
import { type DevicePrincipal, EnrollmentService, type TokenResponse } from './enrollment.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE_KINDS: readonly string[] = ['ANDROID_PHONE', 'IOS_PHONE'];
const str = (v: unknown, max: number) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);

/** Kurulum sihirbazının bildirebileceği eksikler (yanimda-android `Requirement`). */
export const SETUP_REQUIREMENTS = [
  'NOTIFICATIONS',
  'CALLS',
  'LOCATION',
  'LOCATION_BACKGROUND',
  'MOTION',
  'BATTERY',
  'WATCH',
  'HEALTH',
] as const;

export interface SetupStateView {
  deviceId: string;
  kind: string;
  step: string;
  completed: boolean;
  missing: string[];
  watchPaired: boolean | null;
  updatedAt: string;
}

const setupKey = (deviceId: string) => `device:setup:${deviceId}`;

/**
 * Telefon ↔ saat bağı (B-03) ve kurulum ilerlemesi (B-02, T-042):
 * - Telefon, eşleşik saatini aynı kişiye kaydeder (`POST /devices/{telefon}/companions`); saatte kod yazılmaz.
 * - Telefon token'ı aynı kişinin etkin saat(ler)inin sinyallerini köprüleyebilir (saat cihaz kimliğiyle; adaptör
 *   WEAROS_WATCH). Başka kişi, iptal edilmiş saat veya telefon olmayan token → o sinyal reddedilir (yazılmaz);
 *   partinin geri kalanı yazılır. Partide kabul edilebilir sinyal yoksa 403.
 * - Kurulum durumu Redis'te (kalıcı şema gerekmez; aile ekranı için anlık görüntü). Kurulum eksik izinle bittiyse
 *   aileye F-PERM (gün başına aynı eksik kümesi için bir kez).
 * Log'da kişi/cihaz kimliği, token yok.
 */
@Injectable()
export class CompanionService {
  private readonly log = new Logger('Companion');
  private readonly rules: RulesProvider;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Pick<Redis, 'get' | 'set'>,
    @Inject(OutboxBus) private readonly outbox: Pick<OutboxBus, 'publish'>,
    @Inject(EnrollmentService) private readonly enrollment: Pick<EnrollmentService, 'issueToken'>,
    @Optional() @Inject(RULES) rules?: RulesProvider,
  ) {
    this.rules = rules ?? staticRules(loadRulePack());
  }

  // MARK: Saat kaydı

  async enrollCompanion(
    p: DevicePrincipal,
    body: unknown,
    now = new Date(),
  ): Promise<{ created: boolean; body: TokenResponse }> {
    if (!PHONE_KINDS.includes(p.kind)) throw new ForbiddenException('Yalnız eşlikçi telefon saat kaydedebilir');
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof b.deviceId !== 'string' || !UUID.test(b.deviceId)) throw new BadRequestException('deviceId UUID olmalı');
    if ((b.kind ?? 'WEAROS_WATCH') !== 'WEAROS_WATCH') throw new BadRequestException('kind WEAROS_WATCH olmalı');
    const id = b.deviceId.toLowerCase();
    if (id === p.deviceId) throw new BadRequestException('Telefon kendini saat olarak kaydedemez');
    const base = {
      protectedPersonId: p.protectedPersonId,
      kind: 'WEAROS_WATCH',
      model: str(b.model, 100) ?? null,
      osVersion: str(b.osVersion, 50) ?? null,
      appVersion: str(b.appVersion, 50) ?? null,
    };

    const created = await this.db
      .transaction(async (tx) => {
        const [row] = await tx
          .select({ personId: device.protectedPersonId, kind: device.kind, revokedAt: device.revokedAt })
          .from(device)
          .where(eq(device.id, id))
          .for('update');
        const cls = await classOf(tx, 'WEAROS_WATCH');
        const fields = { ...base, modelId: cls.modelId, category: cls.category, tier: cls.tier, retiredAt: null };
        // T-085 (S1.7): yeni veya yeniden etkinleşen saat kişi başına sınırlara takılabilir.
        if (!row || row.revokedAt) await assertDeviceLimits(tx, p.protectedPersonId, cls, id);
        if (!row) {
          await tx.insert(device).values({ id, ...fields, enrolledAt: now });
          return true;
        }
        if (row.revokedAt) {
          // Kaldırılmış saat yeniden eşleşir; eski token'ları geçersiz kalır (enrolledAt yenilenir).
          await tx
            .update(device)
            .set({
              ...fields,
              enrolledAt: now,
              revokedAt: null,
              pushProvider: null,
              pushToken: null,
              pushSandbox: null,
            })
            .where(eq(device.id, id));
          return true;
        }
        if (row.personId !== p.protectedPersonId || row.kind !== 'WEAROS_WATCH')
          throw new ConflictException('Bu cihaz kimliği zaten kayıtlı');
        // Aynı kişinin etkin saati: yeniden deneme (yanıt yolda kayboldu) veya telefon yeniden kuruldu → yeni token.
        await tx
          .update(device)
          .set({ model: fields.model, osVersion: fields.osVersion, appVersion: fields.appVersion })
          .where(eq(device.id, id));
        return false;
      })
      .catch(async (e: unknown) => {
        if (e instanceof DeviceLimitError)
          await notifyDeviceLimit(this.outbox, e.protectedPersonId, now).catch((err: unknown) =>
            this.log.warn(`F-DEVICE-LIMIT yazılamadı: ${safeError(err)}`),
          );
        throw e;
      });
    this.log.log(`Saat telefon üzerinden kaydedildi${created ? '' : ' (yeniden)'}`);
    return {
      created,
      body: this.enrollment.issueToken(
        { deviceId: id, protectedPersonId: p.protectedPersonId, kind: 'WEAROS_WATCH' },
        now,
      ),
    };
  }

  // MARK: Köprü yetkisi

  /**
   * Token'lı partinin izni (signal.controller), sinyal başına: her sinyal token'ın kişisine ait olmalı; deviceId
   * token'ın cihazı değilse token telefon olmalı ve cihaz aynı kişinin etkin saati olmalı. Uymayan sinyalin sırası
   * nedeniyle döner; SignalService yalnız onu reddeder (D-01: telefonun SOS'u, aynı partideki az önce iptal edilmiş
   * saatin HEARTBEAT'i yüzünden kaybolmaz). Partide kabul edilebilir sinyal kalmazsa SignalService 403 döner.
   * Reddedilen sinyal hiç yazılmaz; kabul edilenler zaten token'ın yetkisinde — sinyal başına ret yetki açmaz.
   */
  async authorizeBatch(p: DevicePrincipal | undefined, batch: unknown): Promise<Map<number, SignalRejectReason>> {
    const denied = new Map<number, SignalRejectReason>();
    if (!p || !Array.isArray(batch)) return denied;
    const bridged = new Map<number, string>();
    (batch as ({ deviceId?: unknown; protectedPersonId?: unknown } | null)[]).forEach((s, i) => {
      if (s?.protectedPersonId !== p.protectedPersonId) denied.set(i, 'PERSON_MISMATCH');
      else if (s.deviceId === p.deviceId) return;
      else if (
        !PHONE_KINDS.includes(p.kind) ||
        typeof s.deviceId !== 'string' ||
        !UUID.test(s.deviceId) ||
        s.deviceId !== s.deviceId.toLowerCase()
      )
        denied.set(i, 'DEVICE_MISMATCH');
      else bridged.set(i, s.deviceId);
    });
    if (!bridged.size) return denied;
    const rows = await this.db
      .select({ id: sql<string>`${device.id}::text` })
      .from(device)
      .where(
        and(
          inArray(sql`${device.id}::text`, [...new Set(bridged.values())]),
          eq(device.protectedPersonId, p.protectedPersonId),
          eq(device.kind, 'WEAROS_WATCH'),
          isNull(device.revokedAt),
        ),
      );
    const active = new Set(rows.map((r) => r.id));
    for (const [i, id] of bridged) if (!active.has(id)) denied.set(i, 'DEVICE_NOT_BRIDGED');
    return denied;
  }

  // MARK: Kurulum durumu

  async setSetupState(p: DevicePrincipal, body: unknown, now = new Date()): Promise<void> {
    const b = (body ?? {}) as Record<string, unknown>;
    const step = str(b.step, 40);
    if (!step || !/^[A-Z_]+$/.test(step)) throw new BadRequestException('step zorunlu (BÜYÜK_HARF)');
    if (typeof b.completed !== 'boolean') throw new BadRequestException('completed boolean olmalı');
    const rawMissing = b.missing ?? [];
    if (!Array.isArray(rawMissing) || rawMissing.length > SETUP_REQUIREMENTS.length)
      throw new BadRequestException('missing dizi olmalı');
    for (const m of rawMissing)
      if (!SETUP_REQUIREMENTS.includes(m as (typeof SETUP_REQUIREMENTS)[number]))
        throw new BadRequestException(`missing şunlardan olmalı: ${SETUP_REQUIREMENTS.join(', ')}`);
    const missing = [...new Set(rawMissing as string[])].sort();
    const view: SetupStateView = {
      deviceId: p.deviceId,
      kind: p.kind,
      step,
      completed: b.completed,
      missing,
      watchPaired: typeof b.watchPaired === 'boolean' ? b.watchPaired : null,
      updatedAt: now.toISOString(),
    };
    await this.redis.set(setupKey(p.deviceId), JSON.stringify(view));
    if (!view.completed || !missing.length) return;
    const day = now.toISOString().slice(0, 10);
    const payload: NotifyRequest = {
      code: 'F-PERM',
      audience: 'FAMILY',
      protectedPersonId: p.protectedPersonId,
      dedupeKey: `setup-perm:${p.deviceId}:${day}:${missing.join(',')}`,
    };
    const env: KafkaEnvelope<NotifyRequest> = {
      eventId: uuidv7(),
      type: TOPICS.notifyRequested,
      version: 1,
      occurredAt: now.toISOString(),
      countryCode: this.rules.current().country,
      subjectUserId: p.protectedPersonId,
      payload,
    };
    await this.outbox.publish(TOPICS.notifyRequested, env);
  }

  /** Aile ekranı: kişinin etkin cihazlarının son kurulum durumu (bildirmemiş cihaz listede yok). */
  async setupStates(protectedPersonId: string): Promise<SetupStateView[]> {
    const rows = await this.db
      .select({ id: device.id })
      .from(device)
      .where(and(eq(device.protectedPersonId, protectedPersonId), isNull(device.revokedAt)));
    const out: SetupStateView[] = [];
    for (const r of rows) {
      try {
        const v = await this.redis.get(setupKey(r.id));
        if (v) out.push(JSON.parse(v) as SetupStateView);
      } catch (e) {
        this.log.warn(`Kurulum durumu okunamadı: ${safeError(e)}`);
      }
    }
    return out.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }
}
