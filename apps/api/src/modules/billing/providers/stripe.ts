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

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  apiBase?: string;
  /** İmza zaman damgası toleransı (sn). Stripe önerisi 300. */
  toleranceSec?: number;
}

type Fetch = typeof fetch;
type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});

/** `Stripe-Signature: t=<unix>,v1=<hex>[,v1=…]` — HMAC-SHA256(whsec, "<t>.<ham gövde>"). */
export function stripeSignature(secret: string, rawBody: Buffer | string, t: number): string {
  return `t=${t},v1=${hmacHex(secret, `${t}.${rawBody.toString()}`)}`;
}

const TYPES: Record<string, PaymentEventType> = {
  'checkout.session.completed': 'CHECKOUT_COMPLETED',
  'invoice.paid': 'PAYMENT_SUCCEEDED',
  'invoice.payment_failed': 'PAYMENT_FAILED',
  'customer.subscription.deleted': 'SUBSCRIPTION_CANCELED',
};

/**
 * Stripe Checkout (US). Abonelik modu: fiyat Stripe panosunda (`STRIPE_PRICE_<PLAN>`), kart Stripe sayfasında.
 * Bizim abonelik kimliğimiz `client_reference_id` ve `subscription_data.metadata.subscriptionId` ile taşınır.
 * Resmî SDK yerine REST (form kodlu) — bağımlılık yok; API sürümü hesap varsayılanı.
 */
export class StripeProvider implements PaymentProvider {
  readonly name = 'STRIPE' as const;
  private readonly base: string;

  constructor(
    private readonly cfg: StripeConfig,
    private readonly http: Fetch = fetch,
  ) {
    this.base = (cfg.apiBase ?? 'https://api.stripe.com').replace(/\/+$/, '');
  }

  owns(h: WebhookInput['headers']) {
    return !!header(h, 'stripe-signature');
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    const form = new URLSearchParams({
      mode: 'subscription',
      'line_items[0][price]': req.plan.providerPriceRef,
      'line_items[0][quantity]': '1',
      success_url: `${req.successUrl}${req.successUrl.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: req.cancelUrl,
      client_reference_id: req.subscriptionId,
      customer_email: req.customer.email,
      'metadata[subscriptionId]': req.subscriptionId,
      'subscription_data[metadata][subscriptionId]': req.subscriptionId,
      locale: 'auto',
    });
    const r = await this.http(`${this.base}/v1/checkout/sessions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.cfg.secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
        // Aynı dakika içinde çift tıklama tek oturum açsın.
        'idempotency-key': `checkout:${req.subscriptionId}:${Math.floor(Date.now() / 60_000)}`,
      },
      body: form,
    });
    if (!r.ok) throw new Error(`stripe checkout HTTP ${r.status}`);
    const j = o(await r.json());
    const url = str(j.url);
    const id = str(j.id);
    if (!url || !id) throw new Error('stripe checkout yanıtı eksik');
    return { kind: 'redirect', url, checkoutRef: id };
  }

  parseWebhook({ rawBody, headers }: WebhookInput, now = new Date()): PaymentEvent {
    const sig = header(headers, 'stripe-signature');
    if (!sig) throw new SignatureError('Stripe-Signature yok');
    const parts = sig.split(',').map((p) => p.trim().split('=') as [string, string]);
    const t = Number(parts.find(([k]) => k === 't')?.[1]);
    const v1 = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
    if (!Number.isFinite(t) || !v1.length) throw new SignatureError('Stripe-Signature biçimi');
    if (Math.abs(now.getTime() / 1000 - t) > (this.cfg.toleranceSec ?? 300)) throw new SignatureError('zaman aşımı');
    const expected = hmacHex(this.cfg.webhookSecret, Buffer.concat([Buffer.from(`${t}.`), rawBody]));
    if (!v1.some((v) => safeEqualHex(v, expected))) throw new SignatureError();

    const evt = parseJson(rawBody);
    const type = str(evt.type) ?? '';
    const obj = o(o(evt.data).object);
    const base = {
      provider: this.name,
      eventId: str(evt.id) ?? `${type}:${t}`,
      occurredAt: new Date((Number(evt.created) || t) * 1000),
      rawType: type,
    };
    const mapped = TYPES[type] ?? 'IGNORED';
    if (type === 'checkout.session.completed') {
      const paid = obj.payment_status === 'paid' || obj.payment_status === 'no_payment_required';
      return {
        ...base,
        type: paid ? 'CHECKOUT_COMPLETED' : 'IGNORED',
        subscriptionId: str(obj.client_reference_id) ?? str(o(obj.metadata).subscriptionId),
        providerSubscriptionRef: str(obj.subscription),
        providerCustomerRef: str(obj.customer),
        checkoutRef: str(obj.id),
      };
    }
    if (type.startsWith('invoice.')) {
      // API 2025+: abonelik bilgisi invoice.parent.subscription_details altında; eski sürümler kökte.
      const details = o(o(obj.parent).subscription_details);
      const legacy = o(obj.subscription_details);
      const lines = o(obj.lines).data;
      const end = Number(o(o(Array.isArray(lines) ? lines[0] : null).period).end);
      return {
        ...base,
        type: mapped,
        subscriptionId: str(o(details.metadata).subscriptionId) ?? str(o(legacy.metadata).subscriptionId),
        providerSubscriptionRef: str(details.subscription) ?? str(obj.subscription),
        providerCustomerRef: str(obj.customer),
        ...(Number.isFinite(end) && end > 0 ? { periodEnd: new Date(end * 1000) } : {}),
      };
    }
    if (type.startsWith('customer.subscription.')) {
      return {
        ...base,
        type: mapped,
        subscriptionId: str(o(obj.metadata).subscriptionId),
        providerSubscriptionRef: str(obj.id),
        providerCustomerRef: str(obj.customer),
      };
    }
    return { ...base, type: 'IGNORED' };
  }

  async cancel(ref: string): Promise<void> {
    const r = await this.http(`${this.base}/v1/subscriptions/${encodeURIComponent(ref)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${this.cfg.secretKey}` },
    });
    if (r.ok || r.status === 404) return; // zaten silinmiş
    throw new Error(`stripe iptal HTTP ${r.status}`);
  }
}
