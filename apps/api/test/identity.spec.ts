import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AdminGuard, OidcGuard, Roles, type UserRequest } from '../src/modules/identity/oidc.guard';
import { oidcConfigFromEnv, OidcVerifier } from '../src/modules/identity/oidc-verifier';
import { type FakeOidc, startFakeOidc } from './support/fake-oidc';

/**
 * T-020 kimlik ve erişim. Kabul:
 *  - token'sız GET /v1/queue 401
 *  - FAMILY rolü 403
 *  - OTP olmadan operations girişi reddedilir (amr'de otp yoksa 401; Keycloak akışı da OTP'yi zorunlu kılar)
 */
let idp: FakeOidc;
let verifier: OidcVerifier;
beforeAll(async () => {
  idp = await startFakeOidc();
  verifier = new OidcVerifier(oidcConfigFromEnv({ ...idp.env, NODE_ENV: 'test' }));
});
afterAll(async () => {
  await idp.close();
});

class QueueLike {
  @Roles('OPERATOR', 'SUPERVISOR') queue() {}
  @Roles('ADMIN') admin() {}
  open() {}
}

const ctx = (headers: Record<string, string>, handler: keyof QueueLike = 'queue') => {
  const req: UserRequest = { headers };
  return {
    req,
    c: {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => QueueLike.prototype[handler],
      getClass: () => QueueLike,
    } as unknown as ExecutionContext,
  };
};
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const status = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === 'function' ? p() : p);
    return 'ok';
  } catch (e) {
    return (e as { status?: number; message?: string }).status ?? (e as Error).message;
  }
};

describe('OidcVerifier', () => {
  it('geçerli operations token → kimlik ve realm rolleri', async () => {
    const p = await verifier.verify(idp.token({ sub: 'op-1', roles: ['OPERATOR', 'offline_access'], name: 'Ayşe' }));
    expect(p).toEqual({ sub: 'op-1', realm: 'operations', roles: ['OPERATOR'], name: 'Ayşe' });
  });
  it('ES256 de kabul edilir', async () => {
    expect((await verifier.verify(idp.token({ alg: 'ES256' }))).realm).toBe('operations');
  });
  it.each([
    ['alg none', { alg: 'none' as const }],
    ['HS256 (açık anahtarı sır olarak kullanma)', { alg: 'HS256' as const }],
    ['yabancı anahtarla imza', { foreignKey: true }],
    ['süresi dolmuş', { expInSec: -60 }],
    ['yanlış aud', { aud: 'account' }],
    ['bilinmeyen realm', { realm: 'master' }],
    ['OTP olmadan operations', { amr: ['pwd'] }],
    ['ID token (typ)', { extra: { typ: 'ID' } }],
  ])('%s → reddedilir', async (_n, o) => {
    await expect(verifier.verify(idp.token(o))).rejects.toThrow();
  });
  it('consumers realm OTP istemez; operasyon rolü taşısa bile alınmaz', async () => {
    const p = await verifier.verify(idp.token({ realm: 'consumers', roles: ['FAMILY', 'ADMIN'] }));
    expect(p).toMatchObject({ realm: 'consumers', roles: ['FAMILY'] });
  });
  it('operations realm tüketici rolünü taşımaz', async () => {
    expect((await verifier.verify(idp.token({ roles: ['FAMILY', 'OPERATOR'] }))).roles).toEqual(['OPERATOR']);
  });
  it('bozuk biçim reddedilir', async () => {
    for (const t of ['', 'a.b', 'a.b.c', '...']) await expect(verifier.verify(t)).rejects.toThrow();
  });
  it('anahtar döndürülünce yeni kid için JWKS yeniden çekilir', async () => {
    const own = await startFakeOidc();
    try {
      const v = new OidcVerifier(oidcConfigFromEnv({ ...own.env }));
      await v.verify(own.token());
      own.rotate();
      await expect(v.verify(own.token())).rejects.toThrow(); // 30 sn içinde yeniden çekilmez (kid taşması)
      const later = new Date(Date.now() + 31_000);
      await expect(v.verify(own.token({ expInSec: 600 }), later)).resolves.toMatchObject({ realm: 'operations' });
    } finally {
      await own.close();
    }
  });
});

