import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FieldCipher } from '../src/common/field-cipher';
import { type BillingConfig, BillingService } from '../src/modules/billing/billing.service';
import { FakeConsumerAccounts, KeycloakConsumerAccounts } from '../src/modules/billing/consumer-accounts';
import {
  effective,
  endsTrial,
  GRACE_DAYS,
  onFirstEvent,
  onPaymentEvent,
  onSweep,
  type PaymentEvent,
  type SubscriptionFacts,
} from '../src/modules/billing/lifecycle';
import { FakePaymentProvider } from '../src/modules/billing/providers/fake';
import { iyzicoAuth, IyzicoProvider, iyzicoWebhookSignature } from '../src/modules/billing/providers/iyzico';
import { SignatureError } from '../src/modules/billing/providers/provider';
import { registryOf } from '../src/modules/billing/providers/registry';
import { StripeProvider, stripeSignature } from '../src/modules/billing/providers/stripe';
import { issueSignupToken, verifySignupToken } from '../src/modules/billing/signup-token';
import { EnrollmentService } from '../src/modules/device/enrollment.service';
import { ProtectionService } from '../src/modules/event/protection.service';
import { loadRulePack, staticRules } from '../src/modules/event/rules.loader';
import type { Actor } from '../src/modules/profile/contacts';
import { ProfileService } from '../src/modules/profile/profile.service';
import { createHarness, type Harness } from './support/harness';

/**
 * T-060 (C-01) web abonelik. Kabul:
 *  - sandbox ödeme → ACTIVE (sahte sağlayıcı ve imzalı Stripe olayıyla; gerçek sandbox hesabı yok)
 *  - webhook tekrarları idempotent (tek kayıt, tek denetim, tek bildirim)
 *  - iptal → CANCELED ve koruma kapanır (cihaz config protectionActive=false)
 * Ek: deneme ilk olay / 30 gün; ödeme bekliyor 7 gün koruma + F-SUB-PAY; askıda F-SUB-SUSPENDED ve cihaz metni.
 */
const DAY = 86_400_000;
const T0 = new Date('2026-11-01T09:00:00Z');
const KEYS = `k1:${randomBytes(32).toString('base64')}`;
const SECRET = 'test-device-secret-0123456789abcdef';
const SIGNUP_SECRET = 'signup-secret-0123456789abcdef0123456789';
const STRIPE = { secretKey: 'sk_test_x', webhookSecret: 'whsec_test' };
const IYZ = { apiKey: 'sandbox-key', secretKey: 'sandbox-secret', merchantId: '1234' };

const facts = (f: Partial<SubscriptionFacts> = {}): SubscriptionFacts => ({
  status: 'TRIAL',
  startedAt: T0,
  trialEndsAt: new Date(T0.getTime() + 30 * DAY),
  pastDueSince: null,
  graceUntil: null,
  suspendedAt: null,
  renewsAt: null,
  lastProviderEventAt: null,
  ...f,
});
const pev = (type: PaymentEvent['type'], at: Date, extra: Partial<PaymentEvent> = {}): PaymentEvent => ({
  provider: 'FAKE',
  eventId: `e-${type}-${at.getTime()}`,
  type,
  occurredAt: at,
  rawType: type.toLowerCase(),
  ...extra,
});
const plus = (d: number, base = T0) => new Date(base.getTime() + d * DAY);

