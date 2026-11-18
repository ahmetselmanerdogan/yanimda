import { Body, Controller, HttpCode, Module, Post } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { NestFactory } from '@nestjs/core';
import { t } from '@yanimda/messages';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { configureHttpSecurity } from '../src/common/http-security';
import { bodyValidator, jsonBodyOperations, OpenApiBody, validateBody } from '../src/common/openapi-body';
import { ProblemFilter } from '../src/common/problem.filter';
import { ChainController } from '../src/modules/chain/chain.controller';
import { FamilyMembersController, ProfileController } from '../src/modules/profile/profile.controller';

/**
 * T-081 (ASVS 5.1.4, 13.2.2): ana yazma uçlarının istek gövdesi OpenAPI şemasıyla (packages/contracts/openapi.yaml)
 * doğrulanır; şemaya uymayan gövde servise ulaşmadan 400, hata ayrıntısında değer yok.
 */
describe('OpenAPI gövde doğrulaması', () => {
  it('sözleşmedeki tüm JSON gövdeli işlemlerin şeması derlenir (sinyal şeması dış $ref dahil)', () => {
    const ops = jsonBodyOperations();
    expect(ops.length).toBeGreaterThan(30);
    for (const op of ops) expect(() => bodyValidator(op), op).not.toThrow();
    expect(bodyValidator('postSignals').validate([{ schemaVersion: 2 }])).toBe(false);
  });

  it('requestBodies $ref (CheckoutInput) çözülür', () => {
    expect(jsonBodyOperations()).toEqual(
      expect.arrayContaining(['createSignupCheckout', 'createSubscriptionCheckout']),
    );
    const v = bodyValidator('createSignupCheckout').validate;
    expect(v({})).toBe(true);
    expect(v({ billing: { city: 'İstanbul', address: 'Moda Cd. 1' } })).toBe(true);
    expect(v({ billing: { city: 'İstanbul' } })).toBe(false);
  });

  it('validateBody (imza sonrası webhook doğrulaması) pipe ile aynı katalog kodu', () => {
    expect(validateBody('partnerWebhook', { events: [] })).toEqual({ events: [] });
    let err: unknown;
    try {
      validateBody('partnerWebhook', [{ id: 'x' }]);
    } catch (e) {
      err = e;
    }
    expect((err as { getStatus(): number }).getStatus()).toBe(400);
    expect((err as { getResponse(): { code: string } }).getResponse().code).toBe('A-ERR-BODY-SCHEMA');
  });

  it('istemcilerin gerçekten gönderdiği gövdeler geçer (sunucuyla aynı gevşeklik)', () => {
    const ok = (op: string, body: unknown) => expect(bodyValidator(op).validate(body), op).toBe(true);
    // aile web: Türkçe karakterli e-posta (sunucu EMAIL deseni kabul ediyor; Ajv `format: email` reddederdi)
    ok('signup', {
      plan: 'STANDARD',
      country: 'TR',
      account: { firstName: 'Çağrı', lastName: 'Öz', email: 'çağrı@şirket.com.tr', phone: '+905551112233' },
      protectedPerson: { displayName: 'Anne' },
      consents: { kvkkNoticeVersion: 'v1', explicitConsent: true },
    });
    ok('updateDispatch', { source: 'OPERATOR', caseRef: null, hospital: null, etaMin: null, note: null });
    ok('createVendorLink', {
      protectedPersonId: '0190a8e2-7c1d-7000-8000-000000000001',
      partner: 'FAKE_PENDANT',
      model: 'FAKE_PENDANT_CELL',
      vendorDeviceId: 'FP-0001',
      bodyLocation: null,
      consent: null,
    });
    // konsol: PushSubscription.toJSON() expirationTime taşır
    ok('webPushSubscribe', {
      endpoint: 'https://push.example/x',
      expirationTime: null,
      keys: { p256dh: 'a', auth: 'b' },
    });
    // Android: tüm alanlar dolu kurulum durumu
    ok('putSetupState', { step: 'BATTERY', completed: false, missing: ['BATTERY', 'WATCH'], watchPaired: true });
    ok('chargingIntent', {});
    // telefon: kopyala-yapıştır boşluklu davet kodu (servis kırpar; şema önce reddetmemeli)
    const enroll = { deviceId: '0190a8e2-7c1d-7000-8000-000000000002', kind: 'ANDROID_PHONE' };
    ok('enrollDevice', { ...enroll, inviteCode: ' 123456 ' });
    ok('enrollDevice', { ...enroll, inviteCode: '123456\n' });
    expect(bodyValidator('enrollDevice').validate({ ...enroll, inviteCode: '12 3456' })).toBe(false);
    expect(bodyValidator('enrollDevice').validate({ ...enroll, inviteCode: '12345' })).toBe(false);
  });

  it('bilinmeyen operationId açılışta hata', () => {
    expect(() => new OpenApiBody('yokBoyleBirIslem')).toThrow(/yokBoyleBirIslem/);
  });

  it('ana yazma uçları şemaya bağlı (profil, tıbbi özet, rehber, üyelik, zincir sonucu, 112, kapatma)', () => {
    const opsOf = (cls: object, method: string) =>
      Object.values(
        (Reflect.getMetadata(ROUTE_ARGS_METADATA, cls, method) ?? {}) as Record<string, { pipes?: unknown[] }>,
      )
        .flatMap((a) => a.pipes ?? [])
        .filter((p): p is OpenApiBody => p instanceof OpenApiBody)
        .map((p) => p.operationId);
    expect(opsOf(ProfileController, 'create')).toEqual(['createProtectedPerson']);
    expect(opsOf(ProfileController, 'update')).toEqual(['updateProtectedPerson']);
    expect(opsOf(ProfileController, 'medical')).toEqual(['setMedical']);
    expect(opsOf(ProfileController, 'contacts')).toEqual(['setContacts']);
    expect(opsOf(ProfileController, 'memberInvite')).toEqual(['createMemberInvite']);
    expect(opsOf(FamilyMembersController, 'accept')).toEqual(['acceptMemberInvite']);
    expect(opsOf(ChainController, 'result')).toEqual(['stepResult']);
    expect(opsOf(ChainController, 'escalate')).toEqual(['escalate112']);
    expect(opsOf(ChainController, 'close')).toEqual(['closeEvent']);
  });
});

