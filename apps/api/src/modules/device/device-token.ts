import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { Logger } from '@nestjs/common';

/**
 * T-041 cihaz token'ı: HS256 JWT, 1 yıl. Claim'ler: sub = deviceId, pp = protectedPersonId, kind, typ = 'device'.
 * İmza ve süre burada; iptal (revoked_at) ve kişi eşleşmesi EnrollmentService.authenticate'te veritabanından.
 * Bağımlılık eklememek için node:crypto ile yazıldı; yalnız HS256 kabul edilir (alg: none / RS256 reddedilir).
 * Anahtar döndürme (T-081 G-7): başlıkta `kid` (`DEVICE_TOKEN_SECRETS`); `kid`'siz eski token'lar `DEVICE_TOKEN_SECRET`
 * ile doğrulanır.
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
/** Başlık birebir bu biçimlerden biri olmalı (alan sırası sabit): `kid`'siz (eski tek anahtar) veya `kid`'li. */
const header = (kid?: string) =>
  b64(JSON.stringify(kid ? { alg: 'HS256', typ: 'JWT', kid } : { alg: 'HS256', typ: 'JWT' }));
const HEADER = header();
const KID = /^[A-Za-z0-9_-]{1,32}$/;
const MIN_SECRET = 32;

/**
 * T-081 (G-7; ASVS 1.6.3) çoklu anahtar. `DEVICE_TOKEN_SECRETS="<kid>:<sır>[,<kid>:<sır>]"`: ilki imzalar (başlıkta
 * `kid`), hepsi doğrular. Eski tek anahtar `DEVICE_TOKEN_SECRET` `kid`'siz token'ları doğrular; `DEVICE_TOKEN_SECRETS`
 * yoksa imzalar da (geriye uyumlu: başlık değişmez). Her sır en az 32 karakter.
 */
export interface DeviceTokenKeyring {
  /** Yeni token'ları imzalayan anahtar (`kid` yoksa eski biçim). */
  signer: { kid?: string; secret: string };
  /** `kid`'li token'lar için doğrulama anahtarları. */
  keys: ReadonlyMap<string, string>;
  /** `kid`'siz (eski) token'ları doğrulayan anahtar. */
  legacy?: string;
}

/** Tek sırdan (eski biçim; testler) anahtarlık. */
export const legacyKeyring = (secret: string): DeviceTokenKeyring => ({
  signer: { secret },
  keys: new Map(),
  legacy: secret,
});

/** `DEVICE_TOKEN_SECRETS` çözümleyici. Biçim bozuksa hata (sırrın değeri mesajda yok). */
export function parseDeviceTokenSecrets(spec: string): Map<string, string> {
  const keys = new Map<string, string>();
  for (const part of spec
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)) {
    const i = part.indexOf(':');
    const kid = part.slice(0, i);
    const secret = part.slice(i + 1);
    if (i < 1 || !KID.test(kid) || secret.length < MIN_SECRET || keys.has(kid))
      throw new Error('DEVICE_TOKEN_SECRETS biçimi: <kid>:<en az 32 karakter sır>[,…]; kid [A-Za-z0-9_-], tekil');
    keys.set(kid, secret);
  }
  if (!keys.size) throw new Error('DEVICE_TOKEN_SECRETS boş');
  return keys;
}

let devSecret: string | undefined;
function devRandom(): string {
  if (!devSecret) {
    devSecret = randomBytes(32).toString('hex');
    new Logger('DeviceToken').warn(
      'DEVICE_TOKEN_SECRET(S) yok: süreç başına rastgele anahtar. API yeniden başlarsa cihazlar yeniden eşleşmeli.',
    );
  }
  return devSecret;
}

/**
 * Ayrılmış `kid`: `legacy:<sır>` girdisi `kid`'siz (eski biçim) token'ları imzalar/doğrular; başlıkta `kid: legacy`
 * olan token kabul edilmez. İlk geçişin Faz 1'i için (`legacy:<eski>,k2027a:<yeni>`: imzalayan değişmeden yeni
 * anahtar tüm örneklere dağıtılır; sirlar.md §4.2).
 */
export const LEGACY_KID = 'legacy';

/**
 * Ortamdan anahtarlık. Üretimde `DEVICE_TOKEN_SECRETS` veya `DEVICE_TOKEN_SECRET` (≥ 32) zorunlu; ikisi birlikte
 * olabilir: `DEVICE_TOKEN_SECRET` listede `legacy` yoksa sona eklenmiş `legacy` girdisi sayılır (eski `kid`'siz
 * token'lar süreleri dolana kadar doğrulanır). Biçim bozuksa her ortamda hata. Geliştirmede ikisi de yoksa süreç
 * başına rastgele (uyarıyla).
 */