describe('yaşam döngüsü (saf)', () => {
  it('deneme: 30 gün koruma, sonra 7 gün ödeme bekliyor, sonra askıda', () => {
    const f = facts({ trialEndsAt: null });
    expect(effective(f, plus(29))).toMatchObject({ status: 'TRIAL', protectionActive: true });
    expect(effective(f, plus(31))).toMatchObject({ status: 'PAYMENT_PENDING', protectionActive: true });
    expect(effective(f, plus(38))).toMatchObject({ status: 'SUSPENDED', protectionActive: false });
    expect(effective(null, T0)).toMatchObject({ status: null, protectionActive: true });
  });

  it('denemeyi yalnız gerçek alarm bitirir', () => {
    expect(['SOS', 'FALL', 'INACTIVITY'].every(endsTrial)).toBe(true);
    expect(
      ['BATTERY_LOW', 'CONNECTION_LOST', 'WATCH_OFF', 'CALLBACK', 'FOLLOW_UP', 'TEST', undefined].some(endsTrial),
    ).toBe(false);
  });

  it('ilk olay denemeyi bitirir; ikinci olay ve bitmiş deneme dokunulmaz', () => {
    expect(onFirstEvent(facts(), plus(3))).toEqual({ trialEndsAt: plus(3) });
    expect(onFirstEvent(facts({ trialEndsAt: plus(3) }), plus(5))).toBeNull();
    expect(onFirstEvent(facts({ status: 'ACTIVE' }), plus(5))).toBeNull();
  });

  it('olay tablosu', () => {
    const id = 'sub-1';
    expect(onPaymentEvent(id, facts(), pev('CHECKOUT_COMPLETED', plus(1))).patch.status).toBe('ACTIVE');
    const failed = onPaymentEvent(id, facts({ status: 'ACTIVE' }), pev('PAYMENT_FAILED', plus(40)));
    expect(failed.patch).toMatchObject({ status: 'PAST_DUE', graceUntil: plus(40 + GRACE_DAYS) });
    expect(failed.notify?.code).toBe('F-SUB-PAY');
    // Zaten bekliyor: süre uzamaz, bildirim yok.
    const again = onPaymentEvent(
      id,
      facts({ status: 'PAST_DUE', graceUntil: plus(47) }),
      pev('PAYMENT_FAILED', plus(42)),
    );
    expect(again.notify).toBeUndefined();
    expect(again.patch.graceUntil).toBeUndefined();
    // Sıra dışı: eski olay durumu değiştirmez.
    const stale = onPaymentEvent(
      id,
      facts({ status: 'PAST_DUE', lastProviderEventAt: plus(40) }),
      pev('PAYMENT_SUCCEEDED', plus(39)),
    );
    expect(stale.outcome).toBe('stale');
    expect(stale.patch.status).toBeUndefined();
    // İptal son durum.
    expect(onPaymentEvent(id, facts({ status: 'CANCELED' }), pev('PAYMENT_SUCCEEDED', plus(50))).outcome).toBe(
      'terminal',
    );
  });

  it('tarama: deneme sonu → PAST_DUE (+F-SUB-PAY), bekleme sonu → askı (+F-SUB-SUSPENDED, bir kez)', () => {
    const t1 = onSweep('s', facts(), plus(30));
    expect(t1?.patch).toMatchObject({ status: 'PAST_DUE', pastDueSince: plus(30), graceUntil: plus(37) });
    expect(t1?.notify?.code).toBe('F-SUB-PAY');
    const pd = facts({ status: 'PAST_DUE', pastDueSince: plus(30), graceUntil: plus(37) });
    expect(onSweep('s', pd, plus(36))).toBeNull();
    expect(onSweep('s', pd, plus(37))?.notify?.code).toBe('F-SUB-SUSPENDED');
    expect(onSweep('s', { ...pd, suspendedAt: plus(37) }, plus(40))).toBeNull();
  });
});