const got: unknown[] = [];
@Controller()
class Probe {
  @Post('close')
  @HttpCode(204)
  close(@Body(new OpenApiBody('closeEvent')) body: unknown) {
    got.push(body);
  }
  @Post('contacts')
  @HttpCode(204)
  contacts(@Body(new OpenApiBody('setContacts')) body: unknown) {
    got.push(body);
  }
  @Post('invite')
  @HttpCode(204)
  invite(@Body(new OpenApiBody('createMemberInvite')) body: unknown) {
    got.push(body ?? 'yok');
  }
}
@Controller()
class DeviceProbe {
  @Post('device')
  @HttpCode(204)
  patch(@Body(new OpenApiBody('patchDevice')) body: unknown) {
    got.push(body);
  }
  @Post('auto-assign')
  @HttpCode(204)
  autoAssign(@Body(new OpenApiBody('setAutoAssign')) body: unknown) {
    got.push(body);
  }
  @Post('enroll')
  @HttpCode(204)
  enroll(@Body(new OpenApiBody('enrollDevice')) body: unknown) {
    got.push(body);
  }
  @Post('checkout')
  @HttpCode(204)
  checkout(@Body(new OpenApiBody('createSignupCheckout')) body: unknown) {
    got.push(body ?? 'yok');
  }
}
@Module({ controllers: [Probe, DeviceProbe] })
class ProbeModule {}

