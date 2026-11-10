import { createHash, randomInt } from 'node:crypto';

import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { type KafkaEnvelope, type NotifyRequest, TOPICS } from '@yanimda/contracts';
import { t } from '@yanimda/messages';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { v7 as uuidv7 } from 'uuid';

import { bus as globalBus, type LocalBus } from '../../common/bus';
import { OutboxBus } from '../../common/outbox';
import { safeError } from '../../common/safe-error';
import { DB, type Db, type Tx } from '../../db/client';
import { auditLog, familyMember, paymentWebhook, protectedPerson, subscription } from '../../db/schema';
import type { Actor } from '../profile/contacts';
import type { ProfileService } from '../profile/profile.service';
import { REDIS } from '../signal/idempotency.store';
import type { CpaasProvider } from '../telephony/cpaas';
import type { ConsumerAccounts } from './consumer-accounts';
import {
  effective,
  type EffectiveStatus,
  endsTrial,
  onFirstEvent,
  onPaymentEvent,
  onSweep,
  type Patch,
  type PaymentEvent,
  type SubscriptionStatus,
  type Transition,
  TRIAL_DAYS,
} from './lifecycle';
import { type Country, isCountry, planOf, priceRefOf, publicPlans } from './plans';
import type { CheckoutSession, PaymentProvider, ProviderName, WebhookInput } from './providers/provider';
import { SignatureError } from './providers/provider';
import { issueSignupToken, verifySignupToken } from './signup-token';
import { factsOf, iso } from './subscription-protection';

export const BILLING_CONFIG = Symbol('BILLING_CONFIG');
export const PAYMENT_PROVIDERS = Symbol('PAYMENT_PROVIDERS');
export const CONSUMER_ACCOUNTS = Symbol('CONSUMER_ACCOUNTS');
export const BILLING_PROFILE = Symbol('BILLING_PROFILE');
export const BILLING_SMS = Symbol('BILLING_SMS');

export interface BillingConfig {
  signupSecret: string;
  /** Aile web kökü (ödeme dönüş adresleri). */
  webBase: string;
  /** Sağlayıcının eriştiği genel API kökü (iyzico callback). */
  apiBase: string;
  /** KVKK aydınlatma metninin geçerli sürümü (web aynı sürümü göndermeli). */
  kvkkNoticeVersion: string;
  /** Sahte SMS sağlayıcısında doğrulama kodu yanıtta döner (yalnız geliştirme). */
  exposeDevCode: boolean;
  env: NodeJS.ProcessEnv;
  sweepMs: number;
}

/** Ülke → sağlayıcı. */
export interface ProviderRegistry {
  forCountry(c: Country): PaymentProvider | null;
  byName(n: ProviderName): PaymentProvider | null;
  all(): PaymentProvider[];
}

export interface SubscriptionView {
  id: string;
  protectedPersonId: string;
  plan: string;
  countryCode: string;
  status: SubscriptionStatus;
  effectiveStatus: EffectiveStatus | null;
  protectionActive: boolean;
  /** Deneme sonu / ödeme bekleme sonu / yenileme tarihi (duruma göre). */
  until: string | null;
  trialEndsAt: string | null;
  canceledAt: string | null;
  provider: ProviderName | null;
  /** Ödenmiş mi (sağlayıcıda abonelik var). */
  paymentMethodOnFile: boolean;
}

export interface SignupResult {
  subscriptionId: string;
  protectedPersonId: string;
  signupToken: string;
  signupTokenExpiresAt: string;
  trialEndsAt: string;
  phoneVerification: 'SENT' | 'UNAVAILABLE';
  /** Yalnız geliştirmede sahte SMS ile. */
  devCode?: string;
}

export interface WebhookResult {
  received: true;
  duplicate: boolean;
  outcome: string;
}