describe('sağlayıcı imzaları', () => {
  it('Stripe: geçerli imza kabul, gövde değişirse / süre geçerse red', () => {
    const p = new StripeProvider(STRIPE);
    const body = JSON.stringify({
      id: 'evt_1',
      type: 'invoice.paid',
      created: T0.getTime() / 1000,
      data: {
        object: {
          customer: 'cus_1',
          parent: { subscription_details: { subscription: 'sub_1', metadata: { subscriptionId: 'abc' } } },
          lines: { data: [{ period: { end: plus(30).getTime() / 1000 } }] },
        },
      },
    });
    const sig = stripeSignature(STRIPE.webhookSecret, body, T0.getTime() / 1000);
    const ev = p.parseWebhook({ rawBody: Buffer.from(body), headers: { 'stripe-signature': sig } }, T0);
    expect(ev).toMatchObject({
      type: 'PAYMENT_SUCCEEDED',
      eventId: 'evt_1',
      subscriptionId: 'abc',
      providerSubscriptionRef: 'sub_1',
      periodEnd: plus(30),
    });
    expect(() =>
      p.parseWebhook({ rawBody: Buffer.from(body + ' '), headers: { 'stripe-signature': sig } }, T0),
    ).toThrow(SignatureError);
    expect(() => p.parseWebhook({ rawBody: Buffer.from(body), headers: { 'stripe-signature': sig } }, plus(1))).toThrow(
      SignatureError,
    );
  });

  it('iyzico: V3 imza ve IYZWSv2 yetki başlığı', () => {
    const p = new IyzicoProvider(IYZ);
    const b = {
      merchantId: '1234',
      iyziReferenceCode: 'ref-1',
      iyziEventType: 'subscription.order.failure',
      iyziEventTime: T0.getTime(),
      subscriptionReferenceCode: 'isub-1',
      orderReferenceCode: 'ord-1',
      customerReferenceCode: 'cus-1',
    };
    const raw = Buffer.from(JSON.stringify(b));
    const sig = iyzicoWebhookSignature(IYZ, b);
    expect(p.parseWebhook({ rawBody: raw, headers: { 'x-iyz-signature-v3': sig } })).toMatchObject({
      type: 'PAYMENT_FAILED',
      eventId: 'ref-1',
      providerSubscriptionRef: 'isub-1',
    });
    expect(() => p.parseWebhook({ rawBody: raw, headers: { 'x-iyz-signature-v3': sig.replace(/.$/, '0') } })).toThrow(
      SignatureError,
    );
    const auth = iyzicoAuth(IYZ, '/v2/x', '{}', 'rnd1');
    expect(Buffer.from(auth.replace('IYZWSv2 ', ''), 'base64').toString()).toMatch(
      /^apiKey:sandbox-key&randomKey:rnd1&signature:[0-9a-f]{64}$/,
    );
  });

  it("kayıt token'ı: aboneliğe ve süreye bağlı", () => {
    const { token } = issueSignupToken(SIGNUP_SECRET, 'sub-1', T0);
    expect(verifySignupToken(SIGNUP_SECRET, token, T0)).toBe('sub-1');
    expect(verifySignupToken(SIGNUP_SECRET, token, plus(1))).toBeNull();
    expect(verifySignupToken('başka-sır-0123456789abcdef0123456789', token, T0)).toBeNull();
    expect(verifySignupToken(SIGNUP_SECRET, token.replace('sub-1', 'sub-2'), T0)).toBeNull();
  });

  it('Keycloak hesabı: gerekli eylemler, telefon özniteliği, 409', async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    const http = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body?.toString() });
      if (url.endsWith('/token')) return Response.json({ access_token: 'at', expires_in: 300 });
      if (init.method === 'POST' && url.endsWith('/users') && calls.filter((c) => c.url.endsWith('/users')).length > 1)
        return new Response(null, { status: 409 });
      if (init.method === 'POST')
        return new Response(null, { status: 201, headers: { location: 'http://kc/admin/realms/consumers/users/u-1' } });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const kc = new KeycloakConsumerAccounts(
      {
        url: 'http://kc',
        realm: 'consumers',
        clientId: 'yanimda-signup',
        clientSecret: 's',
        appClientId: 'family-web',
      },
      http,
    );
    const u = { email: 'a@b.co', phone: '+905551112233', firstName: 'A', lastName: 'B' };
    expect(await kc.create(u)).toEqual({ subject: 'u-1' });
    const created = JSON.parse(calls.find((c) => c.url.endsWith('/users'))!.body!);
    expect(created).toMatchObject({
      username: 'a@b.co',
      emailVerified: false,
      requiredActions: ['VERIFY_EMAIL', 'UPDATE_PASSWORD'],
      attributes: { phone_number: ['+905551112233'], phone_number_verified: ['false'] },
    });
    expect(created.credentials).toBeUndefined(); // parola bizden geçmez
    await kc.sendSetupEmail('u-1', 'http://web/kayit/tamam');
    expect(calls.at(-1)!.url).toContain('/users/u-1/execute-actions-email?client_id=family-web');
    await expect(kc.create(u)).rejects.toMatchObject({ status: 409 });
  });
});

// ---- servis (PGlite) ----

let h: Harness;
let sms: { to: string; body: string }[];
let accounts: FakeConsumerAccounts;
let fake: FakePaymentProvider;
let stripeCalls: string[];
let billing: BillingService;
let profile: ProfileService;
let enrollment: EnrollmentService;

