/**
 * T-060 (C-01) abonelik yaşam döngüsü — saf fonksiyonlar, tablo testiyle sabitlenir.
 *
 * Durumlar (profile.subscription.status, 0009): TRIAL · ACTIVE · PAST_DUE · CANCELED.
 *  - Deneme (TRIAL): kayıtta başlar; ilk (test olmayan) olay veya 30 gün, hangisi önceyse biter.
 *    Deneme bitince ödeme yoksa → PAST_DUE ("ödeme bekliyor").
 *  - Ödeme bekliyor (PAST_DUE): 7 gün koruma sürer (grace_until). Girişte aileye F-SUB-PAY (bir kez).
 *    Süre dolunca askıda (SUSPENDED, türetilmiş): cihaz config'te koruma kapalı, aileye F-SUB-SUSPENDED (bir kez).
 *  - Ödeme alındı (checkout / yenileme) → ACTIVE; bekleme ve askı temizlenir.
 *  - İptal (tek tık veya sağlayıcı) → CANCELED: son durum, koruma kapanır. Hiçbir webhook geri açmaz.
 * Sağlayıcı olayları sıra dışı gelebilir: son işlenen olaydan eski bir olay durumu değiştirmez (yalnız
 * sağlayıcı referanslarını bağlar).
 */
export const TRIAL_DAYS = 30;
export const GRACE_DAYS = 7;
const DAY = 86_400_000;

export type SubscriptionStatus = 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED';
/** Cihaza ve aileye gösterilen (türetilmiş) durum. */
export type EffectiveStatus = 'TRIAL' | 'ACTIVE' | 'PAYMENT_PENDING' | 'SUSPENDED' | 'CANCELED';

export interface SubscriptionFacts {
  status: SubscriptionStatus;
  startedAt: Date;
  trialEndsAt: Date | null;
  pastDueSince: Date | null;
  graceUntil: Date | null;
  suspendedAt: Date | null;
  renewsAt: Date | null;
  lastProviderEventAt: Date | null;
}

/** Sağlayıcıdan bağımsız ödeme olayı (providers/* webhook'u buna çevirir). */
export type PaymentEventType =
  'CHECKOUT_COMPLETED' | 'PAYMENT_SUCCEEDED' | 'PAYMENT_FAILED' | 'SUBSCRIPTION_CANCELED' | 'IGNORED';

export interface PaymentEvent {
  provider: 'IYZICO' | 'STRIPE' | 'FAKE';
  /** Sağlayıcının olay kimliği (tekrar ayıklama anahtarı). */
  eventId: string;
  type: PaymentEventType;
  occurredAt: Date;
  /** Bizim abonelik kimliğimiz (checkout'a metadata olarak verildiyse). */
  subscriptionId?: string;
  providerSubscriptionRef?: string;
  providerCustomerRef?: string;
  checkoutRef?: string;
  /** Ödenen dönemin sonu (yenileme tarihi). */
  periodEnd?: Date;
  /** Sağlayıcının ham olay türü (kayıt için; PII yok). */
  rawType: string;
}

export type Patch = Partial<
  Omit<SubscriptionFacts, 'startedAt'> & {
    canceledAt: Date | null;
    providerSubscriptionRef: string;
    providerCustomerRef: string;
  }
>;

export interface Transition {
  patch: Patch;
  /** Aileye gidecek katalog kodu (F-SUB-PAY / F-SUB-SUSPENDED); dedupe anahtarı ile. */
  notify?: { code: string; dedupeKey: string };
  /** Kayıt için: applied | stale | terminal | ignored. */
  outcome: 'applied' | 'stale' | 'terminal' | 'ignored';
}

export const trialEndOf = (f: Pick<SubscriptionFacts, 'trialEndsAt' | 'startedAt'>): Date =>
  f.trialEndsAt ?? new Date(f.startedAt.getTime() + TRIAL_DAYS * DAY);

