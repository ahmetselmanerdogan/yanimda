import type { ExecutionContext } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';

import { adminTokenEnabled, AdminTokenGuard, assertAdminTokenPolicy } from '../src/modules/rules/admin-token.guard';

/** POST /v1/admin/rules/reload yalnız yönetici (T-020'ye kadar paylaşılan token; tanımsızsa kapalı). */
const ctx = (token?: string) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ headers: token ? { 'x-admin-token': token } : {} }) }),
  }) as unknown as ExecutionContext;
const guard = new AdminTokenGuard();
const prev = process.env.ADMIN_TOKEN;
const prevEnv = process.env.NODE_ENV;
afterEach(() => {
  if (prev === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = prev;
  process.env.NODE_ENV = prevEnv;
});

describe('AdminTokenGuard', () => {
  it('ADMIN_TOKEN tanımsızsa her istek 403 (güvenli varsayılan)', () => {
    delete process.env.ADMIN_TOKEN;
    expect(() => guard.canActivate(ctx('herhangi'))).toThrow(expect.objectContaining({ status: 403 }));
  });
  it('başlık yok veya yanlış → 403', () => {
    process.env.ADMIN_TOKEN = 'dogru-token-123';
    expect(() => guard.canActivate(ctx())).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => guard.canActivate(ctx('yanlis-token-12'))).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => guard.canActivate(ctx('kisa'))).toThrow(expect.objectContaining({ status: 403 }));
  });
  it('doğru token → izin', () => {
    process.env.ADMIN_TOKEN = 'dogru-token-123';
    expect(guard.canActivate(ctx('dogru-token-123'))).toBe(true);
  });
});

/** T-081 G-4 (ASVS 1.2.4, 2.5.4, 3.5.2, 4.3.1): üretimde paylaşılan yönetici anahtarı yolu yok. */
describe('ADMIN_TOKEN üretimde kapalı', () => {
  it('NODE_ENV=production: doğru token bile 403', () => {
    process.env.ADMIN_TOKEN = 'dogru-token-123';
    process.env.NODE_ENV = 'production';
    expect(adminTokenEnabled()).toBe(false);
    expect(() => guard.canActivate(ctx('dogru-token-123'))).toThrow(expect.objectContaining({ status: 403 }));
  });
  it('geliştirme/test: yalnız ADMIN_TOKEN doluysa açık', () => {
    expect(adminTokenEnabled({ NODE_ENV: 'test', ADMIN_TOKEN: 'x'.repeat(16) })).toBe(true);
    expect(adminTokenEnabled({ NODE_ENV: 'development' })).toBe(false);
    expect(adminTokenEnabled({ NODE_ENV: 'production', ADMIN_TOKEN: 'x'.repeat(16) })).toBe(false);
  });
  it('açılış denetimi: üretimde ADMIN_TOKEN tanımlıysa API açılmaz; boşsa / geliştirmede açılır', () => {
    expect(() => assertAdminTokenPolicy({ NODE_ENV: 'production', ADMIN_TOKEN: 'abc' })).toThrow(/ADMIN_TOKEN/);
    expect(() => assertAdminTokenPolicy({ NODE_ENV: 'production', ADMIN_TOKEN: '' })).not.toThrow();
    expect(() => assertAdminTokenPolicy({ NODE_ENV: 'production' })).not.toThrow();
    expect(() => assertAdminTokenPolicy({ NODE_ENV: 'test', ADMIN_TOKEN: 'abc' })).not.toThrow();
  });
  it('hata mesajı sırrın değerini içermez', () => {
    const value = ['cok', 'gizli', 'deger'].join('-'); // sabit dize değil: gitleaks generic-api-key
    expect.assertions(1);
    try {
      assertAdminTokenPolicy({ NODE_ENV: 'production', ADMIN_TOKEN: value });
    } catch (e) {
      expect(String(e)).not.toContain(value);
    }
  });
});