const cfg = (): BillingConfig => ({
  signupSecret: SIGNUP_SECRET,
  webBase: 'http://web',
  apiBase: 'http://api',
  kvkkNoticeVersion: 'taslak-1',
  exposeDevCode: true,
  env: { STRIPE_PRICE_STANDARD: 'price_std' },
  sweepMs: 0,
});
const stripeHttp = (async (url: string) => {
  stripeCalls.push(url);
  if (url.includes('/checkout/sessions'))
    return Response.json({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' });
  return Response.json({ id: 'sub_1', status: 'canceled' });
}) as typeof fetch;

const signupBody = (over: Record<string, unknown> = {}) => ({
  plan: 'STANDARD',
  country: 'TR',
  account: { firstName: 'Ayşe', lastName: 'Yılmaz', email: `aile${Math.random()}@example.com`, phone: '+905551112233' },
  protectedPerson: { displayName: 'Fatma Hanım' },
  consents: { kvkkNoticeVersion: 'taslak-1', explicitConsent: true },
  ...over,
});

const outboxCodes = async () =>
  (
    await h.rows<{ envelope: { payload: { code: string } } }>(
      `SELECT envelope FROM event.outbox WHERE topic = 'notify.requested' ORDER BY id`,
    )
  ).map((r) => r.envelope.payload.code);

const deviceConfig = async (protectedPersonId: string, kind = 'ANDROID_PHONE') =>
  (await enrollment.config({ deviceId: '00000000-0000-4000-8000-000000000001', protectedPersonId, kind })).body;

const signupAndVerify = async (over: Record<string, unknown> = {}) => {
  const r = await billing.signup(signupBody(over), `ip-${Math.random()}`);
  await billing.verifyPhone(r.subscriptionId, r.signupToken, { code: r.devCode });
  return r;
};

beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  sms = [];
  stripeCalls = [];
  accounts = new FakeConsumerAccounts();
  fake = new FakePaymentProvider('http://web');
  enrollment = new EnrollmentService(
    h.db,
    h.redis as never,
    new ProtectionService(h.db, h.outbox),
    staticRules(loadRulePack()),
    SECRET,
  );
  profile = new ProfileService(h.db, new FieldCipher(KEYS), enrollment);
  billing = new BillingService(
    h.db,
    h.outbox,
    h.redis as never,
    profile,
    accounts,
    registryOf({ TR: fake, US: new StripeProvider(STRIPE, stripeHttp) }),
    cfg(),
    { name: 'fake', sendSms: async (to: string, body: string) => (sms.push({ to, body }), { providerId: 'sms-1' }) },
  );
});
afterAll(async () => {
  await h.close();
});

describe('kayıt (hesap + kişi + deneme)', () => {
  it("Keycloak hesabı, OWNER, TRIAL 30 gün, KVKK rızası, doğrulama SMS'i; log/DB'de kişisel veri yok", async () => {
    const r = await billing.signup(signupBody(), 'ip-1', T0);
    expect(r).toMatchObject({ phoneVerification: 'SENT', trialEndsAt: plus(30).toISOString() });
    expect(r.devCode).toMatch(/^\d{6}$/);
    const [user] = [...accounts.users.values()];
    expect(user).toMatchObject({ phone: '+905551112233', phoneVerified: false, setupEmails: 1 });
    expect(sms).toHaveLength(1);
    expect(sms[0]!.body).toContain(r.devCode!);
    const [sub] = await h.rows<Record<string, unknown>>(`SELECT * FROM profile.subscription WHERE id = $1`, [
      r.subscriptionId,
    ]);
    expect(sub).toMatchObject({
      status: 'TRIAL',
      plan: 'STANDARD',
      country_code: 'TR',
      kvkk_notice_version: 'taslak-1',
    });
    expect(sub!.explicit_consent_at).toBeTruthy();
    const [m] = await h.rows(`SELECT role FROM profile.family_member WHERE protected_person_id = $1`, [
      r.protectedPersonId,
    ]);
    expect(m).toEqual({ role: 'OWNER' });
    const audit = await h.rows<{ data: unknown }>(`SELECT data FROM audit.log WHERE entity_id = $1`, [
      r.subscriptionId,
    ]);
    expect(JSON.stringify(audit)).not.toMatch(/example\.com|5551112233|Ayşe/);
  });

  it('rıza yoksa / eski aydınlatma sürümü 400; aynı e-posta 409 ve yarım kişi kalmaz', async () => {
    await expect(
      billing.signup(signupBody({ consents: { kvkkNoticeVersion: 'taslak-1', explicitConsent: false } }), 'i', T0),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      billing.signup(signupBody({ consents: { kvkkNoticeVersion: 'eski', explicitConsent: true } }), 'i', T0),
    ).rejects.toMatchObject({ status: 400 });
    const body = signupBody();
    await billing.signup(body, 'i2', T0);
    await expect(billing.signup(body, 'i3', T0)).rejects.toMatchObject({ status: 409 });
    expect(await h.rows(`SELECT id FROM profile.protected_person`)).toHaveLength(1);
  });

  it("telefon: hatalı kod 400, doğru kod Keycloak'ta doğrulanmış; ödeme doğrulamasız 409", async () => {
    const r = await billing.signup(signupBody(), 'i');
    await expect(billing.checkoutWithToken(r.subscriptionId, r.signupToken, {})).rejects.toMatchObject({ status: 409 });
    const wrong = r.devCode === '000000' ? '000001' : '000000';
    await expect(billing.verifyPhone(r.subscriptionId, r.signupToken, { code: wrong })).rejects.toMatchObject({
      status: 400,
    });
    await expect(billing.verifyPhone(r.subscriptionId, 'sahte', { code: r.devCode })).rejects.toMatchObject({
      status: 403,
    });
    await billing.verifyPhone(r.subscriptionId, r.signupToken, { code: r.devCode });
    expect([...accounts.users.values()][0]!.phoneVerified).toBe(true);
  });
});

