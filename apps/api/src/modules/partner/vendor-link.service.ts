import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { BodyLocation, VendorLinkView } from '@yanimda/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { fail } from '../../common/catalog-error';
import type { FieldCipher } from '../../common/field-cipher';
import { OutboxBus } from '../../common/outbox';
import { safeError } from '../../common/safe-error';
import { DB, type Db } from '../../db/client';
import { auditLog, device, vendorLink } from '../../db/schema';
import { DeviceService } from '../device/device.service';
import { assertDeviceLimits, DeviceLimitError, notifyDeviceLimit } from '../device/device-limits';
import { isBodyLocation } from '../event/coverage.service';

export const VENDOR_CIPHER = Symbol('VENDOR_CIPHER');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VENDOR_ID = /^[\x21-\x7e]{1,200}$/;
const BASES = ['EXPLICIT_CONSENT', 'SCC_NOTIFIED', 'ADEQUACY'] as const;
type Basis = VendorLinkView['consentBasis'];

type Row = typeof vendorLink.$inferSelect;
const view = (r: Row): VendorLinkView => ({
  id: r.id,
  partner: r.partner,
  model: r.modelId,
  deviceId: r.deviceId,
  protectedPersonId: r.protectedPersonId,
  status: r.status as VendorLinkView['status'],
  dataRegion: r.dataRegion,
  consentAt: r.consentAt?.toISOString() ?? null,
  consentBasis: r.consentBasis as Basis,
  createdAt: r.createdAt.toISOString(),
});

/**
 * T-085 OEM (S2.5, S8.1, S9.3): ortak cihazının kişiye bağlanması. Kayıt = bizim cihaz satırı (tür = ortak kodu,
 * katalog modeli, sınıf, bağlantı yolu) + device.vendor_link. Saklanan: üretici cihaz kimliği (eşleme için), üretici
 * hesap kimliği yalnız şifreli (FieldCipher, AAD `vendor-link:<id>`); belirteç tutulmaz (sahte ortakta yok; bulut
 * ortaklarında yalnız şifreli `token_enc`). Ortağın veri bölgesi TR dışıysa açık rıza / aktarım dayanağı ve zamanı
 * zorunlu (KVKK yurt dışı aktarım). Kişi başına cihaz sınırları (S1.7) geçerli. Kaldırma: DELETE /devices/{id}
 * (bağlantı ve belirteç anında geçersiz).
 */
