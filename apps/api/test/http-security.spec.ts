import { type ArgumentsHost, ForbiddenException, HttpException, UnauthorizedException } from '@nestjs/common';
import RedisMock from 'ioredis-mock';
import { lastValueFrom, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requestId, securityHeaders } from '../src/common/http-security';
import { ProblemFilter } from '../src/common/problem.filter';
import { alarmBatch, RateLimiter, rateLimitInterceptor } from '../src/common/rate-limit';
import { setSecurityEventSink } from '../src/common/security-events';
import { FamilyMembersController, ProfileController } from '../src/modules/profile/profile.controller';

/** T-081 (ASVS 14.3.3, 14.4.x, 8.2.1, 7.1.3, 7.2.x, 11.1.4): güvenlik başlıkları, korelasyon kimliği, olay log'u, hız sınırı. */

function fakeRes() {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader: (k: string, v: string) => (headers[k.toLowerCase()] = v),
    getHeader: (k: string) => headers[k.toLowerCase()],
    removeHeader: (k: string) => delete headers[k.toLowerCase()],
  };
}

describe('Güvenlik başlıkları', () => {
  it('API yanıtı: nosniff, DENY, no-referrer, no-store, CSP, attachment; sürüm bilgisi yok', () => {
    const res = fakeRes();
    res.setHeader('X-Powered-By', 'Express');
    const next = vi.fn();
    securityHeaders({} as never, res as never, next);
    expect(next).toHaveBeenCalled();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(res.headers['content-disposition']).toBe('attachment; filename="api.json"');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('korelasyon kimliği: geçerli gelen değer korunur, yoksa / bozuksa yenisi üretilir', () => {
    const next = vi.fn();
    const ok = { headers: { 'x-request-id': 'abc12345-req' } } as { headers: Record<string, string>; id?: string };
    const r1 = fakeRes();
    requestId(ok as never, r1 as never, next);
    expect(ok.id).toBe('abc12345-req');
    expect(r1.headers['x-request-id']).toBe('abc12345-req');

    const bad = { headers: { 'x-request-id': 'kötü değer\n<script>' } } as {
      headers: Record<string, string>;
      id?: string;
    };
    const r2 = fakeRes();
    requestId(bad as never, r2 as never, next);
    expect(bad.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r2.headers['x-request-id']).toBe(bad.id);
  });
});

describe('Güvenlik olayı log’u (ProblemFilter)', () => {
  const events: { status: number; route: string; method: string; requestId?: string }[] = [];
  beforeEach(() => {
    events.length = 0;
    setSecurityEventSink((e) => events.push(e));
  });
  afterEach(() => setSecurityEventSink(null));

  function run(e: unknown, url = '/v1/protected-persons/0f9c4a1e-0000-4000-8000-000000000001') {
    const res = {
      setHeader: () => undefined,
      status() {
        return this;
      },
      type() {
        return this;
      },
      send: () => undefined,
    };
    const req = { method: 'GET', originalUrl: url, route: { path: '/v1/protected-persons/:id' }, id: 'rq-1' };
    new ProblemFilter().catch(e, {
      switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
    } as unknown as ArgumentsHost);
  }

  it.each([
    [401, new UnauthorizedException('Giriş gerekli')],
    [403, new ForbiddenException('Yetki yok')],
    [429, new HttpException('Çok fazla istek', 429)],
    [400, new HttpException('geçersiz', 400)],
  ])('%s kaydedilir: rota şablonu + istek kimliği, ham URL / kimlik yok', (status, e) => {
    run(e);
    expect(events).toEqual([{ status, method: 'GET', route: '/v1/protected-persons/:id', requestId: 'rq-1' }]);
  });

  it('404 ve 409 güvenlik olayı değildir', () => {
    run(new HttpException('yok', 404));
    run(new HttpException('çakışma', 409));
    expect(events).toEqual([]);
  });
});

describe('Hız sınırı', () => {
  let redis: InstanceType<typeof RedisMock>;
  beforeEach(async () => {
    redis = new RedisMock();
    await redis.flushall();
  });

  it('pencere içinde sınırı aşan istek 429 + Retry-After; başka anahtar etkilenmez', async () => {
    const rl = new RateLimiter(redis as never);
    for (let i = 0; i < 3; i++) expect((await rl.hit('test', 'a', 3, 60)).allowed).toBe(true);
    const over = await rl.hit('test', 'a', 3, 60);
    expect(over.allowed).toBe(false);
    expect(over.retryAfterSec).toBeGreaterThan(0);
    expect((await rl.hit('test', 'b', 3, 60)).allowed).toBe(true);
  });

  it('Redis yoksa açık kalır (acil akışı hız sınırı yüzünden durmaz)', async () => {
    const broken = { multi: () => ({ exec: () => Promise.reject(new Error('ECONNREFUSED')) }) };
    const rl = new RateLimiter(broken as never);
    expect((await rl.hit('test', 'a', 1, 60)).allowed).toBe(true);
    expect((await rl.hit('test', 'a', 1, 60)).allowed).toBe(true);
  });

  it('alarm içeren sinyal partisi muaf (SOS, FALL, INACTIVITY, CANCEL, OK, CALLBACK_REQUEST)', () => {
    expect(alarmBatch([{ kind: 'HEARTBEAT' }, { kind: 'SOS' }])).toBe(true);
    expect(alarmBatch([{ kind: 'CALLBACK_REQUEST' }])).toBe(true);
    expect(alarmBatch([{ kind: 'HEARTBEAT' }, { kind: 'LOCATION' }])).toBe(false);
    expect(alarmBatch('x')).toBe(false);
  });

  it('interceptor: anahtar kullanıcı / cihaz / IP; aşımda 429, muafiyet uygulanır', async () => {
    const rl = new RateLimiter(redis as never);
    const icpt = rateLimitInterceptor(rl, { name: 'invite', limit: 1, windowSec: 60, by: 'user' });
    const ctx = (req: object) =>
      ({ switchToHttp: () => ({ getRequest: () => req, getResponse: () => fakeRes() }) }) as never;
    const handler = { handle: () => of('ok') };
    const req = { user: { sub: 'u1' }, ip: '10.0.0.1', headers: {} };
    expect(await lastValueFrom(await icpt.intercept(ctx(req), handler))).toBe('ok');
    await expect(icpt.intercept(ctx(req), handler)).rejects.toMatchObject({ status: 429 });
    // başka kullanıcı aynı IP'den
    expect(await lastValueFrom(await icpt.intercept(ctx({ ...req, user: { sub: 'u2' } }), handler))).toBe('ok');

    const sig = rateLimitInterceptor(rl, {
      name: 'signals',
      limit: 1,
      windowSec: 60,
      by: 'device',
      exempt: (r) => alarmBatch((r as { body?: unknown }).body),
    });
    const dev = { device: { deviceId: 'd1' }, ip: '10.0.0.2', headers: {}, body: [{ kind: 'HEARTBEAT' }] };
    await lastValueFrom(await sig.intercept(ctx(dev), handler));
    await expect(sig.intercept(ctx(dev), handler)).rejects.toMatchObject({ status: 429 });
    const sos = { ...dev, body: [{ kind: 'SOS' }] };
    expect(await lastValueFrom(await sig.intercept(ctx(sos), handler))).toBe('ok');
  });
});

describe('Hız sınırı uçları', () => {
  it('aile üyesi daveti ve kabulü sınırlı (kod tahmini, davet bombalama)', () => {
    const meta = (fn: unknown) =>
      Reflect.getMetadata('yanimda:rate-limit', fn as object) as { name: string; by: string };
    expect(meta(FamilyMembersController.prototype.accept)).toMatchObject({ name: 'member-accept', by: 'user' });
    expect(meta(ProfileController.prototype.memberInvite)).toMatchObject({ name: 'member-invite', by: 'param:id' });
  });
});