describe('ödeme ve webhook', () => {
  it('KABUL: sahte sandbox ödeme → ACTIVE; cihaz config koruma açık', async () => {
    const r = await signupAndVerify();
    const s = await billing.checkoutWithToken(r.subscriptionId, r.signupToken, {
      billing: { city: 'İstanbul', address: 'x' },
    });
    expect(s.kind).toBe('redirect');
    const paid = await billing.fakePay(s.checkoutRef, {});
    expect(paid).toMatchObject({
      duplicate: false,
      outcome: 'applied',
      redirect: `http://web/kayit/tamam?sub=${r.subscriptionId}`,
    });
    const v = await billing.statusWithToken(r.subscriptionId, r.signupToken);
    expect(v).toMatchObject({
      status: 'ACTIVE',
      effectiveStatus: 'ACTIVE',
      protectionActive: true,
      paymentMethodOnFile: true,
    });
    expect((await deviceConfig(r.protectedPersonId)).subscription).toMatchObject({
      status: 'ACTIVE',
      protectionActive: true,
      messageCode: null,
    });
    const [p] = await h.rows(`SELECT status FROM profile.protected_person WHERE id = $1`, [r.protectedPersonId]);
    expect(p).toEqual({ status: 'ACTIVE' });
  });

  it('KABUL: webhook tekrarı idempotent (tek kayıt, tek denetim, tek bildirim); imzasız 400', async () => {
    const r = await signupAndVerify();
    const s = await billing.checkoutWithToken(r.subscriptionId, r.signupToken, {});
    await billing.fakePay(s.checkoutRef, {});
    const failed = fake.webhook({
      id: 'evt_fail_1',
      type: 'payment.failed',
      created: plus(31).getTime(),
      subscriptionId: r.subscriptionId,
    });
    const a = await billing.webhook(failed, plus(31));
    const b = await billing.webhook(failed, plus(31));
    const c = await billing.webhook(failed, plus(32));
    expect(a).toMatchObject({ duplicate: false, outcome: 'applied' });
    expect(b).toMatchObject({ duplicate: true });
    expect(c).toMatchObject({ duplicate: true });
    expect(await h.rows(`SELECT 1 FROM profile.payment_webhook WHERE provider_event_id = 'evt_fail_1'`)).toHaveLength(
      1,
    );
    expect(await outboxCodes()).toEqual(['F-SUB-PAY']);
    const audits = await h.rows(
      `SELECT action FROM audit.log WHERE entity_id = $1 AND action = 'subscription.payment_failed'`,
      [r.subscriptionId],
    );
    expect(audits).toHaveLength(1);
    expect((await billing.view(r.subscriptionId, plus(32))).effectiveStatus).toBe('PAYMENT_PENDING');

    const tampered = { ...failed, rawBody: Buffer.from(failed.rawBody.toString().replace('evt_fail_1', 'evt_fail_2')) };
    await expect(billing.webhook(tampered)).rejects.toMatchObject({ status: 400 });
    await expect(billing.webhook({ rawBody: Buffer.from('{}'), headers: {} })).rejects.toMatchObject({ status: 400 });
  });

  it('Stripe (US): checkout oturumu, imzalı checkout.session.completed → ACTIVE, ödeme hatası → PAST_DUE', async () => {
    const r = await signupAndVerify({ country: 'US' });
    const s = await billing.checkoutWithToken(r.subscriptionId, r.signupToken, {});
    expect(s).toEqual({ kind: 'redirect', url: 'https://checkout.stripe.test/cs_1', checkoutRef: 'cs_1' });
    const send = (body: object, at: Date) => {
      const raw = JSON.stringify(body);
      return billing.webhook(
        {
          rawBody: Buffer.from(raw),
          headers: { 'stripe-signature': stripeSignature(STRIPE.webhookSecret, raw, Math.floor(at.getTime() / 1000)) },
        },
        at,
      );
    };
    const now = new Date();
    await send(
      {
        id: 'evt_cs',
        type: 'checkout.session.completed',
        created: Math.floor(now.getTime() / 1000),
        data: {
          object: {
            id: 'cs_1',
            client_reference_id: r.subscriptionId,
            subscription: 'sub_1',
            customer: 'cus_1',
            payment_status: 'paid',
          },
        },
      },
      now,
    );
    expect((await billing.view(r.subscriptionId)).status).toBe('ACTIVE');
    const later = new Date(now.getTime() + 60_000);
    await send(
      {
        id: 'evt_fail',
        type: 'invoice.payment_failed',
        created: Math.floor(later.getTime() / 1000),
        data: { object: { customer: 'cus_1', parent: { subscription_details: { subscription: 'sub_1' } } } },
      },
      later,
    );
    expect((await billing.view(r.subscriptionId, later)).effectiveStatus).toBe('PAYMENT_PENDING');
    expect(await outboxCodes()).toEqual(['F-SUB-PAY']);
  });

  it('iyzico dönüşü: token ile sonuç okunur → ACTIVE ve web adım 3', async () => {
    const r = await signupAndVerify();
    const iyz = {
      ...fake,
      name: 'IYZICO' as const,
      owns: () => false,
      createCheckout: async () => ({ kind: 'embed' as const, html: '<script></script>', checkoutRef: 'tok-1' }),
      parseWebhook: fake.parseWebhook.bind(fake),
      cancel: async () => undefined,
      completeCheckout: async (token: string): Promise<PaymentEvent> => ({
        provider: 'IYZICO',
        eventId: `checkout:${token}`,
        type: 'CHECKOUT_COMPLETED',
        occurredAt: new Date(),
        checkoutRef: token,
        providerSubscriptionRef: 'isub-1',
        rawType: 'checkoutform.active',
      }),
    };
    billing = new BillingService(
      h.db,
      h.outbox,
      h.redis as never,
      profile,
      accounts,
      registryOf({ TR: iyz }),
      { ...cfg(), env: { IYZICO_PLAN_STANDARD: 'iyz-plan' } },
      {
        name: 'fake',
        sendSms: async () => ({ providerId: 'x' }),
      },
    );
    await expect(billing.checkoutWithToken(r.subscriptionId, r.signupToken, {})).rejects.toMatchObject({ status: 400 });
    const s = await billing.checkoutWithToken(r.subscriptionId, r.signupToken, {
      billing: { city: 'Ankara', address: 'Çankaya' },
    });
    expect(s.kind).toBe('embed');
    expect(await billing.iyzicoCallback('tok-1')).toBe(`http://web/kayit/tamam?sub=${r.subscriptionId}`);
    expect(await billing.iyzicoCallback('tok-1')).toBe(`http://web/kayit/tamam?sub=${r.subscriptionId}`); // tekrar
    expect((await billing.view(r.subscriptionId)).status).toBe('ACTIVE');
    await expect(billing.iyzicoCallback('bilinmeyen')).rejects.toMatchObject({ status: 404 });
  });
});