describe('oidcConfigFromEnv', () => {
  it('KEYCLOAK_URL → iki realm; operations MFA zorunlu', () => {
    const c = oidcConfigFromEnv({ KEYCLOAK_URL: 'http://kc:8080/' });
    expect(c.issuers).toEqual([
      { realm: 'operations', issuer: 'http://kc:8080/realms/operations', requireMfa: true },
      { realm: 'consumers', issuer: 'http://kc:8080/realms/consumers', requireMfa: false },
    ]);
    expect(c.audience).toBe('yanimda-api');
  });
  it('yapılandırma yoksa kapalı; üretimde MFA kapatılamaz', () => {
    expect(new OidcVerifier(oidcConfigFromEnv({})).enabled).toBe(false);
    expect(() =>
      oidcConfigFromEnv({ KEYCLOAK_URL: 'http://kc', OIDC_REQUIRE_MFA: 'false', NODE_ENV: 'production' }),
    ).toThrow();
  });
});

describe('OidcGuard ve @Roles', () => {
  const guard = () => new OidcGuard(verifier, new Reflector());
  it("token'sız kuyruk → 401", async () => {
    expect(await status(guard().canActivate(ctx({}).c))).toBe(401);
    expect(await status(guard().canActivate(ctx({ authorization: 'Basic eDp5' }).c))).toBe(401);
    expect(await status(guard().canActivate(ctx({ 'x-operator-id': 'op-dev' }).c))).toBe(401);
  });
  it('FAMILY rolü → 403', async () => {
    const t = idp.token({ realm: 'consumers', roles: ['FAMILY'] });
    expect(await status(guard().canActivate(ctx(bearer(t)).c))).toBe(403);
  });
  it('OTP olmadan operatör → 401', async () => {
    expect(await status(guard().canActivate(ctx(bearer(idp.token({ amr: ['pwd'] }))).c))).toBe(401);
  });
  it('OPERATOR → izin; req.user token kimliği', async () => {
    const { c, req } = ctx(bearer(idp.token({ sub: 'op-7' })));
    expect(await guard().canActivate(c)).toBe(true);
    expect(req.user).toMatchObject({ sub: 'op-7', roles: ['OPERATOR'] });
  });
  it('rol istemeyen uç geçerli token ile açılır; ADMIN ucu OPERATOR’a 403', async () => {
    expect(await guard().canActivate(ctx(bearer(idp.token({ realm: 'consumers', roles: ['FAMILY'] })), 'open').c)).toBe(
      true,
    );
    expect(await status(guard().canActivate(ctx(bearer(idp.token()), 'admin').c))).toBe(403);
  });
  it('kimlik sağlayıcı yapılandırılmamışsa 401', async () => {
    const g = new OidcGuard(new OidcVerifier(oidcConfigFromEnv({})), new Reflector());
    expect(await status(g.canActivate(ctx(bearer(idp.token())).c))).toBe(401);
  });
});

describe('AdminGuard', () => {
  const prev = process.env.ADMIN_TOKEN;
  afterEach(() => {
    if (prev === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = prev;
  });
  const g = () => new AdminGuard(verifier);
  it('OIDC ADMIN → izin, OPERATOR → 403, geçersiz Bearer paylaşılan token’a düşmez → 401', async () => {
    process.env.ADMIN_TOKEN = 'dogru-token-123';
    expect(await g().canActivate(ctx(bearer(idp.token({ roles: ['ADMIN'] }))).c)).toBe(true);
    expect(await status(g().canActivate(ctx(bearer(idp.token())).c))).toBe(403);
    const bad = { authorization: 'Bearer bozuk', 'x-admin-token': 'dogru-token-123' };
    expect(await status(g().canActivate(ctx(bad).c))).toBe(401);
  });
  it('Bearer yoksa x-admin-token (betikler/CI)', async () => {
    process.env.ADMIN_TOKEN = 'dogru-token-123';
    expect(await g().canActivate(ctx({ 'x-admin-token': 'dogru-token-123' }).c)).toBe(true);
    expect(await status(g().canActivate(ctx({}).c))).toBe(403);
  });
});