/** Geçerli durum ve korumanın açık olup olmadığı (cihaz config, aile ekranı). */
export function effective(
  f: SubscriptionFacts | null,
  now: Date,
): { status: EffectiveStatus | null; protectionActive: boolean; until: Date | null } {
  if (!f) return { status: null, protectionActive: true, until: null }; // abonelik dışı (kurumsal / yönetici) kişi
  switch (f.status) {
    case 'ACTIVE':
      return { status: 'ACTIVE', protectionActive: true, until: f.renewsAt };
    case 'CANCELED':
      return { status: 'CANCELED', protectionActive: false, until: null };
    case 'TRIAL': {
      const end = trialEndOf(f);
      if (now < end) return { status: 'TRIAL', protectionActive: true, until: end };
      // Tarama henüz PAST_DUE'ya çevirmediyse de aynı kural: deneme sonu + 7 gün.
      const grace = new Date(end.getTime() + GRACE_DAYS * DAY);
      return now < grace
        ? { status: 'PAYMENT_PENDING', protectionActive: true, until: grace }
        : { status: 'SUSPENDED', protectionActive: false, until: null };
    }
    case 'PAST_DUE': {
      const grace = f.graceUntil ?? new Date((f.pastDueSince ?? now).getTime() + GRACE_DAYS * DAY);
      return now < grace
        ? { status: 'PAYMENT_PENDING', protectionActive: true, until: grace }
        : { status: 'SUSPENDED', protectionActive: false, until: null };
    }
  }
}

const pastDue = (subscriptionId: string, at: Date): Transition => ({
  patch: {
    status: 'PAST_DUE',
    pastDueSince: at,
    graceUntil: new Date(at.getTime() + GRACE_DAYS * DAY),
    suspendedAt: null,
  },
  notify: { code: 'F-SUB-PAY', dedupeKey: `subscription:${subscriptionId}:past-due:${at.getTime()}` },
  outcome: 'applied',
});

/** Sağlayıcı olayının durum etkisi. */
export function onPaymentEvent(subscriptionId: string, f: SubscriptionFacts, ev: PaymentEvent): Transition {
  const refs: Patch = {
    ...(ev.providerSubscriptionRef ? { providerSubscriptionRef: ev.providerSubscriptionRef } : {}),
    ...(ev.providerCustomerRef ? { providerCustomerRef: ev.providerCustomerRef } : {}),
  };
  if (ev.type === 'IGNORED') return { patch: refs, outcome: 'ignored' };
  if (f.status === 'CANCELED') return { patch: {}, outcome: 'terminal' };
  if (f.lastProviderEventAt && ev.occurredAt < f.lastProviderEventAt) return { patch: refs, outcome: 'stale' };
  const seen = { lastProviderEventAt: ev.occurredAt };
  switch (ev.type) {
    case 'CHECKOUT_COMPLETED':
    case 'PAYMENT_SUCCEEDED':
      return {
        patch: {
          ...refs,
          ...seen,
          status: 'ACTIVE',
          pastDueSince: null,
          graceUntil: null,
          suspendedAt: null,
          ...(ev.periodEnd ? { renewsAt: ev.periodEnd } : {}),
        },
        outcome: 'applied',
      };
    case 'PAYMENT_FAILED':
      // Zaten bekliyorsa süre uzamaz, bildirim tekrarlanmaz.
      if (f.status === 'PAST_DUE') return { patch: { ...refs, ...seen }, outcome: 'applied' };
      {
        const t = pastDue(subscriptionId, ev.occurredAt);
        return { ...t, patch: { ...refs, ...seen, ...t.patch } };
      }
    case 'SUBSCRIPTION_CANCELED':
      return { patch: { ...refs, ...seen, status: 'CANCELED', canceledAt: ev.occurredAt }, outcome: 'applied' };
  }
}

/** İlk (test olmayan) olay denemeyi bitirir. */
export function onFirstEvent(f: SubscriptionFacts, at: Date): Patch | null {
  if (f.status !== 'TRIAL' || trialEndOf(f) <= at) return null;
  return { trialEndsAt: at };
}

/** Zaman taraması: deneme bitti → PAST_DUE; bekleme bitti → askıda (bir kez bildir). */
export function onSweep(subscriptionId: string, f: SubscriptionFacts, now: Date): Transition | null {
  if (f.status === 'TRIAL') {
    const end = trialEndOf(f);
    return end <= now ? pastDue(subscriptionId, end) : null;
  }
  if (f.status === 'PAST_DUE' && !f.suspendedAt) {
    const e = effective(f, now);
    if (e.status !== 'SUSPENDED') return null;
    return {
      patch: { suspendedAt: now },
      notify: {
        code: 'F-SUB-SUSPENDED',
        dedupeKey: `subscription:${subscriptionId}:suspended:${(f.pastDueSince ?? now).getTime()}`,
      },
      outcome: 'applied',
    };
  }
  return null;
}
