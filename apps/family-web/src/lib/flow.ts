/**
 * T-060 kayıt akışının saf yardımcıları (birim testli): telefon normalleştirme, alan doğrulama, fiyat biçimi,
 * API hatası → katalog kodu, abonelik durumu → katalog kodu.
 */
export type Country = 'TR' | 'US';

export interface AccountForm {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  elderName: string;
  kvkkRead: boolean;
  explicitConsent: boolean;
}

export type FieldErrors = Partial<Record<keyof AccountForm, string>>;

const E164 = /^\+[1-9]\d{6,14}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

/** "0532 111 22 33" / "5321112233" (TR), "(415) 555-0100" (US) → E.164. Tanınmazsa olduğu gibi (boşluksuz). */
export function normalizePhone(input: string, country: Country): string {
  const raw = input.replace(/[\s()\-.]/g, '');
  if (raw.startsWith('+')) return raw;
  if (raw.startsWith('00')) return `+${raw.slice(2)}`;
  if (country === 'TR') {
    if (/^0\d{10}$/.test(raw)) return `+90${raw.slice(1)}`;
    if (/^5\d{9}$/.test(raw)) return `+90${raw}`;
  }
  if (country === 'US') {
    if (/^\d{10}$/.test(raw)) return `+1${raw}`;
    if (/^1\d{10}$/.test(raw)) return `+${raw}`;
  }
  return raw;
}

export function validateAccount(f: AccountForm, country: Country): FieldErrors {
  const e: FieldErrors = {};
  const req = (k: keyof AccountForm, max: number) => {
    const v = String(f[k]).trim();
    if (!v) e[k] = 'F-WEB-REQUIRED';
    else if (v.length > max) e[k] = 'F-WEB-ERROR-INVALID';
  };
  req('firstName', 60);
  req('lastName', 60);
  req('elderName', 100);
  if (!f.email.trim()) e.email = 'F-WEB-REQUIRED';
  else if (!EMAIL.test(f.email.trim())) e.email = 'F-WEB-ERROR-INVALID';
  if (!f.phone.trim()) e.phone = 'F-WEB-REQUIRED';
  else if (!E164.test(normalizePhone(f.phone, country))) e.phone = 'F-WEB-ERROR-INVALID';
  if (!f.kvkkRead) e.kvkkRead = 'F-WEB-REQUIRED';
  if (!f.explicitConsent) e.explicitConsent = 'F-WEB-REQUIRED';
  return e;
}

export function formatPrice(amountMinor: number, currency: string, locale = 'tr-TR'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 2 }).format(
    amountMinor / 100,
  );
}

export function formatDate(iso: string | null | undefined, locale = 'tr-TR'): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
}

/** Sağlayıcı/API hatası → kullanıcıya gösterilecek katalog kodu. `step`: hangi çağrıda. */
export function errorCode(status: number, step: 'signup' | 'verify' | 'checkout' | 'cancel' | 'other'): string {
  if (status === 429) return 'F-WEB-ERROR-TOO-MANY';
  if (step === 'signup' && status === 409) return 'F-WEB-ERROR-EMAIL-TAKEN';
  if (step === 'signup' && status === 400) return 'F-WEB-ERROR-INVALID';
  if (step === 'verify' && (status === 400 || status === 410)) return 'F-WEB-ERROR-CODE';
  if (step === 'checkout' && status === 502) return 'F-WEB-PAY-FAILED';
  return 'F-WEB-ERROR';
}

export type EffectiveStatus = 'TRIAL' | 'ACTIVE' | 'PAYMENT_PENDING' | 'SUSPENDED' | 'CANCELED' | null;

export interface SubscriptionView {
  id: string;
  protectedPersonId: string;
  plan: string;
  countryCode: Country;
  status: 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED';
  effectiveStatus: EffectiveStatus;
  protectionActive: boolean;
  until: string | null;
  trialEndsAt: string | null;
  canceledAt: string | null;
  provider: 'IYZICO' | 'STRIPE' | 'FAKE' | null;
  paymentMethodOnFile: boolean;
}

/** Durum satırı: katalog kodu + değişkenler. */
export function statusLine(v: Pick<SubscriptionView, 'effectiveStatus' | 'until'>): {
  code: string;
  vars: Record<string, string>;
} {
  const s = v.effectiveStatus ?? 'ACTIVE';
  return { code: `F-WEB-STATUS-${s}`, vars: { date: formatDate(v.until) } };
}

/** "Ödemeyi tamamla" düğmesi gösterilsin mi. */
export const needsPayment = (v: Pick<SubscriptionView, 'status'>) => v.status === 'TRIAL' || v.status === 'PAST_DUE';
/** Tek tık iptal gösterilsin mi. */
export const cancellable = (v: Pick<SubscriptionView, 'status'>) => v.status !== 'CANCELED';
