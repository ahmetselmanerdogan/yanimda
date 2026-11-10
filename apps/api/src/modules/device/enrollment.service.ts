import { createHash, randomInt } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { catalogs } from '@yanimda/messages';
import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { v4 as uuidv4 } from 'uuid';

import { safeError } from '../../common/safe-error';
import { DB, type Db } from '../../db/client';
import { contact, device, invite } from '../../db/schema';
import { subscriptionProtection } from '../billing/subscription-protection';
import { inactivityThreshold } from '../event/decide';
import { ProtectionService } from '../event/protection.service';
import { loadRulePack, ruleFor, RULES, type RulesProvider, staticRules } from '../event/rules.loader';
import { REDIS } from '../signal/idempotency.store';
import { DEVICE_TOKEN_REFRESH_BEFORE_SEC, deviceTokenSecret, signDeviceToken, verifyDeviceToken } from './device-token';

export const INVITE_TTL_MS = 15 * 60_000;
/** Aynı IP'den 15 dk içinde en fazla bu kadar hatalı kod (6 hane = 10⁶ olasılık; kaba kuvveti durdurur). */
export const ENROLL_MAX_FAILURES = 10;
const ENROLL_FAIL_WINDOW_SEC = 15 * 60;

/** Kayıt olabilen türler. SIMULATOR kayıt olmaz (kayıtsız cihaz zaten simülatöre düşer, üretimde kapalı). */
export const ENROLLABLE_KINDS = ['WEAROS_WATCH', 'ANDROID_PHONE', 'IOS_PHONE'] as const;
type EnrollableKind = (typeof ENROLLABLE_KINDS)[number];
const PHONE_KINDS: readonly string[] = ['ANDROID_PHONE', 'IOS_PHONE'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^\d{6}$/;

export interface DevicePrincipal {
  deviceId: string;
  protectedPersonId: string;
  kind: string;
}

export interface EnrollRequest {
  inviteCode: string;
  deviceId: string;
  kind: string;
  model?: string;
  osVersion?: string;
  appVersion?: string;
}

export interface TokenResponse {
  deviceId: string;
  protectedPersonId: string;
  token: string;
  expiresAt: string;
  refreshAfter: string;
}

export interface DeviceConfig {
  deviceId: string;
  protectedPersonId: string;
  kind: string;
  rulesVersion: number;
  sleepWindow: { timezone: string; start: string; end: string };
  devicePrompt: { fallWindowSec: number | null; inactivityWindowSec: number | null };
  inactivityThresholdMin: number | null;
  /** Cihazın göstereceği / seslendireceği metinler (katalog; saat W-*, telefon P-*). */
  messages: Record<string, { text: string; action?: string }>;
  /**
   * T-060 abonelik: `protectionActive=false` (askıda / iptal) iken cihaz koruma kapalı ekranını gösterir ve
   * `messageCode` metnini kullanır. status null = abonelik dışı kişi (koruma açık).
   */
  subscription: {
    status: 'TRIAL' | 'ACTIVE' | 'PAYMENT_PENDING' | 'SUSPENDED' | 'CANCELED' | null;
    protectionActive: boolean;
    until: string | null;
    messageCode: string | null;
  };
  /**
   * Operatörün arayan numaraları (T-054: telefon bu numaradan gelen aramayı hoparlöre alır, rehbere "Yanımda"
   * olarak ekler) ve ana ekranda gösterilen ad (P-HOME-OK `{operator}`). Ortam: OPERATOR_CALLER_IDS
   * (virgüllü E.164; yoksa TWILIO_FROM_NUMBER), OPERATOR_DISPLAY_NAME.
   */
  operator: { name: string | null; callerIds: string[] };
  /** Telefon ana ekranı aile kısayolu: ilk sıradaki yakın (B-04). Yalnız telefonlara. */
  familyContact: { displayName: string | null; phone: string } | null;
}

/** Operatör arayan numaraları ve adı (ortamdan; .env.example). */
export function operatorInfo(env: NodeJS.ProcessEnv = process.env): DeviceConfig['operator'] {
  const raw = env.OPERATOR_CALLER_IDS || env.TWILIO_FROM_NUMBER || '';
  const callerIds = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\+?[0-9 ]{7,20}$/.test(s));
  return { name: env.OPERATOR_DISPLAY_NAME?.trim() || null, callerIds };
}

