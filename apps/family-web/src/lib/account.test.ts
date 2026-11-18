import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { accountError, billingPayload, subscriptionOrNull } from './account';
import { ApiError } from './api';

describe('Aboneliğim: işlem hataları', () => {
  it('iptal / ödeme 401 → yeniden giriş (genel hata değil)', () => {
    expect(accountError(new ApiError(401), 'cancel')).toEqual({ code: null, relogin: true });
    expect(accountError(new ApiError(401), 'checkout')).toEqual({ code: null, relogin: true });
  });
  it('diğer API hataları katalog koduna; ağ hatası genel hata', () => {
    expect(accountError(new ApiError(502), 'checkout')).toEqual({ code: 'F-WEB-PAY-FAILED', relogin: false });
    expect(accountError(new ApiError(429), 'cancel')).toEqual({ code: 'F-WEB-ERROR-TOO-MANY', relogin: false });
    expect(accountError(new TypeError('Failed to fetch'), 'cancel')).toEqual({ code: 'F-WEB-ERROR', relogin: false });
  });
  it('Account.tsx iptal ve ödeme hatalarında yeniden girişe düşer', () => {
    const src = readFileSync(join(__dirname, '../app/hesap/Account.tsx'), 'utf8');
    expect(src.match(/accountError\(e, '(cancel|checkout)'\)/g)).toHaveLength(2);
    expect(src).not.toMatch(/e instanceof ApiError \? errorCode/);
  });
});

describe('Aboneliğim: kişi başına abonelik okuması', () => {
  it('401 yutulmaz (yeniden giriş kapısı); 404 / ağ hatası kartı aboneliksiz gösterir', async () => {
    await expect(subscriptionOrNull(Promise.reject(new ApiError(401)))).rejects.toMatchObject({ status: 401 });
    expect(await subscriptionOrNull(Promise.reject(new ApiError(404)))).toBeNull();
    expect(await subscriptionOrNull(Promise.reject(new TypeError('Failed to fetch')))).toBeNull();
    expect(await subscriptionOrNull(Promise.resolve({ status: 'ACTIVE' }))).toEqual({ status: 'ACTIVE' });
  });
  it('Account.tsx abonelik hatasını sessizce null yapmaz', () => {
    const src = readFileSync(join(__dirname, '../app/hesap/Account.tsx'), 'utf8');
    expect(src).toContain('subscriptionOrNull(api.subscription(');
    expect(src).not.toMatch(/api\.subscription\([^)]*\)\.catch\(\(\) => null\)/);
  });
});

describe('Aboneliğim: fatura bilgisi kişi başına', () => {
  it('TR: il ve adres zorunlu, kırpılır', () => {
    expect(billingPayload({ city: '  İstanbul ', address: ' Moda Cd. 1  ' }, 'TR')).toEqual({
      invalid: false,
      billing: { city: 'İstanbul', address: 'Moda Cd. 1' },
    });
    expect(billingPayload({ city: '   ', address: 'x' }, 'TR')).toEqual({ invalid: true });
    expect(billingPayload(undefined, 'TR')).toEqual({ invalid: true });
  });
  it('TR dışı: fatura gönderilmez', () => {
    expect(billingPayload({ city: 'x', address: 'y' }, 'US')).toEqual({ invalid: false, billing: undefined });
  });
  it('Account.tsx fatura durumu kişi kimliğiyle anahtarlı (kartlar birbirine yazmaz)', () => {
    const src = readFileSync(join(__dirname, '../app/hesap/Account.tsx'), 'utf8');
    expect(src).toMatch(/useState<Record<string, Billing>>/);
    expect(src).not.toMatch(/value=\{billing\.(city|address)\}/);
  });
});
