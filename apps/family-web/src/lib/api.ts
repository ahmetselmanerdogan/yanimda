import type { Country, SubscriptionView } from './flow';

/** API çağrıları (aynı kök: next.config rewrite `/v1/*`). Hata → ApiError(status). Gövdede kişisel veri log'lanmaz. */
export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const r = await fetch(`/v1${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw new ApiError(r.status);
  return (await r.json()) as T;
}

export interface Plan {
  code: string;
  interval: 'month' | 'year';
  nameCode: string;
  currency: string;
  amountMinor: number;
  placeholder: boolean;
}
export interface PlansResponse {
  country: Country;
  trialDays: number;
  kvkkNoticeVersion: string;
  plans: Plan[];
}
export interface SignupResponse {
  subscriptionId: string;
  protectedPersonId: string;
  signupToken: string;
  signupTokenExpiresAt: string;
  trialEndsAt: string;
  phoneVerification: 'SENT' | 'UNAVAILABLE';
  devCode?: string;
}
export type CheckoutSession =
  { kind: 'redirect'; url: string; checkoutRef: string } | { kind: 'embed'; html: string; checkoutRef: string };

const tok = (token: string) => ({ 'x-signup-token': token });
const bearer = (accessToken: string) => ({ authorization: `Bearer ${accessToken}` });

export const api = {
  plans: (country: Country) => call<PlansResponse>('GET', `/plans?country=${country}`),
  signup: (body: unknown) => call<SignupResponse>('POST', '/signup', body),
  resendCode: (id: string, token: string) =>
    call<{ phoneVerification: 'SENT'; devCode?: string }>('POST', `/signup/${id}/phone/code`, {}, tok(token)),
  verifyPhone: (id: string, token: string, code: string) =>
    call<{ phoneVerified: true }>('POST', `/signup/${id}/phone/verify`, { code }, tok(token)),
  checkout: (id: string, token: string, billing?: { city: string; address: string }) =>
    call<CheckoutSession>('POST', `/signup/${id}/checkout`, billing ? { billing } : {}, tok(token)),
  signupStatus: (id: string, token: string) =>
    call<SubscriptionView>('GET', `/signup/${id}/subscription`, undefined, tok(token)),
  fakePay: (ref: string, outcome: 'success' | 'fail') =>
    call<{ redirect: string }>('POST', `/payments/fake/${encodeURIComponent(ref)}/pay`, { outcome }),
  persons: (at: string) =>
    call<{ items: { id: string; displayName: string; myRole: string | null }[] }>(
      'GET',
      '/protected-persons',
      undefined,
      bearer(at),
    ),
  subscription: (at: string, personId: string) =>
    call<SubscriptionView>('GET', `/protected-persons/${personId}/subscription`, undefined, bearer(at)),
  cancel: (at: string, personId: string) =>
    call<SubscriptionView>('POST', `/protected-persons/${personId}/subscription/cancel`, {}, bearer(at)),
  checkoutForPerson: (at: string, personId: string, billing?: { city: string; address: string }) =>
    call<CheckoutSession>(
      'POST',
      `/protected-persons/${personId}/subscription/checkout`,
      billing ? { billing } : {},
      bearer(at),
    ),
};
