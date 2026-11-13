import { Body, Controller, HttpCode, Module, Param, Post, Put, Query, Req } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { configureHttpSecurity, contentTypeGuard, isFormRoute } from '../src/common/http-security';

/**
 * T-081 (ASVS 13.1.5, 13.2.5): JSON uçları JSON dışı gövdeyi 415 ile reddeder (ayrıştırmadan önce); form
 * (urlencoded) yalnız Twilio / CPaaS / iyzico webhook rotalarında. Gerçek Nest + Express + main.ts ile aynı
 * `rawBody: true` ve `configureHttpSecurity` sırası.
 */
const seen: { route: string; body: unknown; raw?: string }[] = [];

@Controller()
class JsonCtl {
  @Post('things')
  @HttpCode(200)
  create(@Body() body: unknown) {
    seen.push({ route: 'things', body });
    return { ok: true };
  }
  @Put('things/:id')
  @HttpCode(200)
  put(@Param('id') id: string, @Body() body: unknown) {
    seen.push({ route: `things/${id}`, body });
    return { ok: true };
  }
  @Post('webhooks/payments')
  @HttpCode(200)
  pay(@Req() req: { rawBody?: Buffer; body: unknown }) {
    seen.push({ route: 'payments', body: req.body, raw: req.rawBody?.toString() });
    return { ok: true };
  }
}

@Controller()
class FormCtl {
  @Post('webhooks/cpaas/:kind')
  @HttpCode(200)
  cpaas(@Param('kind') kind: string, @Body() body: unknown, @Req() req: { rawBody?: Buffer }) {
    seen.push({ route: `cpaas/${kind}`, body, raw: req.rawBody?.toString() });
    return { ok: true };
  }
  @Post('webhooks/notify/sms')
  @HttpCode(200)
  sms(@Query('n') n: string, @Body() body: unknown) {
    seen.push({ route: `sms?n=${n}`, body });
    return { ok: true };
  }
}

@Module({ controllers: [JsonCtl, FormCtl] })
class TestModule {}

let base: string;
let close: () => Promise<void>;
beforeAll(async () => {
  const app = await NestFactory.create(TestModule, { logger: false, rawBody: true });
  configureHttpSecurity(app, {});
  app.setGlobalPrefix('v1');
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`.replace('[::1]', '127.0.0.1');
  close = () => app.close();
});
afterAll(async () => {
  await close();
});
beforeEach(() => {
  seen.length = 0;
});

const send = (path: string, body: string | undefined, type?: string, method = 'POST') =>
  fetch(`${base}${path}`, { method, headers: type ? { 'content-type': type } : {}, body });

describe('içerik türü denetimi (415)', () => {
  it('JSON ucu: application/json (parametreli, büyük harfli) kabul ve ayrıştırılır', async () => {
    expect((await send('/things', '{"a":1}', 'application/json')).status).toBe(200);
    expect((await send('/things', '{"a":2}', 'application/json; charset=utf-8')).status).toBe(200);
    expect((await send('/things/x', '{"a":3}', 'Application/JSON', 'PUT')).status).toBe(200);
    expect(seen.map((s) => s.body)).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it('JSON ucu: urlencoded, text/plain, multipart, XML, türsüz gövde → 415 problem+json; işleyiciye ulaşmaz', async () => {
    for (const [body, type] of [
      ['a=1&b=2', 'application/x-www-form-urlencoded'],
      ['{"a":1}', 'text/plain'],
      ['--x\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--x--', 'multipart/form-data; boundary=x'],
      ['<a>1</a>', 'application/xml'],
      ['{"a":1}', 'application/jsonx'],
      ['{"a":1}', 'application/merge-patch+json'], // Express JSON ayrıştırıcısı bunu ayrıştırmaz
    ] as const) {
      const r = await send('/things', body, type);
      expect(r.status, type).toBe(415);
      expect(r.headers.get('content-type')).toMatch(/^application\/problem\+json/);
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await r.json()).toMatchObject({ status: 415, title: 'UNSUPPORTED_MEDIA_TYPE' });
    }
    // fetch, Blob türü olmadan gövdeye tür yazmaz → içerik türü yok
    const untyped = await fetch(`${base}/things`, { method: 'POST', body: new Blob(['{"a":1}']) });
    expect(untyped.status).toBe(415);
    expect(seen).toEqual([]);
  });

  it('gövdesiz istek serbest (ör. üstlenme POST, test-sos)', async () => {
    expect((await send('/things', undefined)).status).toBe(200);
    expect((await send('/things', '', 'text/plain')).status).toBe(200);
  });

  it('ödeme webhook (JSON): ham gövde imza için korunur; urlencoded 415', async () => {
    const raw = '{"event":"x", "n": 1}';
    expect((await send('/webhooks/payments', raw, 'application/json')).status).toBe(200);
    expect(seen[0]).toMatchObject({ route: 'payments', raw, body: { event: 'x', n: 1 } });
    expect((await send('/webhooks/payments', 'event=x', 'application/x-www-form-urlencoded')).status).toBe(415);
  });

  it('Twilio / CPaaS webhook: urlencoded ayrıştırılır (ham gövde de var); JSON ve diğerleri 415', async () => {
    const form = 'CallSid=CA1&CallStatus=completed';
    const r = await send('/webhooks/cpaas/status', form, 'application/x-www-form-urlencoded; charset=UTF-8');
    expect(r.status).toBe(200);
    expect(seen[0]).toMatchObject({ route: 'cpaas/status', body: { CallSid: 'CA1', CallStatus: 'completed' } });
    expect(
      (await send('/webhooks/notify/sms?n=abc', 'MessageStatus=delivered', 'application/x-www-form-urlencoded')).status,
    ).toBe(200);
    expect(seen[1]).toMatchObject({ route: 'sms?n=abc', body: { MessageStatus: 'delivered' } });
    expect((await send('/webhooks/cpaas/status', '{"CallSid":"CA1"}', 'application/json')).status).toBe(415);
    expect((await send('/webhooks/cpaas/status', form, 'text/plain')).status).toBe(415);
    expect(seen).toHaveLength(2);
  });

  it('form rota listesi dar: alt yol, benzer önek ve başka webhook form değildir', () => {
    expect(isFormRoute('/v1/webhooks/cpaas/status')).toBe(true);
    expect(isFormRoute('/v1/webhooks/cpaas-inbound/voice')).toBe(true);
    expect(isFormRoute('/v1/webhooks/screening/gather')).toBe(true);
    expect(isFormRoute('/v1/payments/iyzico/callback')).toBe(true);
    expect(isFormRoute('/v1/webhooks/cpaas/status/extra')).toBe(false);
    expect(isFormRoute('/v1/webhooks/cpaasx/status')).toBe(false);
    expect(isFormRoute('/v1/webhooks/partners/FAKE_PENDANT')).toBe(false);
    expect(isFormRoute('/v1/webhooks/payments')).toBe(false);
    expect(isFormRoute('/v1/things')).toBe(false);
  });

  it('chunked gövde de denetlenir', () => {
    let status = 0;
    let passed = false;
    contentTypeGuard(
      { headers: { 'transfer-encoding': 'chunked', 'content-type': 'text/plain' }, originalUrl: '/v1/things' },
      { statusCode: 0, setHeader: () => undefined, end: () => (status = 415) },
      () => (passed = true),
    );
    expect([status, passed]).toEqual([415, false]);
  });
});