@Injectable()
export class VendorLinkService {
  private readonly log = new Logger('VendorLink');

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OutboxBus) private readonly outbox: OutboxBus,
    @Inject(DeviceService) private readonly devices: Pick<DeviceService, 'partnerAdapter'>,
    @Inject(VENDOR_CIPHER) private readonly cipher: FieldCipher,
  ) {}

  async create(body: unknown, actorId: string, now = new Date()): Promise<VendorLinkView> {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw fail(BadRequestException, 'A-ERR-OBJECT-EXPECTED');
    const b = body as Record<string, unknown>;
    const personId =
      typeof b.protectedPersonId === 'string' && UUID.test(b.protectedPersonId) ? b.protectedPersonId : '';
    if (!personId) throw fail(BadRequestException, 'A-ERR-FIELD-UUID', { field: 'protectedPersonId' });
    const partner = typeof b.partner === 'string' ? b.partner : '';
    const adapter = this.devices.partnerAdapter(partner);
    if (!adapter) throw fail(NotFoundException, 'O-ERR-PARTNER-NOT-FOUND');
    const profile = adapter.profile(typeof b.model === 'string' ? b.model : null);
    if (!profile) throw fail(BadRequestException, 'O-ERR-VENDOR-MODEL');
    const vendorDeviceId =
      typeof b.vendorDeviceId === 'string' && VENDOR_ID.test(b.vendorDeviceId) ? b.vendorDeviceId : '';
    if (!vendorDeviceId)
      throw fail(BadRequestException, 'A-ERR-FIELD-LENGTH', { field: 'vendorDeviceId', min: 1, max: 200 });
    if (
      b.vendorAccountId !== undefined &&
      (typeof b.vendorAccountId !== 'string' || !VENDOR_ID.test(b.vendorAccountId))
    )
      throw fail(BadRequestException, 'A-ERR-FIELD-LENGTH', { field: 'vendorAccountId', min: 1, max: 200 });
    if (b.bodyLocation !== undefined && b.bodyLocation !== null && !isBodyLocation(b.bodyLocation))
      throw fail(BadRequestException, 'A-ERR-FIELD-INVALID', { field: 'bodyLocation' });
    const bodyLocation =
      (b.bodyLocation as BodyLocation | undefined) ?? (profile.category === 'PENDANT' ? 'NECK' : 'HOME');

    // S9.3: yurt dışı veri bölgesi → açık rıza veya aktarım dayanağı (ve zamanı) zorunlu.
    const region = adapter.dataRegion;
    const consent = (b.consent ?? null) as { basis?: unknown; at?: unknown } | null;
    let basis: Basis = 'NOT_REQUIRED';
    let consentAt: Date | null = null;
    if (consent !== null) {
      if (typeof consent !== 'object' || !BASES.includes(consent.basis as (typeof BASES)[number]))
        throw fail(BadRequestException, 'A-ERR-FIELD-ENUM', { field: 'consent.basis', values: BASES.join(' | ') });
      const at = typeof consent.at === 'string' ? new Date(consent.at) : null;
      if (!at || Number.isNaN(at.getTime()) || at > now) throw fail(BadRequestException, 'O-ERR-CONSENT-AT-PAST');
      basis = consent.basis as Basis;
      consentAt = at;
    }
    if (region !== 'TR' && !consentAt) throw fail(BadRequestException, 'O-ERR-CONSENT-REQUIRED');

    const exists = (await this.db.execute(
      sql`SELECT 1 FROM profile.protected_person WHERE id = ${personId}::uuid`,
    )) as unknown as { rows: unknown[] };
    if (!exists.rows.length) throw fail(NotFoundException, 'F-ERR-PERSON-NOT-FOUND');

    const id = uuidv7();
    const deviceId = uuidv7();
    try {
      await this.db.transaction(async (tx) => {
        const [dup] = await tx
          .select({ id: vendorLink.id })
          .from(vendorLink)
          .where(
            and(
              eq(vendorLink.partner, partner),
              eq(vendorLink.vendorDeviceId, vendorDeviceId),
              eq(vendorLink.status, 'ACTIVE'),
            ),
          );
        if (dup) throw fail(ConflictException, 'O-ERR-VENDOR-DEVICE-LINKED');
        await assertDeviceLimits(
          tx,
          personId,
          { modelId: profile.modelId, category: profile.category, tier: profile.tier },
          deviceId,
        );
        await tx.insert(device).values({
          id: deviceId,
          protectedPersonId: personId,
          kind: adapter.kind,
          model: profile.modelId,
          modelId: profile.modelId,
          category: profile.category,
          tier: profile.tier,
          connectionPath: profile.connectionPath,
          bodyLocation,
          vendorDeviceId,
          enrolledAt: now,
        });
        await tx.insert(vendorLink).values({
          id,
          partner,
          vendorDeviceId,
          vendorAccountEnc:
            typeof b.vendorAccountId === 'string' ? this.cipher.encrypt(b.vendorAccountId, `vendor-link:${id}`) : null,
          deviceId,
          protectedPersonId: personId,
          modelId: profile.modelId,
          dataRegion: region,
          consentBasis: basis,
          consentAt,
          createdAt: now,
          createdBy: actorId,
        });
        await tx.insert(auditLog).values({
          actorKind: 'OPERATOR',
          actorId,
          action: 'vendor_link.created',
          entityType: 'device',
          entityId: deviceId,
          data: { partner, model: profile.modelId, dataRegion: region, consentBasis: basis },
        });
      });
    } catch (e) {
      if (e instanceof DeviceLimitError)
        await notifyDeviceLimit(this.outbox, personId, now).catch((err) =>
          this.log.warn(`F-DEVICE-LIMIT yazılamadı: ${safeError(err)}`),
        );
      throw e;
    }
    const [row] = await this.db.select().from(vendorLink).where(eq(vendorLink.id, id));
    return view(row!);
  }

  /** Kişinin üretici bağlantıları (üretici kimlikleri dönmez). */
  async list(protectedPersonId: string): Promise<VendorLinkView[]> {
    if (!UUID.test(protectedPersonId)) throw fail(NotFoundException, 'F-ERR-PERSON-NOT-FOUND');
    const rows = await this.db
      .select()
      .from(vendorLink)
      .where(eq(vendorLink.protectedPersonId, protectedPersonId))
      .orderBy(vendorLink.createdAt);
    return rows.map(view);
  }
}
