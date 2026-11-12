import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import type { PartnerRejectReason, PartnerWebhookResult, Signal } from '@yanimda/contracts';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { DB, type Db } from '../../db/client';
import { auditLog, device, partnerDelivery, partnerLatency, vendorLink } from '../../db/schema';
import { DeviceService } from '../device/device.service';
import { type AcceptResult, SignalService } from '../signal/signal.service';
import {
  NONCE_HEADER,
  type PartnerAdapter,
  partnerIdempotencyKey,
  SIGNATURE_HEADER,
  SIGNATURE_TOLERANCE_SEC,
  signatureValid,
  TIMESTAMP_HEADER,
} from './partner.types';

export const PARTNER_CLOCK = Symbol('PARTNER_CLOCK');
export const PARTNER_SECRETS = Symbol('PARTNER_SECRETS');
/** Ortak kodu → webhook sırrı (yoksa null: ortak kapalı, uç 404). */
export type PartnerSecrets = (partner: string) => string | null;

const PARTNER = /^[A-Z][A-Z0-9_]{1,39}$/;
/** Örnek üst sınırı (int; ~24 gün): kesintiden sonra toplu gelen eski olay p99'u yine bozar, taşma olmaz. */
const MAX_LATENCY_MS = 2_147_483_647;
const NONCE = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Sırlar ortamdan: `PARTNER_<KOD>_WEBHOOK_SECRET` (kodda sır yok; .env.example). Sahte ortaklar (FAKE_*) üretimde
 * yalnız `PARTNER_FAKE_ENABLED=true` ile açılır.
 */
export function partnerSecretsFromEnv(env: NodeJS.ProcessEnv = process.env): PartnerSecrets {
  return (partner) => {
    if (!PARTNER.test(partner)) return null;
    const v = env[`PARTNER_${partner}_WEBHOOK_SECRET`];
    if (!v) return null;
    if (partner.startsWith('FAKE_') && env.NODE_ENV === 'production' && env.PARTNER_FAKE_ENABLED !== 'true')
      return null;
    return v;
  };
}