export function deviceTokenKeyring(env: NodeJS.ProcessEnv = process.env): DeviceTokenKeyring {
  const prod = env.NODE_ENV === 'production';
  const single = env.DEVICE_TOKEN_SECRET;
  if (single && single.length < MIN_SECRET && prod) throw new Error('DEVICE_TOKEN_SECRET 32 karakterden kısa');
  const legacy = single && single.length >= MIN_SECRET ? single : undefined;
  if (env.DEVICE_TOKEN_SECRETS?.trim()) {
    const all = parseDeviceTokenSecrets(env.DEVICE_TOKEN_SECRETS);
    const listed = all.get(LEGACY_KID);
    if (listed && legacy && listed !== legacy)
      throw new Error('DEVICE_TOKEN_SECRET ile DEVICE_TOKEN_SECRETS içindeki legacy anahtarı farklı');
    const [kid, secret] = all.entries().next().value!;
    const keys = new Map([...all].filter(([k]) => k !== LEGACY_KID));
    return { signer: { kid: kid === LEGACY_KID ? undefined : kid, secret }, keys, legacy: listed ?? legacy };
  }
  if (legacy) return legacyKeyring(legacy);
  if (prod) throw new Error('DEVICE_TOKEN_SECRETS veya DEVICE_TOKEN_SECRET (en az 32 karakter) üretimde zorunlu');
  return legacyKeyring(devRandom());
}

/**
 * Tek sabit sır (BLE adres özeti yedeği, `bridged.service.ts`): `DEVICE_TOKEN_SECRET` (≥ 32). Rotasyonla değişen
 * `DEVICE_TOKEN_SECRETS` buraya karışmaz (özet değişirse köprülü cihazlar kimlik kaybeder); yalnız o tanımlıysa
 * üretimde `BLE_ADDRESS_PEPPER` gerekir. Geliştirmede süreç başına rastgele.
 */
export function deviceTokenSecret(env: NodeJS.ProcessEnv = process.env): string {
  const s = env.DEVICE_TOKEN_SECRET;
  if (s && s.length >= MIN_SECRET) return s;
  if (env.NODE_ENV === 'production')
    throw new Error('DEVICE_TOKEN_SECRET (en az 32 karakter) veya BLE_ADDRESS_PEPPER üretimde zorunlu');
  return devRandom();
}

const asKeyring = (k: string | DeviceTokenKeyring) => (typeof k === 'string' ? legacyKeyring(k) : k);

export function signDeviceToken(
  c: Omit<DeviceClaims, 'typ' | 'iat' | 'exp'>,
  key: string | DeviceTokenKeyring,
  now = new Date(),
  ttlSec = DEVICE_TOKEN_TTL_SEC,
): { token: string; claims: DeviceClaims } {
  const { signer } = asKeyring(key);
  const iat = Math.floor(now.getTime() / 1000);
  const claims: DeviceClaims = { sub: c.sub, pp: c.pp, kind: c.kind, typ: 'device', iat, exp: iat + ttlSec };
  const body = `${header(signer.kid)}.${b64(JSON.stringify(claims))}`;
  const sig = createHmac('sha256', signer.secret).update(body).digest('base64url');
  return { token: `${body}.${sig}`, claims };
}

/** Başlıktaki `kid` (yoksa undefined); başlık izin verilen biçimlerden biri değilse null. */
function headerKid(h: string): string | undefined | null {
  if (h === HEADER) return undefined;
  let kid: unknown;
  try {
    kid = (JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { kid?: unknown }).kid;
  } catch {
    return null;
  }
  // Kanonik biçim: alg HS256, typ JWT, kid — başka alan / alg yok (alg: none, RS256 reddedilir).
  return typeof kid === 'string' && KID.test(kid) && kid !== LEGACY_KID && h === header(kid) ? kid : null;
}

/** İmza, başlık ve süre geçerliyse claim'ler; değilse null (nedeni dışarı sızdırılmaz). */
export function verifyDeviceToken(
  token: string,
  key: string | DeviceTokenKeyring,
  now = new Date(),
): DeviceClaims | null {
  const ring = asKeyring(key);
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  const kid = headerKid(h);
  if (kid === null) return null;
  const secret = kid === undefined ? ring.legacy : ring.keys.get(kid);
  if (!secret) return null;
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