type Row = typeof subscription.$inferSelect;
type Rows<T> = { rows: T[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164 = /^\+[1-9]\d{6,14}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const OTP_TTL_SEC = 600;
const OTP_MAX_FAIL = 5;
const OTP_MAX_SENDS = 5;
const SIGNUP_PER_IP_HOUR = 10;

const DAY = 86_400_000;

const text = (v: unknown, name: string, max: number): string => {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > max) throw new BadRequestException(`${name} geçersiz`);
  return v.trim();
};
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * T-060 (C-01) web abonelik: kayıt (Keycloak consumers hesabı + kişi + TRIAL), telefon OTP, ödeme sağlayıcısı
 * checkout'u, imzalı webhook'lar (tekrar ayıklamalı), deneme / ödeme bekleme / askı taraması, tek tık iptal.
 * Durum değişikliği, webhook kaydı, aile bildirimi (outbox `notify.requested`) ve denetim kaydı aynı transaction'da.
 * Log'larda e-posta, telefon, ad, kart, token yok — yalnız kimlikler ve sağlayıcı olay türü.
 */
@Injectable()
export class BillingService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Billing');
  private unsub?: () => void;
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OutboxBus) private readonly outbox: OutboxBus,
    @Inject(REDIS) private readonly redis: Pick<Redis, 'set' | 'get' | 'del' | 'incr' | 'expire'>,
    @Inject(BILLING_PROFILE) private readonly profile: Pick<ProfileService, 'create' | 'authorize'>,
    @Inject(CONSUMER_ACCOUNTS) private readonly accounts: ConsumerAccounts,
    @Inject(PAYMENT_PROVIDERS) private readonly providers: ProviderRegistry,
    @Inject(BILLING_CONFIG) private readonly cfg: BillingConfig,
    @Optional() @Inject(BILLING_SMS) private readonly sms: Pick<CpaasProvider, 'sendSms' | 'name'> | null = null,
  ) {}

  onModuleInit() {
    this.subscribe();
    if (this.cfg.sweepMs > 0) {
      this.timer = setInterval(
        () => void this.sweep().catch((e) => this.log.warn(`Tarama: ${safeError(e)}`)),
        this.cfg.sweepMs,
      );
      this.timer.unref();
    }
  }

  onModuleDestroy() {
    this.unsub?.();
    if (this.timer) clearInterval(this.timer);
  }

  /** İlk gerçek alarm (SOS / FALL / INACTIVITY; test değil) denemeyi bitirir. Testler için ayrı bus. */
  subscribe(bus: LocalBus = globalBus) {
    this.unsub?.();
    this.unsub = bus.subscribe<{ protectedPersonId: string; type?: string; isTest?: boolean; createdAt?: string }>(
      TOPICS.eventCreated,
      (e) => this.onEventCreated(e.payload, new Date(e.occurredAt)).then(() => undefined),
      { lane: 'side', name: 'billing.trial' },
    );
  }

  // ---- paketler ----

  plans(country: unknown) {
    const c = isCountry(country) ? country : 'TR';
    return { country: c, trialDays: TRIAL_DAYS, kvkkNoticeVersion: this.cfg.kvkkNoticeVersion, plans: publicPlans(c) };
  }

  // ---- kayıt (adım 2: hesap) ----

  async signup(body: unknown, ip = 'unknown', now = new Date()): Promise<SignupResult> {
    const b = obj(body);
    const plan = planOf(b.plan);
    if (!plan) throw new BadRequestException('plan geçersiz');
    if (!isCountry(b.country)) throw new BadRequestException('country geçersiz');
    const country = b.country;
    const fam = obj(b.account);
    const email = text(fam.email, 'email', 254).toLowerCase();
    if (!EMAIL.test(email)) throw new BadRequestException('email geçersiz');
    const phone = text(fam.phone, 'phone', 16);
    if (!E164.test(phone)) throw new BadRequestException('phone E.164 olmalı');
    const firstName = text(fam.firstName, 'firstName', 60);
    const lastName = text(fam.lastName, 'lastName', 60);
    const displayName = text(obj(b.protectedPerson).displayName, 'protectedPerson.displayName', 100);
    const consents = obj(b.consents);
    if (consents.kvkkNoticeVersion !== this.cfg.kvkkNoticeVersion)
      throw new BadRequestException('KVKK aydınlatma metni sürümü güncel değil');
    if (consents.explicitConsent !== true) throw new BadRequestException('Açık rıza gerekli');
    if (!this.providers.forCountry(country))
      throw new HttpException('Ödeme bu ülkede kapalı', HttpStatus.SERVICE_UNAVAILABLE);

    await this.limit(`signup:ip:${ip}`, SIGNUP_PER_IP_HOUR, 3600);

    const { subject } = await this.accounts.create({ email, phone, firstName, lastName });
    let personId: string;
    let row: Row;
    try {
      const person = await this.profile.create({ kind: 'FAMILY', id: subject }, { displayName }, now);
      personId = person.id;
      row = await this.db.transaction(async (tx) => {
        const [r] = await tx
          .update(subscription)
          .set({
            plan: plan.code,
            countryCode: country,
            trialEndsAt: new Date(now.getTime() + TRIAL_DAYS * DAY),
            kvkkNoticeVersion: this.cfg.kvkkNoticeVersion,
            explicitConsentAt: now,
            updatedAt: now,
          })
          .where(and(eq(subscription.protectedPersonId, personId), ne(subscription.status, 'CANCELED')))
          .returning();
        if (!r) throw new Error('abonelik satırı yok');
        await this.audit(tx, { kind: 'FAMILY', id: subject }, 'subscription.signup', r.id, {
          plan: plan.code,
          country,
          kvkkNoticeVersion: this.cfg.kvkkNoticeVersion,
          explicitConsent: true,
        });
        return r;
      });
    } catch (e) {
      await this.accounts.remove(subject).catch((x) => this.log.warn(`Hesap telafisi: ${safeError(x)}`));
      throw e;
    }

    await this.accounts
      .sendSetupEmail(subject, `${this.cfg.webBase}/kayit/tamam?sub=${row.id}`)
      .catch((e) => this.log.warn(`Kurulum e-postası (abonelik=${row.id}): ${safeError(e)}`));
    const code = await this.sendCode(row.id, phone).catch((e) => {
      this.log.warn(`Doğrulama SMS'i (abonelik=${row.id}): ${safeError(e)}`);
      return null;
    });
    const tok = issueSignupToken(this.cfg.signupSecret, row.id, now);
    this.log.log(`Kayıt: abonelik=${row.id} plan=${plan.code} ülke=${country}`);
    return {
      subscriptionId: row.id,
      protectedPersonId: personId,
      signupToken: tok.token,
      signupTokenExpiresAt: tok.expiresAt,
      trialEndsAt: row.trialEndsAt!.toISOString(),
      phoneVerification: code ? 'SENT' : 'UNAVAILABLE',
      ...(code && this.cfg.exposeDevCode && this.sms?.name === 'fake' ? { devCode: code } : {}),
    };
  }

  /** Doğrulama kodunu yeniden gönder (abonelik başına saatte 5). */
  async resendPhoneCode(
    subscriptionId: string,
    token: unknown,
  ): Promise<{ phoneVerification: 'SENT'; devCode?: string }> {
    const sub = await this.bySignupToken(subscriptionId, token);
    const subject = await this.ownerOf(sub.protectedPersonId);
    const c = await this.accounts.contactOf(subject);
    if (!c) throw new NotFoundException('Hesap bulunamadı');
    if (c.phoneVerified) throw new ConflictException('Telefon zaten doğrulandı');
    const code = await this.sendCode(sub.id, c.phone);
    return {
      phoneVerification: 'SENT',
      ...(this.cfg.exposeDevCode && this.sms?.name === 'fake' ? { devCode: code } : {}),
    };
  }

  async verifyPhone(subscriptionId: string, token: unknown, body: unknown): Promise<{ phoneVerified: true }> {
    const sub = await this.bySignupToken(subscriptionId, token);
    const code = obj(body).code;
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new BadRequestException('Kod 6 hane olmalı');
    const key = `signup:otp:${sub.id}`;
    const want = await this.redis.get(key);
    if (!want) throw new HttpException('Kodun süresi doldu', HttpStatus.GONE);
    if (want !== this.otpHash(sub.id, code)) {
      const fails = await this.redis.incr(`${key}:fail`);
      await this.redis.expire(`${key}:fail`, OTP_TTL_SEC);
      if (fails >= OTP_MAX_FAIL) await this.redis.del(key); // yeni kod istensin
      throw new BadRequestException('Kod hatalı');
    }
    await this.redis.del(key);
    await this.accounts.markPhoneVerified(await this.ownerOf(sub.protectedPersonId));
    await this.audit(this.db, { kind: 'FAMILY' }, 'subscription.phone_verified', sub.id, {});
    return { phoneVerified: true };
  }

  // ---- ödeme (adım 2: ödeme) ----

  /** Kayıt akışından (signupToken ile). */
  async checkoutWithToken(subscriptionId: string, token: unknown, body: unknown): Promise<CheckoutSession> {
    return this.checkout(await this.bySignupToken(subscriptionId, token), body);
  }

  /** Giriş yapmış aile sahibi (deneme sonrası / ödeme bekliyor iken "ödemeyi tamamla"). */
  async checkoutForPerson(actor: Actor, personId: string, body: unknown): Promise<CheckoutSession> {
    await this.owner(actor, personId);
    return this.checkout(await this.openOf(personId), body);
  }

  private async checkout(sub: Row, body: unknown): Promise<CheckoutSession> {
    if (sub.status === 'CANCELED') throw new ConflictException('Abonelik iptal edilmiş');
    if (sub.status === 'ACTIVE') throw new ConflictException('Abonelik zaten etkin');
    const country = sub.countryCode as Country;
    const provider = this.providers.forCountry(country);
    if (!provider) throw new HttpException('Ödeme bu ülkede kapalı', HttpStatus.SERVICE_UNAVAILABLE);
    const plan = planOf(sub.plan) ?? planOf('STANDARD')!;
    const priceRef = priceRefOf(plan, provider.name, this.cfg.env);
    if (!priceRef) throw new HttpException('Paket fiyatı yapılandırılmamış', HttpStatus.SERVICE_UNAVAILABLE);
    const contact = await this.accounts.contactOf(await this.ownerOf(sub.protectedPersonId));
    if (!contact) throw new NotFoundException('Hesap bulunamadı');
    if (!contact.phoneVerified) throw new ConflictException('Telefon doğrulanmadı');
    const b = obj(body);
    const billingIn = obj(b.billing);
    const billing =
      typeof billingIn.city === 'string' && typeof billingIn.address === 'string'
        ? { city: text(billingIn.city, 'billing.city', 60), address: text(billingIn.address, 'billing.address', 200) }
        : undefined;
    if (provider.name === 'IYZICO' && !billing) throw new BadRequestException('Fatura adresi gerekli');
    let session: CheckoutSession;
    try {
      session = await provider.createCheckout({
        subscriptionId: sub.id,
        plan: { code: plan.code, providerPriceRef: priceRef },
        customer: {
          email: contact.email,
          phone: contact.phone,
          firstName: contact.firstName,
          lastName: contact.lastName,
        },
        successUrl: `${this.cfg.webBase}/kayit/tamam?sub=${sub.id}`,
        cancelUrl: `${this.cfg.webBase}/kayit?adim=odeme&sub=${sub.id}`,
        callbackUrl: `${this.cfg.apiBase}/v1/payments/iyzico/callback`,
        ...(billing ? { billing } : {}),
      });
    } catch (e) {
      this.log.warn(`Checkout (abonelik=${sub.id}, ${provider.name}): ${safeError(e)}`);
      throw new BadGatewayException('Ödeme sağlayıcısına ulaşılamadı');
    }
    await this.db
      .update(subscription)
      .set({ provider: provider.name, checkoutRef: session.checkoutRef, updatedAt: new Date() })
      .where(eq(subscription.id, sub.id));
    return session;
  }

  // ---- webhook ----

  /** POST /v1/webhooks/payments — sağlayıcı başlıktan bulunur; imza geçersizse 400, tekrar 200 (duplicate). */
  async webhook(input: WebhookInput, now = new Date()): Promise<WebhookResult> {
    const provider = this.providers.all().find((p) => p.owns(input.headers));
    if (!provider) throw new BadRequestException('Sağlayıcı imzası yok');
    let ev: PaymentEvent;
    try {
      ev = provider.parseWebhook(input, now);
    } catch (e) {
      if (e instanceof SignatureError) {
        this.log.warn(`Webhook imzası reddedildi (${provider.name})`);
        throw new BadRequestException('İmza geçersiz');
      }
      throw e;
    }
    if (!ev.eventId) throw new BadRequestException('Olay kimliği yok');
    return this.apply(ev, now);
  }

  /** iyzico tarayıcı dönüşü: token → sonuç iyzico'dan okunur → aynı uygulama yolu. Web'e dönülecek adres. */
  async iyzicoCallback(token: unknown): Promise<string> {
    const provider = this.providers.byName('IYZICO');
    if (!provider?.completeCheckout || typeof token !== 'string' || !token || token.length > 200)
      throw new BadRequestException('token geçersiz');
    const [sub] = await this.db
      .select({ id: subscription.id })
      .from(subscription)
      .where(and(eq(subscription.provider, 'IYZICO'), eq(subscription.checkoutRef, token)));
    if (!sub) throw new NotFoundException('Ödeme bulunamadı');
    try {
      await this.apply({ ...(await provider.completeCheckout(token)), subscriptionId: sub.id });
    } catch (e) {
      if (e instanceof HttpException) throw e;
      this.log.warn(`iyzico sonuç (abonelik=${sub.id}): ${safeError(e)}`);
      return `${this.cfg.webBase}/kayit?adim=odeme&sub=${sub.id}&hata=1`;
    }
    const [r] = await this.db.select().from(subscription).where(eq(subscription.id, sub.id));
    return r?.status === 'ACTIVE'
      ? `${this.cfg.webBase}/kayit/tamam?sub=${sub.id}`
      : `${this.cfg.webBase}/kayit?adim=odeme&sub=${sub.id}&hata=1`;
  }

  /**
   * Sahte sağlayıcı ödeme sayfasının "Öde"/"Reddet" düğmesi: imzalı webhook üretilip gerçek webhook yolundan
   * geçirilir. Yalnız PAYMENT_PROVIDER=fake (üretimde açılamaz).
   */
  async fakePay(checkoutRef: string, body: unknown): Promise<WebhookResult & { redirect: string }> {
    const fake = this.providers.byName('FAKE') as (PaymentProvider & { webhook?: (b: object) => WebhookInput }) | null;
    if (!fake?.webhook) throw new NotFoundException('Sahte sağlayıcı kapalı');
    const [sub] = await this.db
      .select()
      .from(subscription)
      .where(and(eq(subscription.provider, 'FAKE'), eq(subscription.checkoutRef, checkoutRef)));
    if (!sub) throw new NotFoundException('Ödeme bulunamadı');
    const ok = obj(body).outcome !== 'fail';
    const now = Date.now();
    const r = await this.webhook(
      fake.webhook(
        ok
          ? {
              id: `fake_evt_checkout_${checkoutRef}`,
              type: 'checkout.completed',
              created: now,
              subscriptionId: sub.id,
              subscriptionRef: `fake_sub_${sub.id}`,
              checkoutRef,
              periodEnd: now + (sub.plan.endsWith('YEARLY') ? 365 : 30) * DAY,
            }
          : { id: `fake_evt_fail_${checkoutRef}`, type: 'payment.failed', created: now, subscriptionId: sub.id },
      ),
    );
    return {
      ...r,
      redirect: ok
        ? `${this.cfg.webBase}/kayit/tamam?sub=${sub.id}`
        : `${this.cfg.webBase}/kayit?adim=odeme&sub=${sub.id}&hata=1`,
    };
  }

  /** Sağlayıcıdan bağımsız olayı uygula (idempotent). */
  async apply(ev: PaymentEvent, now = new Date()): Promise<WebhookResult> {
    const res = await this.db.transaction(async (tx) => {
      const fresh = await tx
        .insert(paymentWebhook)
        .values({
          provider: ev.provider,
          providerEventId: ev.eventId,
          type: ev.rawType.slice(0, 100),
          outcome: 'pending',
          receivedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: paymentWebhook.providerEventId });
      if (!fresh.length) return { duplicate: true, outcome: 'duplicate', notified: false };
      const sub = await this.locate(tx, ev);
      let outcome: string = 'unmatched';
      let notified = false;
      if (sub) {
        const tr = onPaymentEvent(sub.id, factsOf(sub), ev);
        // Checkout'suz eşleşme (ör. yalnız metadata): referansın hangi sağlayıcıya ait olduğu da yazılsın.
        if (!sub.provider && (tr.patch.providerSubscriptionRef || tr.patch.providerCustomerRef)) {
          await tx.update(subscription).set({ provider: ev.provider }).where(eq(subscription.id, sub.id));
          sub.provider = ev.provider;
        }
        await this.write(
          tx,
          sub,
          tr,
          now,
          { kind: 'SYSTEM', id: ev.provider },
          `subscription.${ev.type.toLowerCase()}`,
        );
        outcome = tr.outcome;
        notified = !!tr.notify;
      }
      await tx
        .update(paymentWebhook)
        .set({ outcome, subscriptionId: sub?.id ?? null })
        .where(and(eq(paymentWebhook.provider, ev.provider), eq(paymentWebhook.providerEventId, ev.eventId)));
      return { duplicate: false, outcome, notified, subId: sub?.id };
    });
    if (res.notified) this.outbox.notifyCommitted();
    this.log.log(
      `Ödeme olayı ${ev.provider} ${ev.rawType} → ${res.outcome}${'subId' in res && res.subId ? ` (abonelik=${res.subId})` : ''}`,
    );
    return { received: true, duplicate: res.duplicate, outcome: res.outcome };
  }

  private async locate(tx: Tx, ev: PaymentEvent): Promise<Row | undefined> {
    const lock = async (where: ReturnType<typeof eq>) =>
      (await tx.select().from(subscription).where(where).for('update').limit(1))[0];
    if (ev.subscriptionId && UUID.test(ev.subscriptionId)) {
      const r = await lock(eq(subscription.id, ev.subscriptionId));
      if (r) return r;
    }
    if (ev.providerSubscriptionRef) {
      const r = await lock(
        and(
          eq(subscription.provider, ev.provider),
          eq(subscription.providerSubscriptionRef, ev.providerSubscriptionRef),
        )!,
      );
      if (r) return r;
    }
    if (ev.checkoutRef)
      return lock(and(eq(subscription.provider, ev.provider), eq(subscription.checkoutRef, ev.checkoutRef))!);
    return undefined;
  }

  // ---- iptal, durum ----

  /** Tek tık iptal (OWNER): sağlayıcıda sonlandır → CANCELED; cihaz config'te koruma kapanır. */
  async cancel(actor: Actor, personId: string, now = new Date()): Promise<SubscriptionView> {
    await this.owner(actor, personId);
    const sub = await this.openOf(personId);
    if (sub.provider && sub.providerSubscriptionRef) {
      const provider = this.providers.byName(sub.provider as ProviderName);
      try {
        if (!provider) throw new Error('sağlayıcı kapalı');
        await provider.cancel(sub.providerSubscriptionRef);
      } catch (e) {
        // Sağlayıcıda kesilmeden yerelde iptal etmek ücretlendirmeyi sürdürür: kullanıcı tekrar dener.
        this.log.warn(`İptal (abonelik=${sub.id}, ${sub.provider}): ${safeError(e)}`);
        throw new BadGatewayException('Ödeme sağlayıcısına ulaşılamadı, tekrar deneyin');
      }
    }
    await this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(subscription).where(eq(subscription.id, sub.id)).for('update');
      if (!locked || locked.status === 'CANCELED') return;
      await this.write(
        tx,
        locked,
        { patch: { status: 'CANCELED', canceledAt: now }, outcome: 'applied' },
        now,
        actor,
        'subscription.canceled',
      );
    });
    this.log.log(`İptal: abonelik=${sub.id}`);
    return this.view(sub.id, now);
  }

  async status(actor: Actor, personId: string, now = new Date()): Promise<SubscriptionView> {
    await this.profile.authorize(actor, personId);
    const [r] = await this.db
      .select({ id: subscription.id })
      .from(subscription)
      .where(eq(subscription.protectedPersonId, personId))
      .orderBy(sql`${subscription.status} = 'CANCELED', ${subscription.startedAt} DESC`)
      .limit(1);
    if (!r) throw new NotFoundException('Abonelik yok');
    return this.view(r.id, now);
  }

  /** Kayıt akışındaki web (adım 3) için: yalnız durum, kişisel veri yok. */
  async statusWithToken(subscriptionId: string, token: unknown, now = new Date()): Promise<SubscriptionView> {
    const sub = await this.bySignupToken(subscriptionId, token);
    return this.view(sub.id, now);
  }

  async view(id: string, now = new Date()): Promise<SubscriptionView> {
    const [r] = await this.db.select().from(subscription).where(eq(subscription.id, id));
    if (!r) throw new NotFoundException('Abonelik yok');
    const e = effective(factsOf(r), now);
    return {
      id: r.id,
      protectedPersonId: r.protectedPersonId,
      plan: r.plan,
      countryCode: r.countryCode,
      status: r.status as SubscriptionStatus,
      effectiveStatus: e.status,
      protectionActive: e.protectionActive,
      until: iso(e.until),
      trialEndsAt: iso(r.trialEndsAt),
      canceledAt: iso(r.canceledAt),
      provider: (r.provider as ProviderName | null) ?? null,
      paymentMethodOnFile: !!r.providerSubscriptionRef,
    };
  }

  // ---- deneme ve zaman ----

  async onEventCreated(
    p: { protectedPersonId: string; type?: string; isTest?: boolean },
    at = new Date(),
  ): Promise<boolean> {
    // İnceleme bulgusu 5: pil, bağlantı, saat çıkarıldı, geri arama, takip gibi sistem olayları denemeyi bitirmez.
    if (p.isTest || !endsTrial(p.type) || !UUID.test(p.protectedPersonId)) return false;
    return this.db.transaction(async (tx) => {
      const [sub] = await tx
        .select()
        .from(subscription)
        .where(and(eq(subscription.protectedPersonId, p.protectedPersonId), eq(subscription.status, 'TRIAL')))
        .for('update');
      const patch = sub && onFirstEvent(factsOf(sub), at);
      if (!sub || !patch) return false;
      await this.write(
        tx,
        sub,
        { patch, outcome: 'applied' },
        at,
        { kind: 'SYSTEM' },
        'subscription.trial_ended_by_event',
      );
      return true;
    });
  }

  /**
   * Deneme bitti → PAST_DUE (+F-SUB-PAY); bekleme bitti → askıda (+F-SUB-SUSPENDED). Değişen sayısı.
   * İnceleme bulgusu 5: kişinin süren (kapanmamış, test olmayan) olayı varken ertelenir — aileye acil durumun
   * ortasında ödeme / askı mesajı gitmez; olay kapanınca sonraki taramada işlenir.
   */
  async sweep(now = new Date()): Promise<number> {
    const due = (await this.db.execute(sql`
      SELECT s.id FROM profile.subscription s
      WHERE ((s.status = 'TRIAL' AND COALESCE(s.trial_ends_at, s.started_at + interval '${sql.raw(String(TRIAL_DAYS))} days') <= ${now})
          OR (s.status = 'PAST_DUE' AND s.suspended_at IS NULL AND s.grace_until <= ${now}))
        AND NOT EXISTS (
          SELECT 1 FROM event.event e
          WHERE e.protected_person_id = s.protected_person_id::text AND e.state <> 'CLOSED' AND NOT e.is_test)
      LIMIT 500`)) as unknown as Rows<{ id: string }>;
    let n = 0;
    for (const { id } of due.rows) {
      const changed = await this.db.transaction(async (tx) => {
        const [sub] = await tx.select().from(subscription).where(eq(subscription.id, id)).for('update');
        const tr = sub && onSweep(sub.id, factsOf(sub), now);
        if (!sub || !tr) return false;
        await this.write(
          tx,
          sub,
          tr,
          now,
          { kind: 'SYSTEM' },
          tr.notify?.code === 'F-SUB-SUSPENDED' ? 'subscription.suspended' : 'subscription.past_due',
        );
        return true;
      });
      if (changed) n++;
    }
    if (n) {
      this.outbox.notifyCommitted();
      this.log.log(`Abonelik taraması: ${n} değişti`);
    }
    return n;
  }

  // ---- iç ----

  private async write(
    tx: Tx,
    sub: Row,
    tr: Transition,
    now: Date,
    actor: { kind: string; id?: string },
    action: string,
  ) {
    const patch: Patch & { updatedAt: Date } = { ...tr.patch, updatedAt: now };
    await tx.update(subscription).set(patch).where(eq(subscription.id, sub.id));
    if (tr.patch.status && tr.patch.status !== sub.status)
      await tx
        .update(protectedPerson)
        .set({ status: tr.patch.status, updatedAt: now })
        .where(eq(protectedPerson.id, sub.protectedPersonId));
    if (tr.notify) {
      const payload: NotifyRequest = {
        code: tr.notify.code,
        audience: 'FAMILY',
        protectedPersonId: sub.protectedPersonId,
        dedupeKey: tr.notify.dedupeKey,
      };
      const env: KafkaEnvelope<NotifyRequest> = {
        eventId: uuidv7(),
        type: TOPICS.notifyRequested,
        version: 1,
        occurredAt: now.toISOString(),
        countryCode: sub.countryCode,
        subjectUserId: sub.protectedPersonId,
        payload,
      };
      await this.outbox.publish(TOPICS.notifyRequested, env, tx);
    }
    if (tr.outcome === 'applied' && (tr.patch.status || action.startsWith('subscription.trial')))
      await this.audit(tx, actor, action, sub.id, {
        from: sub.status,
        to: tr.patch.status ?? sub.status,
        ...(tr.notify ? { notify: tr.notify.code } : {}),
      });
  }

  private async audit(
    tx: Pick<Db, 'insert'>,
    actor: { kind: string; id?: string },
    action: string,
    id: string,
    data: Record<string, unknown>,
  ) {
    await tx.insert(auditLog).values({
      actorKind: actor.kind,
      actorId: actor.id ?? null,
      action,
      entityType: 'subscription',
      entityId: id,
      data,
    });
  }

  private async bySignupToken(subscriptionId: string, token: unknown): Promise<Row> {
    const id = verifySignupToken(this.cfg.signupSecret, token);
    if (!id || id !== subscriptionId) throw new ForbiddenException('Kayıt oturumu geçersiz veya süresi doldu');
    const [r] = await this.db.select().from(subscription).where(eq(subscription.id, id));
    if (!r) throw new NotFoundException('Abonelik yok');
    return r;
  }

  private async openOf(personId: string): Promise<Row> {
    const [r] = await this.db
      .select()
      .from(subscription)
      .where(and(eq(subscription.protectedPersonId, personId), ne(subscription.status, 'CANCELED')));
    if (!r) throw new NotFoundException('Açık abonelik yok');
    return r;
  }

  private async ownerOf(personId: string): Promise<string> {
    const [m] = await this.db
      .select({ subject: familyMember.subject })
      .from(familyMember)
      .where(and(eq(familyMember.protectedPersonId, personId), eq(familyMember.role, 'OWNER')));
    if (!m) throw new NotFoundException('Hesap bulunamadı');
    return m.subject;
  }

  /** Abonelik işlemleri yalnız sahibin (OWNER); MEMBER 403, başkası 404 (profil kuralı). */
  private async owner(actor: Actor, personId: string) {
    await this.profile.authorize(actor, personId);
    if (actor.kind !== 'FAMILY') return;
    const [m] = await this.db
      .select({ role: familyMember.role })
      .from(familyMember)
      .where(and(eq(familyMember.protectedPersonId, personId), eq(familyMember.subject, actor.id ?? '')));
    if (m?.role !== 'OWNER') throw new ForbiddenException('Aboneliği yalnız hesap sahibi yönetir');
  }

  private otpHash(id: string, code: string) {
    return createHash('sha256').update(`yanimda-signup:${id}:${code}`).digest('hex');
  }

  private async sendCode(subscriptionId: string, phone: string): Promise<string> {
    if (!this.sms) throw new Error('SMS sağlayıcısı yok');
    await this.limit(`signup:otp-sent:${subscriptionId}`, OTP_MAX_SENDS, 3600);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.redis.set(`signup:otp:${subscriptionId}`, this.otpHash(subscriptionId, code), 'EX', OTP_TTL_SEC);
    await this.redis.del(`signup:otp:${subscriptionId}:fail`);
    await this.sms.sendSms(phone, t('S-SIGNUP-CODE', 'tr', { code }));
    return code;
  }

  private async limit(key: string, max: number, windowSec: number) {
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, windowSec);
    if (n > max) throw new HttpException('Çok fazla deneme, biraz sonra tekrar deneyin', HttpStatus.TOO_MANY_REQUESTS);
  }
}
