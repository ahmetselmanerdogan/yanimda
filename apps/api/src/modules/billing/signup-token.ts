import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Kayıt akışı token'ı (giriş yapmadan önceki adımlar: telefon doğrulama, ödeme). `<abonelikId>.<bitiş>.<imza>`,
 * HMAC-SHA256. Yalnız o aboneliğe ve kısa süreye bağlı; giriş sonrası işlemler (iptal, sonradan ödeme) OIDC ile.
 */
export const SIGNUP_TOKEN_TTL_SEC = 2 * 3600;

let devSecret: string | undefined;
export function signupSecret(env: NodeJS.ProcessEnv = process.env): string {
  const s = env.SIGNUP_TOKEN_SECRET;
  if (s && s.length >= 32) return s;
  if (env.NODE_ENV === 'production') throw new Error('SIGNUP_TOKEN_SECRET gerekli (en az 32 karakter)');
  return (devSecret ??= randomBytes(32).toString('hex'));
}

const sign = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('base64url');

export function issueSignupToken(secret: string, subscriptionId: string, now = new Date()) {
  const exp = Math.floor(now.getTime() / 1000) + SIGNUP_TOKEN_TTL_SEC;
  const data = `${subscriptionId}.${exp}`;
  return { token: `${data}.${sign(secret, data)}`, expiresAt: new Date(exp * 1000).toISOString() };
}

/** Geçerliyse abonelik kimliği, değilse null. */
export function verifySignupToken(secret: string, token: unknown, now = new Date()): string | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [id, exp, mac] = parts as [string, string, string];
  const want = Buffer.from(sign(secret, `${id}.${exp}`));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  if (!(Number(exp) * 1000 > now.getTime())) return null;
  return id;
}