describe('OpenAPI gövde doğrulaması (HTTP)', () => {
  let base: string;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const app = await NestFactory.create(ProbeModule, { logger: false, rawBody: true });
    configureHttpSecurity(app, {});
    app.setGlobalPrefix('v1');
    app.useGlobalFilters(new ProblemFilter());
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/v1`.replace('[::1]', '127.0.0.1');
    close = () => app.close();
  });
  afterAll(async () => {
    await close();
  });
  const post = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('geçerli gövde servise ulaşır', async () => {
    got.length = 0;
    expect((await post('/close', { outcome: 'EMERGENCY', note: '112 arandı', notified112: true })).status).toBe(204);
    expect((await post('/contacts', [{ role: 'CONTACT', priority: 1, phone: '+905551112233' }])).status).toBe(204);
    expect((await post('/invite')).status).toBe(204); // zorunlu olmayan gövde yok → servis karar verir
    expect(got).toHaveLength(3);
  });

  it('şemaya uymayan gövde 400; ayrıntı alan yolu + kural, değer yok; servise ulaşmaz', async () => {
    got.length = 0;
    const cases: [string, unknown, RegExp][] = [
      ['/close', { outcome: 'BELKI' }, /\/outcome enum/],
      ['/close', { note: 'x' }, /required\(outcome\)/],
      ['/close', { outcome: 'OK', followUpAfterHours: 9999 }, /\/followUpAfterHours maximum/],
      ['/contacts', [{ role: 'CONTACT', phone: '05551112233' }], /\/0\/phone pattern/],
      ['/contacts', { role: 'CONTACT' }, /\/ type/],
      ['/invite', { relation: 'x'.repeat(51) }, /\/relation maxLength/],
    ];
    for (const [path, body, re] of cases) {
      const r = await post(path, body);
      expect(r.status, path).toBe(400);
      const p = (await r.json()) as { detail: string };
      expect(p.detail).toMatch(re);
      expect(p.detail).not.toContain('05551112233');
      expect(p.detail).not.toContain('BELKI');
    }
    expect(got).toEqual([]);
  });

  it('temsilî 400’ler: bilinmeyen alan / yanlış tür / eksik zorunlu alan / boş zorunlu gövde → A-ERR-BODY-SCHEMA', async () => {
    got.length = 0;
    const enroll = { inviteCode: '123456', deviceId: '0190a8e2-7c1d-7000-8000-000000000001', kind: 'ANDROID_PHONE' };
    const cases: [string, unknown, RegExp][] = [
      ['/device', { nickname: 'Saat', isAdmin: true }, /\/ additionalProperties/],
      ['/device', {}, /\/ minProperties/],
      ['/auto-assign', { enabled: 'evet' }, /\/enabled type/],
      ['/auto-assign', undefined, /\/ type/],
      ['/enroll', { inviteCode: '123456', kind: 'ANDROID_PHONE' }, /required\(deviceId\)/],
      ['/enroll', { ...enroll, deviceId: 'dev-1' }, /\/deviceId format/],
      ['/enroll', { ...enroll, inviteCode: '12345' }, /\/inviteCode pattern/],
      ['/checkout', { billing: { city: 'İzmir' } }, /\/billing required\(address\)/],
    ];
    for (const [path, body, re] of cases) {
      const r = await post(path, body);
      expect(r.status, `${path} ${JSON.stringify(body)}`).toBe(400);
      const p = (await r.json()) as { code: string; detail: string };
      expect(p.code).toBe('A-ERR-BODY-SCHEMA');
      expect(p.detail).toMatch(re);
      expect(p.detail).not.toContain('dev-1');
    }
    expect(got).toEqual([]);
    expect((await post('/device', { nickname: null, voiceOrder: 2 })).status).toBe(204);
    expect((await post('/enroll', enroll)).status).toBe(204);
    expect((await post('/checkout')).status).toBe(204);
    expect(got).toHaveLength(3);
  });

  it('JSON olmayan gövde katalog kodlu 400 (A-ERR-BODY-NOT-JSON)', async () => {
    const r = await fetch(`${base}/device`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"nickname": "+905551112233" x',
    });
    expect(r.status).toBe(400);
    const p = (await r.json()) as { code: string; detail: string };
    expect(p.code).toBe('A-ERR-BODY-NOT-JSON');
    expect(p.detail).toBe(t('A-ERR-BODY-NOT-JSON', 'tr')); // ayrıştırıcı iletisi (gövde parçası) dışarı çıkmaz
    expect(JSON.stringify(p)).not.toContain('905551112233');
  });
});
