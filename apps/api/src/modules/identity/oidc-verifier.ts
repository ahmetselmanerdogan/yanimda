import { createPublicKey, type KeyObject, verify } from 'node:crypto';

import { Logger } from '@nestjs/common';

/**
 * T-020 OIDC erişim token'ı doğrulama (Keycloak). Bağımlılık eklememek için node:crypto ile yazıldı.
 * - Yalnız RS256 / ES256 kabul edilir (alg: none, HS* reddedilir: açık anahtarı HMAC sırrı gibi kullanma saldırısı).
 * - iss yapılandırılmış realm'lerden biri olmalı; anahtarlar o realm'in JWKS'inden (discovery → jwks_uri) gelir.
 * - aud `yanimda-api` içermeli; exp/nbf 30 sn saat kayması payıyla.
 * - Roller realm'e bağlıdır: operasyon rolleri yalnız `operations`, tüketici rolleri yalnız `consumers` realm'inden.
 * - operations realm'inde amr içinde "otp" zorunludur (requireMfa): parolayla tek başına giriş reddedilir.
 */

export type Realm = 'operations' | 'consumers';
export const OPERATION_ROLES = ['OPERATOR', 'SUPERVISOR', 'ADMIN'] as const;
export const CONSUMER_ROLES = ['ELDER', 'FAMILY'] as const;
export type Role = (typeof OPERATION_ROLES)[number] | (typeof CONSUMER_ROLES)[number];

const REALM_ROLES: Record<Realm, readonly Role[]> = { operations: OPERATION_ROLES, consumers: CONSUMER_ROLES };

export interface UserPrincipal {
  sub: string;
  realm: Realm;
  roles: Role[];
  /** Ekranda gösterilecek ad (ör. operatör adı). Log'a yazılmaz. */
  name?: string;
}

export interface IssuerConfig {
  realm: Realm;
  issuer: string;
  requireMfa: boolean;
}

export interface OidcConfig {
  issuers: IssuerConfig[];
  audience: string;
  clockSkewSec: number;
}

export class TokenError extends Error {}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

/** Ortamdan yapılandırma. OIDC_*_ISSUER yoksa KEYCLOAK_URL/realms/<realm>. İkisi de yoksa realm kapalıdır. */
export function oidcConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OidcConfig {
  const base = env.KEYCLOAK_URL ? `${trimSlash(env.KEYCLOAK_URL)}/realms` : undefined;
  const issuers: IssuerConfig[] = [];
  const ops = env.OIDC_OPERATIONS_ISSUER || (base && `${base}/operations`);
  const cons = env.OIDC_CONSUMERS_ISSUER || (base && `${base}/consumers`);
  if (ops) issuers.push({ realm: 'operations', issuer: trimSlash(ops), requireMfa: env.OIDC_REQUIRE_MFA !== 'false' });
  if (cons) issuers.push({ realm: 'consumers', issuer: trimSlash(cons), requireMfa: false });
  if (env.NODE_ENV === 'production' && env.OIDC_REQUIRE_MFA === 'false')
    throw new Error('Üretimde OIDC_REQUIRE_MFA=false olamaz');
  return { issuers, audience: env.OIDC_AUDIENCE || 'yanimda-api', clockSkewSec: 30 };
}

export type FetchJson = (url: string) => Promise<unknown>;

const defaultFetch: FetchJson = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

/** JWKS anahtarı (RFC 7517). @types/node 26'da `node:crypto` JsonWebKey dışa vermez; kendi tipimiz. */
interface Jwk {
  kty?: string;
  crv?: string;
  kid?: string;
  use?: string;
  alg?: string;
  [k: string]: unknown;
}
type JwkInput = Extract<Parameters<typeof createPublicKey>[0], { format: 'jwk' }>;

interface KeySet {
  keys: Map<string, { key: KeyObject; alg?: string }>;
  fetchedAt: number;
}

/** Bilinmeyen kid'de JWKS en fazla bu aralıkla yeniden çekilir (anahtar döndürme). */
const REFETCH_MIN_MS = 30_000;
/** Bilinen anahtarlar da bu süre sonra tazelenir (iptal edilmiş anahtar kullanılmaya devam etmesin). */
const MAX_AGE_MS = 10 * 60_000;

const ALGS = { RS256: { hash: 'sha256', ec: false }, ES256: { hash: 'sha256', ec: true } } as const;
type Alg = keyof typeof ALGS;

export class OidcVerifier {
  private readonly log = new Logger('Oidc');
  private readonly sets = new Map<string, KeySet>();
  private readonly inflight = new Map<string, Promise<KeySet>>();

  constructor(
    readonly config: OidcConfig,
    private readonly fetchJson: FetchJson = defaultFetch,
  ) {}

  get enabled(): boolean {
    return this.config.issuers.length > 0;
  }

