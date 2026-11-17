#!/usr/bin/env node
/**
 * CI / geliştirme: tarayıcısız operatör erişim token'ı (T-081 DAST kimlikli ZAP taraması). Konsolun gerçek akışı:
 * `console` genel istemcisi, PKCE (S256) yetkilendirme kodu, kullanıcı adı/parola + TOTP (operations realm OTP ister;
 * token'da amr=otp). Kullanıcılar ve sırlar infra/keycloak/dev-users.mjs ile aynı (KEYCLOAK_DEV_PASSWORD,
 * KEYCLOAK_DEV_OTP_SECRET; iş başına rastgele, depoda yok). Üretimde KULLANILMAZ.
 *
 *   KEYCLOAK_DEV_PASSWORD=… KEYCLOAK_DEV_OTP_SECRET=… node infra/keycloak/operator-token.mjs [kullanıcı]
 *
 * Yalnız erişim token'ı stdout'a yazılır (log'a değil; çağıran maskeler). TOKEN_LIFESPAN_SEC verilirse önce
 * `console` istemcisinin erişim token ömrü yönetici API'siyle o değere çekilir — yalnız CI'ın geçici Keycloak'ı
 * için (ZAP taraması 5 dk'dan uzun sürer).
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Keycloak TOTP (HmacSHA1, 6 hane, 30 sn); sır Keycloak'ın sakladığı düz metin (apps/console/e2e/support.ts). */
export function totp(secret, at = Date.now()) {
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', Buffer.from(secret)).update(c).digest();
  const o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Keycloak giriş/OTP sayfasındaki form adresi (HTML varlıkları çözülür). */
export function formAction(html) {
  const m = /<form\b[^>]*\baction="([^"]+)"/i.exec(html);
  if (!m) return undefined;
  return m[1]
    .replace(/&amp;/g, '&')
    .replace(/&#x3d;|&#61;/gi, '=')
    .replace(/&#x2f;|&#47;/gi, '/');
}

const b64url = (buf) => buf.toString('base64url');

export function pkce() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

/** Basit çerez kavanozu: Keycloak oturum çerezleri (AUTH_SESSION_ID, KC_RESTART …) aynı akış içinde geri gönderilir. */
function jar() {
  const cookies = new Map();
  return {
    take(res) {
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1));
      }
    },
    header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
  };
}

async function setLifespan(kc, seconds) {
  const t = await fetch(`${kc}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: process.env.KEYCLOAK_ADMIN_USER ?? 'admin',
      password: process.env.KEYCLOAK_ADMIN_PASSWORD ?? 'admin',
    }),
  });
  if (!t.ok) throw new Error(`Keycloak yönetici girişi: HTTP ${t.status}`);
  const auth = { authorization: `Bearer ${(await t.json()).access_token}` };
  const base = `${kc}/admin/realms/operations/clients`;
  const [client] = await (await fetch(`${base}?clientId=console`, { headers: auth })).json();
  if (!client) throw new Error('operations realm: console istemcisi yok');
  client.attributes = { ...client.attributes, 'access.token.lifespan': String(seconds) };
  const r = await fetch(`${base}/${client.id}`, {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(client),
  });
  if (!r.ok) throw new Error(`console istemcisi güncellenemedi: HTTP ${r.status}`);
}

export async function operatorToken({
  kc = (process.env.KEYCLOAK_URL ?? 'http://localhost:8080').replace(/\/+$/, ''),
  username = 'operator1',
  password = process.env.KEYCLOAK_DEV_PASSWORD,
  otpSecret = process.env.KEYCLOAK_DEV_OTP_SECRET,
  redirectUri = process.env.CONSOLE_REDIRECT_URI ?? 'http://localhost:5173/',
} = {}) {
  if (!password || !otpSecret) throw new Error('KEYCLOAK_DEV_PASSWORD ve KEYCLOAK_DEV_OTP_SECRET gerekli');
  const oidc = `${kc}/realms/operations/protocol/openid-connect`;
  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(12));
  const cookies = jar();
  const go = async (url, form) => {
    const res = await fetch(url, {
      method: form ? 'POST' : 'GET',
      redirect: 'manual',
      headers: { cookie: cookies.header(), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form) : undefined,
    });
    cookies.take(res);
    return res;
  };

  const auth = new URL(`${oidc}/auth`);
  for (const [k, v] of Object.entries({
    client_id: 'console',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }))
    auth.searchParams.set(k, v);
  let res = await go(auth.toString());
  let action = formAction(await res.text());
  if (!action) throw new Error(`giriş formu yok (HTTP ${res.status})`);
  res = await go(action, { username, password, credentialId: '' });
  let location = res.headers.get('location');
  // OTP sayfası; aynı kod iki kez kabul edilmez → reddedilirse sonraki pencerenin koduyla bir kez daha.
  for (let attempt = 0; !location && attempt < 2; attempt++) {
    action = formAction(await res.text());
    if (!action) throw new Error(`OTP formu yok (HTTP ${res.status}; parola reddedildi mi?)`);
    if (attempt || Date.now() % 30_000 > 27_000)
      await new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 300));
    res = await go(action, { otp: totp(otpSecret) });
    location = res.headers.get('location');
  }
  if (!location) throw new Error(`OTP sonrası yönlendirme yok (HTTP ${res.status})`);
  const back = new URL(location, kc);
  if (back.searchParams.get('state') !== state) throw new Error('state uyuşmuyor');
  const code = back.searchParams.get('code');
  if (!code) throw new Error(`yetkilendirme kodu yok: ${back.searchParams.get('error') ?? 'bilinmiyor'}`);

  const t = await fetch(`${oidc}/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: 'console',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!t.ok) throw new Error(`token değişimi: HTTP ${t.status}`);
  return (await t.json()).access_token;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const kc = (process.env.KEYCLOAK_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
  const lifespan = Number(process.env.TOKEN_LIFESPAN_SEC || 0);
  (lifespan > 0 ? setLifespan(kc, lifespan) : Promise.resolve())
    .then(() => operatorToken({ kc, username: process.argv[2] || 'operator1' }))
    .then((token) => process.stdout.write(`${token}\n`))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
