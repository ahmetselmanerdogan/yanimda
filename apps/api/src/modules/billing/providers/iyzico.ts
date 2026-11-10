import { randomBytes } from 'node:crypto';

import type { PaymentEvent, PaymentEventType } from '../lifecycle';
import {
  type CheckoutRequest,
  type CheckoutSession,
  header,
  hmacHex,
  parseJson,
  type PaymentProvider,
  safeEqualHex,
  SignatureError,
  str,
  type WebhookInput,
} from './provider';

export interface IyzicoConfig {
  apiKey: string;
  secretKey: string;
  merchantId: string;
  /** Sandbox: https://sandbox-api.iyzipay.com · Canlı: https://api.iyzipay.com */
  baseUrl?: string;
}

type Fetch = typeof fetch;
type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});

/** iyzico IYZWSv2: base64("apiKey:…&randomKey:…&signature:" + hex(HMAC-SHA256(secret, rnd + yol + gövde))). */
export function iyzicoAuth(cfg: Pick<IyzicoConfig, 'apiKey' | 'secretKey'>, path: string, body: string, rnd: string) {
  const signature = hmacHex(cfg.secretKey, rnd + path + body);
  return `IYZWSv2 ${Buffer.from(`apiKey:${cfg.apiKey}&randomKey:${rnd}&signature:${signature}`).toString('base64')}`;
}

/**
 * Abonelik bildirimi imzası (`X-IYZ-SIGNATURE-V3`): hex(HMAC-SHA256(secretKey,
 * merchantId + secretKey + iyziEventType + subscriptionReferenceCode + orderReferenceCode + customerReferenceCode)).
 */
export function iyzicoWebhookSignature(cfg: Pick<IyzicoConfig, 'secretKey' | 'merchantId'>, b: Obj): string {
  const f = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '');
  return hmacHex(
    cfg.secretKey,
    cfg.merchantId +
      cfg.secretKey +
      f('iyziEventType') +
      f('subscriptionReferenceCode') +
      f('orderReferenceCode') +
      f('customerReferenceCode'),
  );
}

const TYPES: Record<string, PaymentEventType> = {
  'subscription.order.success': 'PAYMENT_SUCCEEDED',
  'subscription.order.failure': 'PAYMENT_FAILED',
};

/**
 * iyzico Abonelik Checkout Form (TR). Fiyat planı iyzico panelinde (`IYZICO_PLAN_<PLAN>` = pricingPlanReferenceCode).
 * Akış: initialize → gömülü form (checkoutFormContent) → iyzico tarayıcıyı callbackUrl'e token ile POST eder →
 * `completeCheckout(token)` sonucu iyzico'dan çeker (callback imzasızdır; sonuç kendi kimlik bilgimizle okunur).
 * Yenileme sonuçları webhook (`subscription.order.success|failure`). İptalde iyzico bildirim göndermez.
 */
export class IyzicoProvider implements PaymentProvider {
  readonly name = 'IYZICO' as const;
  private readonly base: string;

  constructor(
    private readonly cfg: IyzicoConfig,
    private readonly http: Fetch = fetch,
  ) {
    this.base = (cfg.baseUrl ?? 'https://sandbox-api.iyzipay.com').replace(/\/+$/, '');
  }

  owns(h: WebhookInput['headers']) {
    return !!header(h, 'x-iyz-signature-v3');
  }

  private async call(method: 'GET' | 'POST', path: string, body?: Obj): Promise<Obj> {
    const json = body ? JSON.stringify(body) : '';
    const rnd = `${Date.now()}${randomBytes(4).toString('hex')}`;
    const r = await this.http(`${this.base}${path}`, {
      method,
      headers: {
        authorization: iyzicoAuth(this.cfg, path, json, rnd),
        'x-iyzi-rnd': rnd,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      ...(body ? { body: json } : {}),
    });
    const j = o(await r.json().catch(() => ({})));
    if (!r.ok || j.status !== 'success')
      throw new Error(`iyzico ${path.split('/')[3] ?? ''} HTTP ${r.status} ${str(j.errorCode) ?? ''}`.trim());
    return j;
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    const contactName = `${req.customer.firstName} ${req.customer.lastName}`;
    const address = {
      contactName,
      city: req.billing?.city ?? '',
      country: 'Turkey',
      address: req.billing?.address ?? '',
    };
    const j = await this.call('POST', '/v2/subscription/checkoutform/initialize', {
      locale: 'tr',
      conversationId: req.subscriptionId,
      callbackUrl: req.callbackUrl,
      pricingPlanReferenceCode: req.plan.providerPriceRef,
      subscriptionInitialStatus: 'ACTIVE',
      customer: {
        name: req.customer.firstName,
        surname: req.customer.lastName,
        email: req.customer.email,
        gsmNumber: req.customer.phone,
        // iyzico zorunlu alan. TCKN toplanmıyor (KVKK veri en aza indirme); e-arşiv fatura için gerekip
        // gerekmediği muhasebe/hukuk kararı bekliyor — o zamana kadar iyzico'nun kabul ettiği yer tutucu.
        identityNumber: '11111111111',
        billingAddress: address,
        shippingAddress: address,
      },
    });
    const token = str(j.token);
    const html = str(j.checkoutFormContent);
    if (!token || !html) throw new Error('iyzico checkout yanıtı eksik');
    return { kind: 'embed', html, checkoutRef: token };
  }

  async completeCheckout(token: string): Promise<PaymentEvent> {
    const j = await this.call('GET', `/v2/subscription/checkoutform/${encodeURIComponent(token)}`);
    const d = o(j.data);
    return {
      provider: this.name,
      eventId: `checkout:${token}`,
      type: d.subscriptionStatus === 'ACTIVE' ? 'CHECKOUT_COMPLETED' : 'IGNORED',
      occurredAt: new Date(),
      checkoutRef: token,
      providerSubscriptionRef: str(d.referenceCode),
      providerCustomerRef: str(d.customerReferenceCode),
      rawType: `checkoutform.${str(d.subscriptionStatus) ?? 'unknown'}`.toLowerCase(),
    };
  }

  parseWebhook({ rawBody, headers }: WebhookInput): PaymentEvent {
    const sig = header(headers, 'x-iyz-signature-v3');
    if (!sig) throw new SignatureError('X-IYZ-SIGNATURE-V3 yok');
    const b = parseJson(rawBody);
    if (str(b.merchantId) !== this.cfg.merchantId) throw new SignatureError('üye işyeri eşleşmiyor');
    if (!safeEqualHex(sig.toLowerCase(), iyzicoWebhookSignature(this.cfg, b))) throw new SignatureError();
    const type = str(b.iyziEventType) ?? '';
    const at = Number(b.iyziEventTime);
    return {
      provider: this.name,
      eventId: str(b.iyziReferenceCode) ?? `${type}:${str(b.orderReferenceCode) ?? ''}`,
      type: TYPES[type] ?? 'IGNORED',
      occurredAt: Number.isFinite(at) && at > 0 ? new Date(at) : new Date(),
      providerSubscriptionRef: str(b.subscriptionReferenceCode),
      providerCustomerRef: str(b.customerReferenceCode),
      rawType: type,
    };
  }

  async cancel(ref: string): Promise<void> {
    await this.call('POST', `/v2/subscription/subscriptions/${encodeURIComponent(ref)}/cancel`, {});
  }
}
