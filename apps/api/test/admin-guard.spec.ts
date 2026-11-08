import type { ExecutionContext } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';

import { AdminTokenGuard } from '../src/modules/rules/admin-token.guard';

/** POST /v1/admin/rules/reload yalnız yönetici (T-020'ye kadar paylaşılan token; tanımsızsa kapalı). */
const ctx = (token?: string) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ headers: token ? { 'x-admin-token': token } : {} }) }),
  }) as unknown as ExecutionContext;
const guard = new AdminTokenGuard();
const prev = process.env.ADMIN_TOKEN;
afterEach(() => {
  if (prev === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = prev;
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
