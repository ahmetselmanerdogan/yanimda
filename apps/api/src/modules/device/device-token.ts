import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { Logger } from '@nestjs/common';

/**
 * T-041 cihaz token'ı: HS256 JWT, 1 yıl. Claim'ler: sub = deviceId, pp = protectedPersonId, kind, typ = 'device'.
 * İmza ve süre burada; iptal (revoked_at) ve kişi eşleşmesi EnrollmentService.authenticate'te veritabanından.
 * Bağımlılık eklememek için node:crypto ile yazıldı; yalnız HS256 kabul edilir (alg: none / RS256 reddedilir).
 */
export interface DeviceClaims {
  sub: string;
  pp: string;
  kind: string;
  typ: 'device';
  iat: number;
  exp: number;
}

export const DEVICE_TOKEN_TTL_SEC = 365 * 24 * 3600;
/** İstemci bu süreden az kaldığında yeniler (POST /devices/{id}/token). */
export const DEVICE_TOKEN_REFRESH_BEFORE_SEC = 30 * 24 * 3600;

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const HEADER = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

let devSecret: string | undefined;

/** DEVICE_TOKEN_SECRET (en az 32 karakter). Üretimde zorunlu; geliştirmede yoksa süreç başına rastgele (uyarıyla). */
export function deviceTokenSecret(env: NodeJS.ProcessEnv = process.env): string {
  const s = env.DEVICE_TOKEN_SECRET;
  if (s && s.length >= 32) return s;
  if (env.NODE_ENV === 'production') throw new Error('DEVICE_TOKEN_SECRET tanımlı değil veya 32 karakterden kısa');
  if (!devSecret) {
    devSecret = randomBytes(32).toString('hex');
    new Logger('DeviceToken').warn(
      'DEVICE_TOKEN_SECRET yok: süreç başına rastgele anahtar. API yeniden başlarsa cihazlar yeniden eşleşmeli.',
    );
  }
  return devSecret;
}

export function signDeviceToken(
  c: Omit<DeviceClaims, 'typ' | 'iat' | 'exp'>,
  secret: string,
  now = new Date(),
  ttlSec = DEVICE_TOKEN_TTL_SEC,
): { token: string; claims: DeviceClaims } {
  const iat = Math.floor(now.getTime() / 1000);
  const claims: DeviceClaims = { sub: c.sub, pp: c.pp, kind: c.kind, typ: 'device', iat, exp: iat + ttlSec };
  const body = `${HEADER}.${b64(JSON.stringify(claims))}`;
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return { token: `${body}.${sig}`, claims };
}

/** İmza, başlık ve süre geçerliyse claim'ler; değilse null (nedeni dışarı sızdırılmaz). */
export function verifyDeviceToken(token: string, secret: string, now = new Date()): DeviceClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  if (h !== HEADER) return null;
  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const given = Buffer.from(s, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let c: Partial<DeviceClaims>;
  try {
    c = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Partial<DeviceClaims>;
  } catch {
    return null;
  }
  if (c.typ !== 'device' || typeof c.sub !== 'string' || typeof c.pp !== 'string' || typeof c.exp !== 'number')
    return null;
  if (c.exp <= Math.floor(now.getTime() / 1000)) return null;
  return c as DeviceClaims;
}
