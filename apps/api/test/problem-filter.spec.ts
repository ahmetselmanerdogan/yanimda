import { type ArgumentsHost, BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { isTransient, ProblemFilter } from '../src/common/problem.filter';

/** RFC 7807; altyapı yokken 503 + Retry-After (T-016: Postgres kapalı → 503, cihaz yeniden dener). */
function run(e: unknown) {
  const out: { status?: number; headers: Record<string, string>; body?: { status: number; detail: string } } = {
    headers: {},
  };
  const res = {
    setHeader: (k: string, v: string) => (out.headers[k] = v),
    status(s: number) {
      out.status = s;
      return this;
    },
    type() {
      return this;
    },
    send(b: typeof out.body) {
      out.body = b;
    },
  };
  new ProblemFilter().catch(e, { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost);
  return out;
}

describe('ProblemFilter', () => {
  it.each([
    ['ECONNREFUSED', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
    ['Drizzle sarmalı 57P01', Object.assign(new Error('Failed query'), { cause: { code: '57P01' } })],
    ['bağlantı koptu', new Error('Connection terminated unexpectedly')],
  ])('geçici altyapı hatası (%s) → 503 + Retry-After', (_n, e) => {
    const r = run(e);
    expect(r.status).toBe(503);
    expect(r.headers['Retry-After']).toBe('2');
    expect(isTransient(e)).toBe(true);
  });

  it('beklenmeyen hata → 500, iç mesaj (PII olabilir) dışarı sızmaz', () => {
    const r = run(new Error('Failed query: ... params: konum 41.01'));
    expect(r.status).toBe(500);
    expect(r.body!.detail).toBe('Internal error');
  });

  it('HttpException kendi durumunu korur', () => {
    expect(run(new ConflictException('Başka operatör üstlendi')).body).toMatchObject({
      status: 409,
      detail: 'Başka operatör üstlendi',
    });
  });

  it('katalog kodu taşıyan hata: detail katalog metni, code alanı istemciye geçer (T-040 üye daveti)', () => {
    const body = run(new BadRequestException({ message: 'Davet kodu geçersiz.', code: 'F-MEMBER-CODE-INVALID' })).body;
    expect(body).toMatchObject({ status: 400, detail: 'Davet kodu geçersiz.', code: 'F-MEMBER-CODE-INVALID' });
    // Katalog biçiminde olmayan "code" dışarı verilmez.
    expect(run(new BadRequestException({ message: 'x', code: 'select * from' })).body).not.toHaveProperty('code');
    expect(run(new ConflictException('düz')).body).not.toHaveProperty('code');
  });

  it('D-01: sinyal partisi ret listesi (rejected) yalnız doğrulanmış biçimde geçer', () => {
    const body = run(
      new BadRequestException({
        message: 'Partide kabul edilebilir sinyal yok',
        rejected: [
          { index: 0, idempotencyKey: 'dev:1:SOS:abc', reason: 'SCHEMA_INVALID' },
          { index: 1, idempotencyKey: 'boşluk var ve çok', reason: 'UNSUPPORTED_SIGNAL', extra: 'konum 41.01' },
          { index: 2, reason: 'select * from' },
          'x',
        ],
      }),
    ).body;
    expect(body).toMatchObject({
      status: 400,
      rejected: [
        { index: 0, idempotencyKey: 'dev:1:SOS:abc', reason: 'SCHEMA_INVALID' },
        { index: 1, reason: 'UNSUPPORTED_SIGNAL' },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('41.01');
    expect(run(new ConflictException('düz')).body).not.toHaveProperty('rejected');
  });
});