  /** Geçerliyse kimlik; değilse TokenError (mesaj istemciye dönmez, guard genel 401 verir). */
  async verify(token: string, now = new Date()): Promise<UserPrincipal> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new TokenError('biçim');
    const [h, p, s] = parts as [string, string, string];
    const header = parseJson<{ alg?: string; kid?: string; typ?: string }>(h);
    const claims = parseJson<Record<string, unknown>>(p);
    if (!header || !claims) throw new TokenError('biçim');
    if (!header.alg || !(header.alg in ALGS)) throw new TokenError('alg');
    const alg = header.alg as Alg;

    const iss = typeof claims.iss === 'string' ? trimSlash(claims.iss) : '';
    const issuer = this.config.issuers.find((i) => i.issuer === iss);
    if (!issuer) throw new TokenError('iss');

    const key = await this.keyFor(issuer.issuer, header.kid, now);
    if (key.alg && key.alg !== alg) throw new TokenError('alg');
    const ok = verify(
      ALGS[alg].hash,
      Buffer.from(`${h}.${p}`),
      ALGS[alg].ec ? { key: key.key, dsaEncoding: 'ieee-p1363' } : key.key,
      Buffer.from(s, 'base64url'),
    );
    if (!ok) throw new TokenError('imza');

    const t = Math.floor(now.getTime() / 1000);
    const skew = this.config.clockSkewSec;
    if (typeof claims.exp !== 'number' || claims.exp + skew <= t) throw new TokenError('exp');
    if (typeof claims.nbf === 'number' && claims.nbf - skew > t) throw new TokenError('nbf');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.config.audience)) throw new TokenError('aud');
    if (claims.typ !== undefined && claims.typ !== 'Bearer') throw new TokenError('typ'); // ID/refresh token değil
    if (typeof claims.sub !== 'string' || !claims.sub) throw new TokenError('sub');

    if (issuer.requireMfa) {
      const amr = Array.isArray(claims.amr) ? claims.amr : [];
      if (!amr.includes('otp')) throw new TokenError('mfa');
    }

    const allowed = REALM_ROLES[issuer.realm];
    const raw = (claims.realm_access as { roles?: unknown } | undefined)?.roles;
    const roles = (Array.isArray(raw) ? raw : []).filter((r): r is Role => allowed.includes(r as Role));
    const name =
      typeof claims.name === 'string'
        ? claims.name
        : typeof claims.preferred_username === 'string'
          ? claims.preferred_username
          : undefined;
    return { sub: claims.sub, realm: issuer.realm, roles, ...(name ? { name } : {}) };
  }

  private async keyFor(issuer: string, kid: string | undefined, now: Date) {
    let set = this.sets.get(issuer);
    const age = set ? now.getTime() - set.fetchedAt : Infinity;
    const find = (s?: KeySet) => s && (kid ? s.keys.get(kid) : s.keys.size === 1 ? [...s.keys.values()][0] : undefined);
    if (!find(set) || age > MAX_AGE_MS) {
      if (!set || age > REFETCH_MIN_MS) set = await this.load(issuer, now);
    }
    const key = find(set);
    if (!key) throw new TokenError('kid');
    return key;
  }

  private load(issuer: string, now: Date): Promise<KeySet> {
    const running = this.inflight.get(issuer);
    if (running) return running;
    const p = (async () => {
      try {
        const disc = (await this.fetchJson(`${issuer}/.well-known/openid-configuration`)) as { jwks_uri?: string };
        if (!disc?.jwks_uri) throw new Error('jwks_uri yok');
        const jwks = (await this.fetchJson(disc.jwks_uri)) as { keys?: Jwk[] };
        const keys = new Map<string, { key: KeyObject; alg?: string }>();
        for (const k of jwks?.keys ?? []) {
          if (k.use && k.use !== 'sig') continue;
          if (k.kty !== 'RSA' && !(k.kty === 'EC' && k.crv === 'P-256')) continue;
          try {
            keys.set(k.kid ?? '', { key: createPublicKey({ key: k as JwkInput['key'], format: 'jwk' }), alg: k.alg });
          } catch {
            /* bozuk anahtar atlanır */
          }
        }
        const set = { keys, fetchedAt: now.getTime() };
        this.sets.set(issuer, set);
        return set;
      } catch (e) {
        this.log.warn(`JWKS alınamadı (${issuer}): ${(e as Error).message}`);
        const stale = this.sets.get(issuer);
        if (stale) return stale; // kimlik sağlayıcı kısa süre erişilemezse son bilinen anahtarlarla devam
        throw new TokenError('jwks');
      } finally {
        this.inflight.delete(issuer);
      }
    })();
    this.inflight.set(issuer, p);
    return p;
  }
}

function parseJson<T>(b64: string): T | null {
  try {
    const v = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as unknown;
    return v && typeof v === 'object' ? (v as T) : null;
  } catch {
    return null;
  }
}
