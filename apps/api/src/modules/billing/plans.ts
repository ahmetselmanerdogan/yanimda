/**
 * T-060 paketler. Fiyatın kendisi sağlayıcı panosundadır (Stripe Price / iyzico fiyat planı); burada web'de
 * gösterilecek tutar ve sağlayıcı referansının ortam değişkeni adı durur.
 * YER TUTUCU: tutarlar ürün/finans onayı bekliyor (yanıtta `placeholder: true`).
 */
export type Country = 'TR' | 'US';
export const COUNTRIES: readonly Country[] = ['TR', 'US'];

export interface Plan {
  code: string;
  interval: 'month' | 'year';
  /** Katalog kodu (paket adı, web). */
  nameCode: string;
  prices: Record<Country, { currency: string; amountMinor: number }>;
}

export const PLANS: readonly Plan[] = [
  {
    code: 'STANDARD',
    interval: 'month',
    nameCode: 'F-WEB-PLAN-STANDARD',
    prices: { TR: { currency: 'TRY', amountMinor: 39_900 }, US: { currency: 'USD', amountMinor: 2_900 } },
  },
  {
    code: 'STANDARD_YEARLY',
    interval: 'year',
    nameCode: 'F-WEB-PLAN-STANDARD_YEARLY',
    prices: { TR: { currency: 'TRY', amountMinor: 399_000 }, US: { currency: 'USD', amountMinor: 29_000 } },
  },
];

export const planOf = (code: unknown): Plan | undefined => PLANS.find((p) => p.code === code);
export const isCountry = (c: unknown): c is Country => COUNTRIES.includes(c as Country);

/** Sağlayıcı fiyat referansı: Stripe `STRIPE_PRICE_<PLAN>`, iyzico `IYZICO_PLAN_<PLAN>`; sahte sağlayıcıda plan kodu. */
export function priceRefOf(
  plan: Plan,
  provider: 'IYZICO' | 'STRIPE' | 'FAKE',
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (provider === 'FAKE') return plan.code;
  return env[`${provider === 'STRIPE' ? 'STRIPE_PRICE' : 'IYZICO_PLAN'}_${plan.code}`] || undefined;
}

export function publicPlans(country: Country) {
  return PLANS.map((p) => ({
    code: p.code,
    interval: p.interval,
    nameCode: p.nameCode,
    currency: p.prices[country].currency,
    amountMinor: p.prices[country].amountMinor,
    placeholder: true,
  }));
}