describe('deneme, bekleme, askı', () => {
  it('ilk gerçek olay denemeyi bitirir → PAST_DUE + F-SUB-PAY → 7 gün sonra askı + F-SUB-SUSPENDED, cihazda koruma kapalı', async () => {
    const r = await billing.signup(signupBody(), 'i', T0);
    const pp = r.protectedPersonId;
    expect(await billing.onEventCreated({ protectedPersonId: pp, type: 'SOS', isTest: true }, plus(2))).toBe(false);
    expect(await billing.onEventCreated({ protectedPersonId: pp, type: 'SOS' }, plus(3))).toBe(true);
    expect(await billing.onEventCreated({ protectedPersonId: pp, type: 'FALL' }, plus(4))).toBe(false);

    expect(await billing.sweep(plus(3, new Date(T0.getTime() + 1000)))).toBe(1);
    expect(await outboxCodes()).toEqual(['F-SUB-PAY']);
    const pending = await deviceConfig(r.protectedPersonId);
    expect(pending.subscription).toMatchObject({
      status: 'PAYMENT_PENDING',
      protectionActive: true,
      messageCode: 'P-SUB-PAY',
    });
    expect(pending.messages['P-SUB-PAY']).toBeDefined();
    expect(await billing.sweep(plus(9))).toBe(0);

    expect(await billing.sweep(plus(10))).toBe(1);
    expect(await billing.sweep(plus(11))).toBe(0);
    expect(await outboxCodes()).toEqual(['F-SUB-PAY', 'F-SUB-SUSPENDED']);
    const view = await billing.view(r.subscriptionId, plus(11));
    expect(view).toMatchObject({ status: 'PAST_DUE', effectiveStatus: 'SUSPENDED', protectionActive: false });

    // Ödeme gelince askı kalkar.
    await billing.apply(
      pev('PAYMENT_SUCCEEDED', plus(12), { subscriptionId: r.subscriptionId, eventId: 'late-pay' }),
      plus(12),
    );
    expect(await billing.view(r.subscriptionId, plus(12))).toMatchObject({ status: 'ACTIVE', protectionActive: true });
  });

  it('sistem olayları (pil, bağlantı, saat çıkarıldı, geri arama, takip) denemeyi bitirmez (inceleme bulgusu 5)', async () => {
    const r = await billing.signup(signupBody(), 'i', T0);
    for (const type of [
      'BATTERY_LOW',
      'BATTERY_DEAD',
      'CONNECTION_LOST',
      'WATCH_OFF',
      'CALLBACK',
      'FOLLOW_UP',
      undefined,
    ])
      expect(await billing.onEventCreated({ protectedPersonId: r.protectedPersonId, type }, plus(2))).toBe(false);
    expect(await billing.sweep(plus(3))).toBe(0);
    expect((await billing.view(r.subscriptionId, plus(3))).effectiveStatus).toBe('TRIAL');
    expect(await billing.onEventCreated({ protectedPersonId: r.protectedPersonId, type: 'INACTIVITY' }, plus(4))).toBe(
      true,
    );
  });

  it('süren olay varken tarama ertelenir: acil durumun ortasında F-SUB-PAY / askı gitmez (inceleme bulgusu 5)', async () => {
    const r = await billing.signup(signupBody(), 'i', T0);
    const pp = r.protectedPersonId;
    expect(await billing.onEventCreated({ protectedPersonId: pp, type: 'SOS' }, plus(3))).toBe(true);
    const ev = '01960000-0000-7000-8000-000000000001';
    await h.pg.query(
      `INSERT INTO event.event (id, protected_person_id, type, priority, state, created_at, source_signal_ids, is_test)
       VALUES ($1, $2, 'SOS', 1, 'CONTACT_CHAIN', $3, '{}', false)`,
      [ev, pp, plus(3)],
    );
    expect(await billing.sweep(plus(3, new Date(T0.getTime() + 60_000)))).toBe(0);
    expect(await outboxCodes()).toEqual([]);
    // Test olayı açıkken ertelenmez; gerçek olay kapanınca işlenir.
    await h.pg.query("UPDATE event.event SET state = 'CLOSED', closed_at = $2 WHERE id = $1", [ev, plus(3)]);
    expect(await billing.sweep(plus(3, new Date(T0.getTime() + 120_000)))).toBe(1);
    expect(await outboxCodes()).toEqual(['F-SUB-PAY']);

    // Bekleme biterken yine süren olay varsa askı ertelenir.
    const ev2 = '01960000-0000-7000-8000-000000000002';
    await h.pg.query(
      `INSERT INTO event.event (id, protected_person_id, type, priority, state, created_at, source_signal_ids, is_test)
       VALUES ($1, $2, 'FALL', 1, 'OPERATOR_QUEUE', $3, '{}', false)`,
      [ev2, pp, plus(10)],
    );
    expect(await billing.sweep(plus(11))).toBe(0);
    await h.pg.query("UPDATE event.event SET state = 'CLOSED', closed_at = $2 WHERE id = $1", [ev2, plus(11)]);
    expect(await billing.sweep(plus(11))).toBe(1);
    expect(await outboxCodes()).toEqual(['F-SUB-PAY', 'F-SUB-SUSPENDED']);
  });

  it('olay olmazsa 30. gün PAST_DUE', async () => {
    const r = await billing.signup(signupBody(), 'i', T0);
    expect(await billing.sweep(plus(29))).toBe(0);
    expect(await billing.sweep(plus(30))).toBe(1);
    expect((await billing.view(r.subscriptionId, plus(30))).effectiveStatus).toBe('PAYMENT_PENDING');
  });
});