type Headers = Record<string, string | string[] | undefined>;
const header = (h: Headers, k: string) => {
  const v = h[k] ?? h[k.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * T-085 OEM imzalı ortak webhook'u (docs/07 S2.5, S2.6). Sıra:
 *  1. Ortak kayıtlı ve sırrı tanımlı (değilse 404).
 *  2. İmza: `X-Partner-Timestamp` (unix sn, ±5 dk), `X-Partner-Nonce` (teslim başına tek), `X-Partner-Signature`
 *     `v1=<hex>` = HMAC-SHA256(sır, "<ts>.<nonce>.<ham gövde>"); geçersiz / süresi geçmiş → 401.
 *  3. Tekrar koruması: (ortak, nonce) bir kez (device.partner_delivery); aynı nonce → 409. İşlem 5xx ile biterse nonce
 *     serbest bırakılır (ortak aynı teslimi yeniden deneyebilir).
 *  4. Olaylar ortak adaptörüyle kanonik sinyale çevrilir; idempotencyKey üretici olay kimliğinden (aynı olay yeni
 *     nonce ile yeniden gelirse `duplicates`). Bilinmeyen / bağlantısı kaldırılmış cihaz UNKNOWN_DEVICE, okunamayan olay
 *     EVENT_INVALID, profil dışı sinyal UNSUPPORTED_SIGNAL — yalnız o olay reddedilir ve denetime yazılır.
 *  5. Sinyaller cihaz sinyalleriyle aynı hattan yazılır (SignalService: signal.signal + outbox aynı transaction).
 *  6. Yeni yazılan her olayın gecikmesi (olay anı → alım) ortak gecikmesi örneği olur (S2.7).
 * Log'da kişi / cihaz / üretici kimliği yok: yalnız ortak kodu ve sayılar.
 */
@Injectable()
export class PartnerWebhookService {
  private readonly log = new Logger('PartnerWebhook');
  private readonly secrets: PartnerSecrets;
  private readonly clock: () => Date;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(SignalService) private readonly signals: Pick<SignalService, 'accept'>,
    @Inject(DeviceService) private readonly devices: Pick<DeviceService, 'partnerAdapter'>,
    @Optional() @Inject(PARTNER_SECRETS) secrets?: PartnerSecrets,
    @Optional() @Inject(PARTNER_CLOCK) clock?: () => Date,
  ) {
    this.secrets = secrets ?? partnerSecretsFromEnv();
    this.clock = clock ?? (() => new Date());
  }

  async ingest(partner: string, input: { rawBody: Buffer; headers: Headers }): Promise<PartnerWebhookResult> {
    const now = this.clock();
    const adapter = PARTNER.test(partner) ? this.devices.partnerAdapter(partner) : null;
    const secret = adapter ? this.secrets(partner) : null;
    if (!adapter || !secret) throw new NotFoundException('Ortak bulunamadı');

    const ts = Number(header(input.headers, TIMESTAMP_HEADER));
    const nonce = header(input.headers, NONCE_HEADER) ?? '';
    if (!Number.isInteger(ts) || !NONCE.test(nonce)) throw new UnauthorizedException('İmza başlıkları eksik');
    if (Math.abs(now.getTime() / 1000 - ts) > SIGNATURE_TOLERANCE_SEC)
      throw new UnauthorizedException('İmza zaman damgası pencere dışında');
    if (!signatureValid(secret, ts, nonce, input.rawBody, header(input.headers, SIGNATURE_HEADER))) {
      this.log.warn(`${partner}: imza geçersiz`);
      throw new UnauthorizedException('İmza geçersiz');
    }

    const fresh = await this.db
      .insert(partnerDelivery)
      .values({ partner, nonce, receivedAt: now })
      .onConflictDoNothing()
      .returning({ nonce: partnerDelivery.nonce });
    if (!fresh.length) {
      await this.audit(partner, 'partner.webhook_replay', {});
      throw new ConflictException('Teslim daha önce alındı (nonce)');
    }
    try {
      return await this.process(adapter, input.rawBody, now);
    } catch (e) {
      if (!(e instanceof HttpException) || e.getStatus() >= 500)
        await this.db
          .delete(partnerDelivery)
          .where(and(eq(partnerDelivery.partner, partner), eq(partnerDelivery.nonce, nonce)))
          .catch(() => undefined);
      throw e;
    }
  }

  private async process(adapter: PartnerAdapter, rawBody: Buffer, now: Date): Promise<PartnerWebhookResult> {
    const partner = adapter.partner;
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new BadRequestException('Gövde JSON değil');
    }
    const parsed = adapter.parse(body);
    if (!parsed.length) throw new BadRequestException('Olay listesi boş veya okunamadı');

    const links = await this.linksOf(
      partner,
      parsed.flatMap((p) => (p.ok ? [p.vendorDeviceId] : [])),
    );
    const rejected: PartnerWebhookResult['rejected'] = [];
    const batch: Signal[] = [];
    const vendorIds: string[] = [];
    for (const p of parsed) {
      if (!p.ok) {
        rejected.push({ eventId: p.vendorEventId, reason: 'EVENT_INVALID' });
        continue;
      }
      const link = links.get(p.vendorDeviceId);
      if (!link) {
        rejected.push({ eventId: p.vendorEventId, reason: 'UNKNOWN_DEVICE' });
        continue;
      }
      batch.push({
        schemaVersion: 1,
        idempotencyKey: partnerIdempotencyKey(partner, p.vendorEventId),
        deviceId: link.deviceId,
        protectedPersonId: link.personId,
        occurredAt: p.occurredAt,
        ...p.draft,
        payload: { ...p.draft.payload, vendorEventId: p.vendorEventId },
      });
      vendorIds.push(p.vendorEventId);
    }
    // Bilinmeyen cihaz / okunamayan olay denetime (profil dışı sinyali SignalService yazar). PII yok.
    for (const r of rejected) await this.audit(partner, 'partner.event_rejected', { reason: r.reason });

    const samples: { partner: string; at: Date; latencyMs: number }[] = [];
    let result: AcceptResult = { accepted: 0, duplicates: 0, rejected: [] };
    if (batch.length) {
      try {
        result = await this.signals.accept(batch, new Map(), {
          onAccepted: (s) =>
            samples.push({
              partner,
              at: now,
              latencyMs: Math.min(MAX_LATENCY_MS, Math.max(0, now.getTime() - Date.parse(s.occurredAt))),
            }),
        });
      } catch (e) {
        // Partide yazılabilecek sinyal yok: ret listesi yanıta (ortak bunları yeniden göndermez).
        const r = (e as HttpException).getResponse?.() as { rejected?: AcceptResult['rejected'] } | undefined;
        if (!(e instanceof BadRequestException || e instanceof ForbiddenException) || !r?.rejected) throw e;
        result = { accepted: 0, duplicates: 0, rejected: r.rejected };
      }
    }
    for (const r of result.rejected)
      rejected.push({ eventId: vendorIds[r.index] ?? null, reason: r.reason as PartnerRejectReason });
    if (samples.length) await this.db.insert(partnerLatency).values(samples);
    this.log.log(
      `${partner}: ${result.accepted} alındı, ${result.duplicates} tekrar, ${rejected.length} ret (${parsed.length} olay)`,
    );
    return { accepted: result.accepted, duplicates: result.duplicates, rejected };
  }

  /** Etkin bağlantılar (cihaz kaldırılmamış / emekli değil): üretici cihaz kimliği → bizim cihaz ve kişi. */
  private async linksOf(partner: string, vendorDeviceIds: string[]) {
    const ids = [...new Set(vendorDeviceIds)];
    if (!ids.length) return new Map<string, { deviceId: string; personId: string }>();
    const rows = await this.db
      .select({
        vendorDeviceId: vendorLink.vendorDeviceId,
        deviceId: sql<string>`${vendorLink.deviceId}::text`,
        personId: sql<string>`${vendorLink.protectedPersonId}::text`,
      })
      .from(vendorLink)
      .innerJoin(device, eq(device.id, vendorLink.deviceId))
      .where(
        and(
          eq(vendorLink.partner, partner),
          eq(vendorLink.status, 'ACTIVE'),
          inArray(vendorLink.vendorDeviceId, ids),
          isNull(device.revokedAt),
          isNull(device.retiredAt),
        ),
      );
    return new Map(rows.map((r) => [r.vendorDeviceId, { deviceId: r.deviceId, personId: r.personId }]));
  }

  private async audit(partner: string, action: string, data: Record<string, unknown>) {
    await this.db
      .insert(auditLog)
      .values({ actorKind: 'SYSTEM', action, entityType: 'partner', entityId: partner, data: { partner, ...data } });
  }
}