const hashCode = (code: string) => createHash('sha256').update(`yanimda-invite:${code}`).digest('hex');
const str = (v: unknown, max: number) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);

/**
 * T-041 cihaz kaydı ve yapılandırması (+ T-040'ın davet kodu parçası).
 * - Davet: 6 haneli kod, 15 dk, tek kullanım; yalnız özeti saklanır.
 * - Kayıt: kod + istemcinin ürettiği deviceId → cihaz satırı + 1 yıllık token. Aynı cihaz aynı kodla yeniden
 *   denerse (yanıt yolda kayboldu) kodun süresi içinde yeni token alır; başka cihaz 400, etkin kayıtlı cihaz 409,
 *   kaldırılmış cihaz yeni davetle yeniden etkinleşir (eski token'ları geçersiz kalır).
 * - Doğrulama: imza + süre + cihaz iptal edilmemiş + kişi eşleşiyor. İptal sonrası 401.
 * Log'larda kod, token, ad yok.
 */
@Injectable()
export class EnrollmentService {
  private readonly log = new Logger('Enrollment');
  private readonly rules: RulesProvider;
  private readonly secret: string;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Pick<Redis, 'incr' | 'expire' | 'get'>,
    @Inject(ProtectionService) private readonly protection: Pick<ProtectionService, 'settingsOf'>,
    @Optional() @Inject(RULES) rules?: RulesProvider,
    @Optional() @Inject('DEVICE_TOKEN_SECRET') secret?: string,
  ) {
    this.rules = rules ?? staticRules(loadRulePack());
    this.secret = secret ?? deviceTokenSecret();
  }

  // MARK: Davet (T-040 parçası)

  async createInvite(protectedPersonId: string, now = new Date()): Promise<{ code: string; expiresAt: string }> {
    if (!UUID.test(protectedPersonId)) throw new NotFoundException('Kişi bulunamadı');
    const person = await this.db.execute(sql`SELECT 1 FROM profile.protected_person WHERE id = ${protectedPersonId}`);
    if (!(person as unknown as { rows: unknown[] }).rows.length) throw new NotFoundException('Kişi bulunamadı');
    const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const codeHash = hashCode(code);
      // Aynı anda geçerli iki davet aynı kodu taşımasın (kayıt kodu kişiye eşler).
      const clash = await this.db
        .select({ id: invite.id })
        .from(invite)
        .where(and(eq(invite.codeHash, codeHash), isNull(invite.usedAt), gt(invite.expiresAt, now)));
      if (clash.length) continue;
      await this.db.insert(invite).values({ id: uuidv4(), protectedPersonId, codeHash, expiresAt, createdAt: now });
      return { code, expiresAt: expiresAt.toISOString() };
    }
    throw new HttpException('Kod üretilemedi, yeniden deneyin', HttpStatus.SERVICE_UNAVAILABLE);
  }

  // MARK: Kayıt

  async enroll(body: unknown, ip = 'unknown', now = new Date()): Promise<{ created: boolean; body: TokenResponse }> {
    await this.checkRate(ip);
    const req = this.parse(body);
    const codeHash = hashCode(req.inviteCode);

    const result = await this.db.transaction(async (tx) => {
      const [inv] = await tx
        .select()
        .from(invite)
        .where(and(eq(invite.codeHash, codeHash), gt(invite.expiresAt, now)))
        .orderBy(sql`${invite.createdAt} DESC`)
        .limit(1)
        .for('update');
      if (!inv) return { error: 'code' as const };
      const [existing] = await tx
        .select({ personId: device.protectedPersonId, revokedAt: device.revokedAt })
        .from(device)
        .where(eq(device.id, req.deviceId));

      if (inv.usedAt) {
        // Yeniden deneme: aynı cihaz, aynı kod, kod süresi içinde → yeni token. Başka cihaz → yanlış kod.
        if (inv.usedByDeviceId === req.deviceId && existing && !existing.revokedAt)
          return { created: false, personId: inv.protectedPersonId };
        return { error: 'code' as const };
      }
      if (existing && !existing.revokedAt) return { error: 'exists' as const };

      await tx.update(invite).set({ usedAt: now, usedByDeviceId: req.deviceId }).where(eq(invite.id, inv.id));
      const fields = {
        protectedPersonId: inv.protectedPersonId,
        kind: req.kind,
        model: req.model ?? null,
        osVersion: req.osVersion ?? null,
        appVersion: req.appVersion ?? null,
        enrolledAt: now,
      };
      if (existing) {
        // Kaldırılmış cihaz yeni davetle yeniden eşleşir (aynı kurulum, aynı deviceId). enrolledAt yenilenir:
        // iptalden önce verilmiş token'lar geçersiz kalır (authenticate: iat >= enrolledAt).
        await tx
          .update(device)
          .set({ ...fields, revokedAt: null, pushProvider: null, pushToken: null, pushSandbox: null })
          .where(eq(device.id, req.deviceId));
      } else {
        await tx.insert(device).values({ id: req.deviceId, ...fields });
      }
      return { created: true, personId: inv.protectedPersonId };
    });

    if ('error' in result) {
      if (result.error === 'exists') throw new ConflictException('Bu cihaz kimliği zaten kayıtlı');
      await this.recordFailure(ip);
      throw new BadRequestException('Davet kodu geçersiz veya süresi dolmuş');
    }
    this.log.log(`Cihaz kaydedildi: ${req.kind}${result.created ? '' : ' (yeniden deneme)'}`);
    return {
      created: result.created,
      body: this.issueToken({ deviceId: req.deviceId, protectedPersonId: result.personId, kind: req.kind }, now),
    };
  }

  private parse(body: unknown): EnrollRequest & { kind: EnrollableKind } {
    const b = (body ?? {}) as Record<string, unknown>;
    const inviteCode = typeof b.inviteCode === 'string' ? b.inviteCode.trim() : '';
    if (!CODE.test(inviteCode)) throw new BadRequestException('Davet kodu 6 haneli olmalı');
    if (typeof b.deviceId !== 'string' || !UUID.test(b.deviceId)) throw new BadRequestException('deviceId UUID olmalı');
    if (!ENROLLABLE_KINDS.includes(b.kind as EnrollableKind))
      throw new BadRequestException(`kind şunlardan biri olmalı: ${ENROLLABLE_KINDS.join(', ')}`);
    return {
      inviteCode,
      deviceId: b.deviceId.toLowerCase(),
      kind: b.kind as EnrollableKind,
      model: str(b.model, 100),
      osVersion: str(b.osVersion, 50),
      appVersion: str(b.appVersion, 50),
    };
  }

  private async checkRate(ip: string) {
    let n = 0;
    try {
      n = Number((await this.redis.get(`enroll:fail:${ip}`)) ?? 0);
    } catch (e) {
      this.log.warn(`Kayıt hız sınırı okunamadı: ${safeError(e)}`); // Redis yoksa kayıt kapanmasın
    }
    if (n >= ENROLL_MAX_FAILURES)
      throw new HttpException('Çok fazla hatalı deneme, 15 dakika sonra yeniden deneyin', HttpStatus.TOO_MANY_REQUESTS);
  }

  private async recordFailure(ip: string) {
    try {
      const k = `enroll:fail:${ip}`;
      if ((await this.redis.incr(k)) === 1) await this.redis.expire(k, ENROLL_FAIL_WINDOW_SEC);
    } catch (e) {
      this.log.warn(`Kayıt hız sınırı yazılamadı: ${safeError(e)}`);
    }
  }

  /** Cihaz token'ı üretir (kayıt, yenileme ve telefonun saat kaydı — CompanionService). */
  issueToken(p: DevicePrincipal, now: Date): TokenResponse {
    const { token, claims } = signDeviceToken(
      { sub: p.deviceId, pp: p.protectedPersonId, kind: p.kind },
      this.secret,
      now,
    );
    return {
      deviceId: p.deviceId,
      protectedPersonId: p.protectedPersonId,
      token,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      refreshAfter: new Date((claims.exp - DEVICE_TOKEN_REFRESH_BEFORE_SEC) * 1000).toISOString(),
    };
  }

  // MARK: Doğrulama, yenileme, iptal

  /** Authorization başlığının değeri ("Bearer …"). Geçersiz/iptal/süresi dolmuş → 401. */
  async authenticate(authorization: string, now = new Date()): Promise<DevicePrincipal> {
    const m = /^Bearer\s+(\S+)$/i.exec(authorization);
    const claims = m ? verifyDeviceToken(m[1]!, this.secret, now) : null;
    if (!claims) throw new UnauthorizedException('Cihaz token geçersiz');
    const [row] = await this.db
      .select({
        personId: device.protectedPersonId,
        kind: device.kind,
        revokedAt: device.revokedAt,
        enrolledAt: device.enrolledAt,
      })
      .from(device)
      .where(eq(device.id, claims.sub));
    if (!row || row.revokedAt || row.personId !== claims.pp) throw new UnauthorizedException('Cihaz token geçersiz');
    // Yeniden eşleşmeden önce verilmiş token (iptal edilmiş eşleşmeden kalma) geçersiz.
    if (row.enrolledAt && claims.iat < Math.floor(row.enrolledAt.getTime() / 1000))
      throw new UnauthorizedException('Cihaz token geçersiz');
    return { deviceId: claims.sub, protectedPersonId: claims.pp, kind: row.kind };
  }

  /**
   * Token'sız (simülatör yolu) sinyal: kayıtla gelmiş veya kaldırılmış cihaz adına kabul edilmez (401). Böylece
   * kaldırılan telefon token'sız yeniden denemeyle sinyal sokamaz. Tohum/simülatör cihazları (enrolled_at boş) geçer.
   */
  async assertTokenless(batch: unknown): Promise<void> {
    if (!Array.isArray(batch)) return;
    const ids = [
      ...new Set(
        batch
          .map((s) => (s as { deviceId?: unknown })?.deviceId)
          .filter((d): d is string => typeof d === 'string' && UUID.test(d)),
      ),
    ];
    if (!ids.length) return;
    const rows = await this.db
      .select({ id: device.id })
      .from(device)
      .where(and(inArray(sql`${device.id}::text`, ids), or(isNotNull(device.enrolledAt), isNotNull(device.revokedAt))))
      .limit(1);
    if (rows.length) throw new UnauthorizedException('Cihaz token gerekli');
  }

  refresh(p: DevicePrincipal, now = new Date()): TokenResponse {
    return this.issueToken(p, now);
  }

  /** Aile "cihazı kaldır" (T-020'ye kadar yönetici token'ıyla). Sonrasında token 401. */
  async revoke(deviceId: string, now = new Date()): Promise<void> {
    if (!UUID.test(deviceId)) throw new NotFoundException('Cihaz bulunamadı');
    const rows = await this.db
      .update(device)
      .set({ revokedAt: now, pushToken: null })
      .where(and(eq(device.id, deviceId), isNull(device.revokedAt)))
      .returning({ id: device.id });
    if (!rows.length) {
      const [exists] = await this.db.select({ id: device.id }).from(device).where(eq(device.id, deviceId));
      if (!exists) throw new NotFoundException('Cihaz bulunamadı');
    }
  }

  /** Yol parametresi token'ın cihazı olmalı (başka cihazın yapılandırması/push token'ı değiştirilemez). */
  static assertSelf(p: DevicePrincipal, deviceId: string) {
    if (p.deviceId !== deviceId.toLowerCase()) throw new ForbiddenException('Başka cihaz');
  }

  // MARK: Push token (T-053 kullanır)

  async setPushToken(p: DevicePrincipal, body: unknown, now = new Date()): Promise<void> {
    const b = (body ?? {}) as Record<string, unknown>;
    if (b.provider !== 'APNS' && b.provider !== 'FCM') throw new BadRequestException('provider APNS veya FCM olmalı');
    const token = str(b.token, 4096);
    if (!token) throw new BadRequestException('token zorunlu');
    if (b.provider === 'APNS' && p.kind !== 'IOS_PHONE') throw new BadRequestException('APNS yalnız iOS cihazlar için');
    await this.db
      .update(device)
      .set({
        pushProvider: b.provider,
        pushToken: token,
        pushSandbox: b.sandbox === true,
        pushUpdatedAt: now,
      })
      .where(eq(device.id, p.deviceId));
  }

  // MARK: Yapılandırma

  private async firstContact(protectedPersonId: string): Promise<DeviceConfig['familyContact']> {
    const [c] = await this.db
      .select({ displayName: contact.displayName, phone: contact.phoneE164 })
      .from(contact)
      .where(and(eq(contact.protectedPersonId, protectedPersonId), eq(contact.role, 'CONTACT')))
      .orderBy(contact.priority)
      .limit(1);
    return c ? { displayName: c.displayName ?? null, phone: c.phone } : null;
  }

  async config(p: DevicePrincipal): Promise<{ etag: string; body: DeviceConfig }> {
    const pack = this.rules.current();
    const fall = ruleFor(pack, 'FALL');
    const inact = ruleFor(pack, 'INACTIVITY');
    const prefix = PHONE_KINDS.includes(p.kind) ? 'P-' : 'W-';
    const settings = await this.protection.settingsOf(p.protectedPersonId);
    const sub = await subscriptionProtection(this.db, p.protectedPersonId);
    const messages: DeviceConfig['messages'] = {};
    for (const [code, m] of Object.entries(catalogs.tr ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      if (code.startsWith(prefix)) messages[code] = m.action ? { text: m.text, action: m.action } : { text: m.text };
    }
    const body: DeviceConfig = {
      deviceId: p.deviceId,
      protectedPersonId: p.protectedPersonId,
      kind: p.kind,
      rulesVersion: pack.version,
      sleepWindow: { timezone: settings.timezone, start: settings.start, end: settings.end },
      devicePrompt: {
        fallWindowSec: fall?.devicePrompt?.enabled
          ? (settings.fallPromptSec ?? fall.devicePrompt.windowSec ?? null) // T-061 aile ayarı
          : null,
        inactivityWindowSec: inact?.devicePrompt?.enabled ? (inact.devicePrompt.windowSec ?? null) : null,
      },
      inactivityThresholdMin: inactivityThreshold(pack, settings.inactivityMin) ?? null, // T-070 kişiye özel
      messages,
      operator: operatorInfo(),
      familyContact: PHONE_KINDS.includes(p.kind) ? await this.firstContact(p.protectedPersonId) : null,
      subscription: { ...sub, messageCode: subscriptionMessage(sub.status, prefix) },
    };
    const etag = `"${createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 22)}"`;
    return { etag, body };
  }
}

/** Abonelik durumunun cihaz metni (katalog): ödeme bekliyor yalnız telefonda; askı/iptal ikisinde. */
function subscriptionMessage(status: DeviceConfig['subscription']['status'], prefix: string): string | null {
  if (status === 'SUSPENDED' || status === 'CANCELED') return `${prefix}SUB-OFF`;
  if (status === 'PAYMENT_PENDING' && prefix === 'P-') return 'P-SUB-PAY';
  return null;
}

/** If-None-Match başlığı ETag'i içeriyor mu (virgüllü liste, W/ öneki ve * desteklenir). */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(',')
    .map((s) => s.trim().replace(/^W\//, ''))
    .some((t) => t === '*' || t === etag);
}
