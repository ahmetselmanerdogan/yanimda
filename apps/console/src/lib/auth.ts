import { type User, UserManager, WebStorageStateStore } from 'oidc-client-ts';

/**
 * T-020 konsol girişi: Keycloak `operations` realm'i, PKCE (S256) yetkilendirme kodu akışı, OTP Keycloak'ta zorunlu.
 * Oturum Keycloak'ta 12 saat; erişim token'ı 5 dk, yenileme token'ıyla sessiz yenilenir. Token yalnız oturum
 * deposunda (sessionStorage) tutulur: sekme kapanınca yeniden giriş.
 */
const authority = import.meta.env.VITE_OIDC_AUTHORITY || 'http://localhost:8080/realms/operations';

export const userManager = new UserManager({
  authority,
  client_id: import.meta.env.VITE_OIDC_CLIENT_ID || 'console',
  redirect_uri: `${window.location.origin}/`,
  post_logout_redirect_uri: `${window.location.origin}/`,
  response_type: 'code',
  scope: 'openid profile',
  automaticSilentRenew: true,
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
});

export const OPERATOR_ROLES = ['OPERATOR', 'SUPERVISOR', 'ADMIN'];
/** Yönetim paneli (/yonetim): amir ve yönetici. */
export const MANAGEMENT_ROLES = ['SUPERVISOR', 'ADMIN'];

/** Erişim token'ındaki realm rolleri (yalnız arayüz kararı; yetki API'de denetlenir). */
export function rolesOf(user: User): string[] {
  try {
    const claims = JSON.parse(atob(user.access_token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as {
      realm_access?: { roles?: string[] };
    };
    return claims.realm_access?.roles ?? [];
  } catch {
    return [];
  }
}

let restoring: Promise<User | null> | undefined;

/**
 * Dönüşte (?code=…) girişi tamamlar ve adresi temizler; değilse kayıtlı oturumu döner. Tek sefer çalışır: kod
 * yalnız bir kez değiştirilebilir (React StrictMode efekti iki kez çağırır).
 */
export function restoreSession(): Promise<User | null> {
  restoring ??= restore();
  return restoring;
}

async function restore(): Promise<User | null> {
  const params = new URLSearchParams(window.location.search);
  if (params.has('code') && params.has('state')) {
    const user = await userManager.signinRedirectCallback();
    params.delete('code');
    params.delete('state');
    params.delete('session_state');
    params.delete('iss');
    const q = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${q ? `?${q}` : ''}`);
    return user;
  }
  const user = await userManager.getUser();
  if (user && !user.expired) return user;
  if (user?.refresh_token) return renew();
  return null;
}

let renewing: Promise<User | null> | undefined;

/**
 * Tek uçuşlu yenileme: aynı anda birden çok çağrı (API, WS, açılış) tek yenileme isteği paylaşır. Keycloak aynı
 * yenileme token'ıyla eş zamanlı ikinci isteği 400 ile reddeder.
 */
export function renew(): Promise<User | null> {
  renewing ??= userManager
    .signinSilent()
    .catch(() => null)
    .finally(() => (renewing = undefined));
  return renewing;
}

export async function currentToken(): Promise<string | null> {
  const u = await userManager.getUser();
  if (u && !u.expired) return u.access_token;
  return (await renew())?.access_token ?? null;
}

/** Yenileme hatası tek başına çıkış nedeni değildir (eş zamanlı istek); token gerçekten geçersizse true. */
export async function sessionLost(): Promise<boolean> {
  const u = await userManager.getUser();
  if (u && !u.expired) return false;
  return !(await renew());
}