describe('tek tık iptal', () => {
  it('KABUL: iptal → CANCELED, sağlayıcıda sonlanır, cihaz config koruma kapalı; geç webhook geri açmaz', async () => {
    const r = await signupAndVerify();
    const s = await billing.checkoutWithToken(r.subscriptionId, r.signupToken, {});
    await billing.fakePay(s.checkoutRef, {});
    const owner: Actor = { kind: 'FAMILY', id: [...accounts.users.keys()][0]! };
    const v = await billing.cancel(owner, r.protectedPersonId);
    expect(v).toMatchObject({ status: 'CANCELED', effectiveStatus: 'CANCELED', protectionActive: false });
    expect(fake.canceled).toEqual([`fake_sub_${r.subscriptionId}`]);
    for (const kind of ['ANDROID_PHONE', 'WEAROS_WATCH']) {
      const c = await deviceConfig(r.protectedPersonId, kind);
      expect(c.subscription).toMatchObject({ status: 'CANCELED', protectionActive: false });
      expect(c.messages[c.subscription.messageCode!]).toBeDefined();
    }
    const late = fake.webhook({
      id: 'evt_late',
      type: 'payment.succeeded',
      created: Date.now() + 1000,
      subscriptionId: r.subscriptionId,
    });
    expect(await billing.webhook(late)).toMatchObject({ outcome: 'terminal' });
    expect((await billing.view(r.subscriptionId)).status).toBe('CANCELED');
    await expect(billing.cancel(owner, r.protectedPersonId)).rejects.toMatchObject({ status: 404 });
  });

  it('yalnız sahip iptal eder: MEMBER 403, başka aile 404; deneme (ödemesiz) iptal sağlayıcıya gitmez', async () => {
    const r = await billing.signup(signupBody(), 'i', T0);
    await h.pg.query(
      `INSERT INTO profile.family_member (id, protected_person_id, subject, role) VALUES (gen_random_uuid(), $1, 'member-1', 'MEMBER')`,
      [r.protectedPersonId],
    );
    await expect(billing.cancel({ kind: 'FAMILY', id: 'member-1' }, r.protectedPersonId)).rejects.toMatchObject({
      status: 403,
    });
    await expect(billing.cancel({ kind: 'FAMILY', id: 'yabancı' }, r.protectedPersonId)).rejects.toMatchObject({
      status: 404,
    });
    await billing.cancel({ kind: 'FAMILY', id: [...accounts.users.keys()][0]! }, r.protectedPersonId);
    expect(fake.canceled).toEqual([]);
    expect((await billing.view(r.subscriptionId)).status).toBe('CANCELED');
  });

  it('abonelik dışı kişi (yönetici oluşturdu) cihazda korumalı kalır', async () => {
    const p = await profile.create({ kind: 'ADMIN' }, { displayName: 'Kurumsal' });
    await h.pg.query(`DELETE FROM profile.subscription WHERE protected_person_id = $1`, [p.id]);
    expect((await deviceConfig(p.id)).subscription).toEqual({
      status: null,
      protectionActive: true,
      until: null,
      messageCode: null,
    });
  });
});
