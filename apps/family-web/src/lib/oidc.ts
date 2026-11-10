/**
 * "Aboneliğim" girişi: Keycloak consumers realm, genel istemci `family-web`, Authorization Code + PKCE (S256).
 * Token yalnız sessionStorage'da (sekme kapanınca gider); yenileme yok — 5 dk sonra yeniden giriş.
 */
const ISSUER = (process.env.NEXT_PUBLIC_OIDC_ISSUER ?? 'http://localhost:8080/realms/consumers').replace(/\/+$/, '');
const CLIENT_ID = process.env.NEXT_PUBLIC_OIDC_CLIENT_ID ?? 'family-web';
const KEY = 'yanimda.oidc';

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf instanceof Uint8Array ? buf : new Uint8Array(buf))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const redirectUri = () => `${window.location.origin}/hesap/callback`;

export async function login(): Promise<void> {
  const verifier = random(48);
  const state = random(16);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  sessionStorage.setItem(`${KEY}.pkce`, JSON.stringify({ verifier, state }));
  const q = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    scope: 'openid',
    redirect_uri: redirectUri(),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    ui_locales: 'tr',
  });
  window.location.assign(`${ISSUER}/protocol/openid-connect/auth?${q}`);
}

/** Callback: kod → token. Başarılıysa true. */
export async function completeLogin(search: URLSearchParams): Promise<boolean> {
  const saved = sessionStorage.getItem(`${KEY}.pkce`);
  sessionStorage.removeItem(`${KEY}.pkce`);
  const code = search.get('code');
  if (!saved || !code) return false;
  const { verifier, state } = JSON.parse(saved) as { verifier: string; state: string };
  if (search.get('state') !== state) return false;
  const r = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    }),
  });
  if (!r.ok) return false;
  const j = (await r.json()) as { access_token: string; expires_in: number; id_token?: string };
  sessionStorage.setItem(
    KEY,
    JSON.stringify({ at: j.access_token, idt: j.id_token ?? null, until: Date.now() + (j.expires_in - 15) * 1000 }),
  );
  return true;
}

export function accessToken(): string | null {
  try {
    const s = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as { at: string; until: number } | null;
    return s && s.until > Date.now() ? s.at : null;
  } catch {
    return null;
  }
}

export function logout() {
  let idt: string | null = null;
  try {
    idt = (JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as { idt: string | null } | null)?.idt ?? null;
  } catch {
    /* yok say */
  }
  sessionStorage.removeItem(KEY);
  const q = new URLSearchParams({ client_id: CLIENT_ID, post_logout_redirect_uri: `${window.location.origin}/hesap` });
  if (idt) q.set('id_token_hint', idt);
  window.location.assign(`${ISSUER}/protocol/openid-connect/logout?${q}`);
}
