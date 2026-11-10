import { Logger } from '@nestjs/common';

import type { ProviderRegistry } from '../billing.service';
import type { Country } from '../plans';
import { FakePaymentProvider } from './fake';
import { IyzicoProvider } from './iyzico';
import type { PaymentProvider, ProviderName } from './provider';
import { StripeProvider } from './stripe';

/** Sabit eşleme: TR → iyzico, US → Stripe; sahte modda hepsi sahte. */
export function registryOf(byCountry: Partial<Record<Country, PaymentProvider>>): ProviderRegistry {
  const all = [...new Set(Object.values(byCountry))];
  return {
    forCountry: (c) => byCountry[c] ?? null,
    byName: (n: ProviderName) => all.find((p) => p.name === n) ?? null,
    all: () => all,
  };
}

/**
 * PAYMENT_PROVIDER: live | fake. Varsayılan: üretimde live; geliştirmede anahtar yoksa fake.
 * live: TR için IYZICO_API_KEY + IYZICO_SECRET_KEY + IYZICO_MERCHANT_ID, US için STRIPE_SECRET_KEY +
 * STRIPE_WEBHOOK_SECRET; eksik olan ülkede ödeme kapalı (kayıt 503).
 */
export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderRegistry {
  const log = new Logger('Billing');
  const prod = env.NODE_ENV === 'production';
  const hasIyzico = !!(env.IYZICO_API_KEY && env.IYZICO_SECRET_KEY && env.IYZICO_MERCHANT_ID);
  const hasStripe = !!(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
  const kind = env.PAYMENT_PROVIDER || (prod || hasIyzico || hasStripe ? 'live' : 'fake');
  if (kind === 'fake') {
    if (prod) throw new Error('Üretimde PAYMENT_PROVIDER=fake kullanılamaz');
    log.warn('Ödeme sağlayıcısı SAHTE (PAYMENT_PROVIDER=fake): gerçek tahsilat yok');
    const fake = new FakePaymentProvider(
      env.FAMILY_WEB_URL || 'http://localhost:5175',
      env.FAKE_PAYMENT_SECRET || undefined,
    );
    return registryOf({ TR: fake, US: fake });
  }
  if (kind !== 'live') throw new Error(`Bilinmeyen PAYMENT_PROVIDER: ${kind}`);
  const map: Partial<Record<Country, PaymentProvider>> = {};
  if (hasIyzico)
    map.TR = new IyzicoProvider({
      apiKey: env.IYZICO_API_KEY!,
      secretKey: env.IYZICO_SECRET_KEY!,
      merchantId: env.IYZICO_MERCHANT_ID!,
      baseUrl: env.IYZICO_BASE_URL || undefined,
    });
  else log.warn('iyzico anahtarları yok: TR ödemesi kapalı');
  if (hasStripe)
    map.US = new StripeProvider({ secretKey: env.STRIPE_SECRET_KEY!, webhookSecret: env.STRIPE_WEBHOOK_SECRET! });
  else log.warn('Stripe anahtarları yok: US ödemesi kapalı');
  return registryOf(map);
}
