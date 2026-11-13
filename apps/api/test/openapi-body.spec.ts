import { Body, Controller, HttpCode, Module, Post } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { configureHttpSecurity } from '../src/common/http-security';
import { bodyValidator, jsonBodyOperations, OpenApiBody } from '../src/common/openapi-body';
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
@Module({ controllers: [Probe] })
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
});
