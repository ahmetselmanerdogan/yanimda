import { ApiError } from './api';
import { errorCode } from './flow';

/**
 * "Aboneliğim" (Account.tsx) işlemlerinin saf yardımcıları (birim testli): hata → katalog kodu / yeniden giriş ve
 * kişi kartı başına fatura bilgisi.
 */

/**
 * İşlem hatası → katalog kodu. 401: erişim token'ı düştü (5 dk, yenileme yok) → yeniden giriş, genel hata değil
 * (load / exportData ile aynı). Ağ ve ayrıştırma hataları genel hata.
 */
export function accountError(
  e: unknown,
  step: 'cancel' | 'checkout' | 'other',
): { code: string; relogin: false } | { code: null; relogin: true } {
  if (e instanceof ApiError && e.status === 401) return { code: null, relogin: true };
  return { code: e instanceof ApiError ? errorCode(e.status, step) : 'F-WEB-ERROR', relogin: false };
}

export interface Billing {
  city: string;
  address: string;
}
export const EMPTY_BILLING: Billing = { city: '', address: '' };

/**
 * Ödemeye giden fatura bilgisi: Türkiye'de il ve adres zorunlu, kırpılmış gönderilir (eksikse `invalid`);
 * diğer ülkelerde gönderilmez.
 */
export function billingPayload(
  b: Billing | undefined,
  country: string,
): { invalid: true } | { invalid: false; billing: Billing | undefined } {
  if (country !== 'TR') return { invalid: false, billing: undefined };
  const city = b?.city.trim() ?? '';
  const address = b?.address.trim() ?? '';
  return city && address ? { invalid: false, billing: { city, address } } : { invalid: true };
}
