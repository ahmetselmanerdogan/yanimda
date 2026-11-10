import catalog from '@yanimda/messages/tr.json';
import { describe, expect, it } from 'vitest';

import {
  type AccountForm,
  cancellable,
  errorCode,
  formatPrice,
  needsPayment,
  normalizePhone,
  statusLine,
  validateAccount,
} from './flow';

const ok: AccountForm = {
  firstName: 'Ayşe',
  lastName: 'Yılmaz',
  email: 'ayse@example.com',
  phone: '0532 111 22 33',
  elderName: 'Fatma Hanım',
  kvkkRead: true,
  explicitConsent: true,
};

describe('kayıt akışı yardımcıları', () => {
  it('telefon E.164', () => {
    expect(normalizePhone('0532 111 22 33', 'TR')).toBe('+905321112233');
    expect(normalizePhone('5321112233', 'TR')).toBe('+905321112233');
    expect(normalizePhone('(415) 555-0100', 'US')).toBe('+14155550100');
    expect(normalizePhone('0090 532 111 22 33', 'TR')).toBe('+905321112233');
  });

  it('doğrulama: rıza ve aydınlatma zorunlu, e-posta ve telefon biçimi', () => {
    expect(validateAccount(ok, 'TR')).toEqual({});
    expect(validateAccount({ ...ok, explicitConsent: false, kvkkRead: false }, 'TR')).toEqual({
      explicitConsent: 'F-WEB-REQUIRED',
      kvkkRead: 'F-WEB-REQUIRED',
    });
    expect(validateAccount({ ...ok, email: 'x@y', phone: '12' }, 'TR')).toEqual({
      email: 'F-WEB-ERROR-INVALID',
      phone: 'F-WEB-ERROR-INVALID',
    });
  });

  it('hata ve durum kodları katalogda', () => {
    const codes = [
      errorCode(409, 'signup'),
      errorCode(400, 'verify'),
      errorCode(429, 'checkout'),
      errorCode(502, 'checkout'),
      errorCode(500, 'other'),
      ...(['TRIAL', 'ACTIVE', 'PAYMENT_PENDING', 'SUSPENDED', 'CANCELED'] as const).map(
        (s) => statusLine({ effectiveStatus: s, until: null }).code,
      ),
      ...validateAccount({ ...ok, firstName: '', email: 'x' }, 'TR').firstName!.split(' '),
    ];
    for (const c of codes) expect(catalog).toHaveProperty([c]);
    expect(errorCode(409, 'signup')).toBe('F-WEB-ERROR-EMAIL-TAKEN');
  });

  it('düğmeler', () => {
    expect(needsPayment({ status: 'PAST_DUE' })).toBe(true);
    expect(needsPayment({ status: 'ACTIVE' })).toBe(false);
    expect(cancellable({ status: 'CANCELED' })).toBe(false);
  });

  it('fiyat biçimi', () => {
    expect(formatPrice(39_900, 'TRY')).toMatch(/399/);
    expect(formatPrice(2_900, 'USD', 'en-US')).toBe('$29.00');
  });

  it('web akışının kullandığı her F-WEB-* kodu katalogda', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
    const root = join(__dirname, '..');
    const used = new Set<string>();
    for (const f of walk(root).filter((f) => /\.(tsx?)$/.test(f) && !f.endsWith('.test.ts')))
      for (const m of readFileSync(f, 'utf8').matchAll(/'(F-WEB-[A-Z0-9_-]+|F-SUB-[A-Z-]+)'/g)) used.add(m[1]!);
    expect(used.size).toBeGreaterThan(20);
    for (const c of used) expect(catalog, c).toHaveProperty([c]);
  });
});
