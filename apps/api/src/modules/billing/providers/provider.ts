import { createHmac, timingSafeEqual } from 'node:crypto';

import type { PaymentEvent } from '../lifecycle';

export type ProviderName = 'IYZICO' | 'STRIPE' | 'FAKE';

export interface CheckoutRequest {
  subscriptionId: string;
  plan: { code: string; providerPriceRef: string };
  customer: { email: string; phone: string; firstName: string; lastName: string };
  /** Ödeme bitince dönülecek web adresi (adım 3). */
  successUrl: string;
  cancelUrl: string;
  /** Sağlayıcının tarayıcıyı POST ile döndürdüğü API adresi (iyzico). */
  callbackUrl: string;
  /** Fatura adresi (iyzico zorunlu; Stripe kendi sayfasında toplar). Saklanmaz, yalnız sağlayıcıya iletilir. */
  billing?: { city: string; address: string };
}

/** Barındırılan ödeme sayfası: yönlendirme (Stripe, sahte) veya gömülü form (iyzico Checkout Form). */
export type CheckoutSession =
  { kind: 'redirect'; url: string; checkoutRef: string } | { kind: 'embed'; html: string; checkoutRef: string };

export interface WebhookInput {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

export class SignatureError extends Error {
  constructor(msg = 'imza geçersiz') {
    super(msg);
  }
}

/**
 * Ödeme sağlayıcısı soyutlaması (T-060). Kart verisi bize hiç gelmez: ödeme sağlayıcının sayfasında alınır.
 * `parseWebhook` imzayı doğrular (geçersizse SignatureError) ve olayı sağlayıcıdan bağımsız biçime çevirir.
 */
export interface PaymentProvider {
  readonly name: ProviderName;
  /** Bu isteğin başlıkları bu sağlayıcıya mı ait (tek webhook ucu: /v1/webhooks/payments). */
  owns(headers: WebhookInput['headers']): boolean;
  createCheckout(req: CheckoutRequest): Promise<CheckoutSession>;
  parseWebhook(input: WebhookInput, now?: Date): PaymentEvent;
  /** Sağlayıcıdaki aboneliği sonlandır (tekrar çağrılırsa hata vermemeli). */
  cancel(providerSubscriptionRef: string): Promise<void>;
  /** Tarayıcı dönüşü (iyzico callback token'ı) → tamamlanma olayı. Yalnız iyzico. */
  completeCheckout?(checkoutRef: string): Promise<PaymentEvent>;
}

export const header = (h: WebhookInput['headers'], name: string): string | undefined => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

export const hmacHex = (key: string, data: string | Buffer) => createHmac('sha256', key).update(data).digest('hex');

export function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export function parseJson(raw: Buffer): Record<string, unknown> {
  try {
    const v = JSON.parse(raw.toString('utf8')) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* aşağıda */
  }
  throw new SignatureError('gövde JSON değil');
}

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
