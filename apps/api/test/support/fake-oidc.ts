import { createSign, generateKeyPairSync, type KeyObject, randomUUID, sign as edSign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Testler için sahte OIDC sağlayıcı (Keycloak yerine): /realms/<realm>/.well-known/openid-configuration ve
 * /realms/<realm>/certs. Yalnız test kodu; uygulamada imzalayan uç yoktur.
 */
export interface FakeOidc {
  base: string;
  issuer: (realm: string) => string;
  env: Record<string, string>;
  token: (o: TokenOpts) => string;
  /** Anahtarı döndür (eski token'lar artık doğrulanmaz). */
  rotate: () => void;
  close: () => Promise<void>;
}

export interface TokenOpts {
  realm?: 'operations' | 'consumers' | string;
  sub?: string;
  roles?: string[];
  amr?: string[];
  aud?: string | string[];
  expInSec?: number;
  name?: string;
  alg?: 'RS256' | 'ES256' | 'none' | 'HS256';
  kid?: string;
  extra?: Record<string, unknown>;
  /** Başka bir anahtarla imzala (sahte imza). */
  foreignKey?: boolean;
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

export async function startFakeOidc(): Promise<FakeOidc> {
  let rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let kid = randomUUID();
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const ecKid = randomUUID();
  const foreign = generateKeyPairSync('rsa', { modulusLength: 2048 });

  const jwk = (k: KeyObject, id: string, alg: string) => ({ ...k.export({ format: 'jwk' }), kid: id, use: 'sig', alg });
  const server: Server = createServer((req, res) => {
    const m = /^\/realms\/([^/]+)\/(\.well-known\/openid-configuration|certs)$/.exec(req.url ?? '');
    if (!m) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    if (m[2] === 'certs')
      res.end(JSON.stringify({ keys: [jwk(rsa.publicKey, kid, 'RS256'), jwk(ec.publicKey, ecKid, 'ES256')] }));
    else res.end(JSON.stringify({ issuer: issuer(m[1]!), jwks_uri: `${issuer(m[1]!)}/certs` }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const issuer = (realm: string) => `${base}/realms/${realm}`;

  const token = (o: TokenOpts = {}) => {
    const realm = o.realm ?? 'operations';
    const now = Math.floor(Date.now() / 1000);
    const alg = o.alg ?? 'RS256';
    const header = { alg, typ: 'JWT', kid: o.kid ?? (alg === 'ES256' ? ecKid : kid) };
    const claims = {
      iss: issuer(realm),
      sub: o.sub ?? `user-${randomUUID()}`,
      aud: o.aud ?? ['yanimda-api'],
      typ: 'Bearer',
      exp: now + (o.expInSec ?? 300),
      iat: now,
      realm_access: { roles: o.roles ?? ['OPERATOR'] },
      amr: o.amr ?? (realm === 'operations' ? ['pwd', 'otp'] : ['pwd']),
      ...(o.name ? { name: o.name } : {}),
      ...o.extra,
    };
    const body = `${b64(header)}.${b64(claims)}`;
    if (alg === 'none') return `${body}.`;
    if (alg === 'HS256') return `${body}.${Buffer.from('x').toString('base64url')}`;
    if (alg === 'ES256')
      return `${body}.${edSign('sha256', Buffer.from(body), { key: ec.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    const s = createSign('RSA-SHA256')
      .update(body)
      .sign(o.foreignKey ? foreign.privateKey : rsa.privateKey);
    return `${body}.${s.toString('base64url')}`;
  };

  return {
    base,
    issuer,
    env: {
      OIDC_OPERATIONS_ISSUER: issuer('operations'),
      OIDC_CONSUMERS_ISSUER: issuer('consumers'),
      OIDC_AUDIENCE: 'yanimda-api',
    },
    token,
    rotate: () => {
      rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
      kid = randomUUID();
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
