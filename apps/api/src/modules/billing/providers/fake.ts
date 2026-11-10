import { randomUUID } from 'node:crypto';

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

/** Geliştirme / test sırrı (gerçek para yok). Üretimde sahte sağlayıcı açılamaz. */
export const FAKE_PAYMENT_SECRET = 'fake-payment-webhook-secret';

export interface FakeWebhookBody {
  id: string;
  type: 'checkout.completed' | 'payment.succeeded' | 'payment.failed' | 'subscription.canceled';
  created: number;
  subscriptionId?: string;
  subscriptionRef?: string;
  checkoutRef?: string;
  periodEnd?: number;
}

const TYPES: Record<FakeWebhookBody['type'], PaymentEventType> = {
  'checkout.completed': 'CHECKOUT_COMPLETED',
  'payment.succeeded': 'PAYMENT_SUCCEEDED',
  'payment.failed': 'PAYMENT_FAILED',
  'subscription.canceled': 'SUBSCRIPTION_CANCELED',
};

/** `X-Fake-Signature`: hex(HMAC-SHA256(sır, ham gövde)). */
export function signFake(body: string, secret = FAKE_PAYMENT_SECRET) {
  return hmacHex(secret, body);
}

/**
 * Sahte ödeme sağlayıcısı (gerçek sandbox hesabı olmadan uçtan uca deneme ve testler). Checkout adresi aile
 * web'inin `/odeme/sahte` sayfasıdır; oradaki "Öde" düğmesi API'nin `POST /v1/payments/fake/{ref}/pay` ucunu
 * çağırır, uç imzalı bir webhook gövdesi üretip GERÇEK webhook yolundan (imza doğrulama + tekrar ayıklama) geçirir.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'FAKE' as const;
  readonly canceled: string[] = [];
  readonly checkouts: CheckoutRequest[] = [];

  constructor(
    private readonly webBase = 'http://localhost:5175',
    private readonly secret = FAKE_PAYMENT_SECRET,
  ) {}

  owns(h: WebhookInput['headers']) {
    return !!header(h, 'x-fake-signature');
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    this.checkouts.push(req);
    const checkoutRef = `fake_cs_${randomUUID()}`;
    const url = `${this.webBase}/odeme/sahte?ref=${encodeURIComponent(checkoutRef)}&sub=${req.subscriptionId}`;
    return { kind: 'redirect', url, checkoutRef };
  }

  /** Sağlayıcının göndereceği webhook'u üretir (imzalı). */
  webhook(body: FakeWebhookBody): WebhookInput {
    const raw = JSON.stringify(body);
    return { rawBody: Buffer.from(raw), headers: { 'x-fake-signature': signFake(raw, this.secret) } };
  }

  parseWebhook({ rawBody, headers }: WebhookInput): PaymentEvent {
    const sig = header(headers, 'x-fake-signature');
    if (!sig || !safeEqualHex(sig, signFake(rawBody.toString(), this.secret))) throw new SignatureError();
    const b = parseJson(rawBody) as Partial<FakeWebhookBody>;
    const type = TYPES[b.type as FakeWebhookBody['type']] ?? 'IGNORED';
    return {
      provider: this.name,
      eventId: str(b.id) ?? '',
      type,
      occurredAt: new Date(Number(b.created) || Date.now()),
      subscriptionId: str(b.subscriptionId),
      providerSubscriptionRef: str(b.subscriptionRef),
      checkoutRef: str(b.checkoutRef),
      ...(b.periodEnd ? { periodEnd: new Date(b.periodEnd) } : {}),
      rawType: str(b.type) ?? 'unknown',
    };
  }

  async cancel(ref: string): Promise<void> {
    this.canceled.push(ref);
  }
}
