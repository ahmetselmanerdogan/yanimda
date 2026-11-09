import type { ExecutionContext } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { signDeviceToken, verifyDeviceToken } from '../src/modules/device/device-token';
import { DeviceTokenGuard, SignalAuthGuard } from '../src/modules/device/device-token.guard';
import {
  type DevicePrincipal,
  ENROLL_MAX_FAILURES,
  EnrollmentService,
  etagMatches,
} from '../src/modules/device/enrollment.service';
import { simulatorEnabled } from '../src/modules/device/simulator-mode';
import { ProtectionService } from '../src/modules/event/protection.service';
import { loadRulePack, staticRules } from '../src/modules/event/rules.loader';
import { assertOwnBatch } from '../src/modules/signal/signal.controller';
import { createHarness, type Harness } from './support/harness';

/**
 * T-041 cihaz kaydı ve yapılandırma. Kabul:
 *  - yanlış kod 400
 *  - token iptali (aile "cihazı kaldır") sonrası 401
 *  - config ETag 304
 * + davet kodu 15 dk sonra geçersiz (T-040 kabulünün bu görevdeki parçası), kod düz metin saklanmaz.
 */
const SECRET = 'test-secret-0123456789abcdef0123456789';
const PERSON = '00000000-0000-0000-0000-0000000000a1';
const OTHER = '00000000-0000-0000-0000-0000000000a2';
const DEV = '7c1e3f4a-2b5d-4e6f-8a9b-0c1d2e3f4a5b';
const DEV2 = '7c1e3f4a-2b5d-4e6f-8a9b-0c1d2e3f4a5c';
const T0 = new Date('2026-11-09T09:00:00Z');
const later = (min: number) => new Date(T0.getTime() + min * 60_000);

let h: Harness;
let svc: EnrollmentService;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  await h.pg.exec(`INSERT INTO profile.protected_person (id, display_name) VALUES
    ('${PERSON}', 'A'), ('${OTHER}', 'B')`);
  svc = new EnrollmentService(
    h.db,
    h.redis as never,
    new ProtectionService(h.db, h.outbox),
    staticRules(loadRulePack()),
    SECRET,
  );
});
afterAll(async () => {
  await h.close();
});

const enrollBody = (code: string, extra: Record<string, unknown> = {}) => ({
  inviteCode: code,
  deviceId: DEV,
  kind: 'IOS_PHONE',
  model: 'iPhone17,1',
  osVersion: '26.1',
  appVersion: '0.1.0',
  ...extra,
});
const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as { status?: number }).status;
  }
};

describe('cihaz token (HS256)', () => {
  const c = { sub: DEV, pp: PERSON, kind: 'IOS_PHONE' };
  it('imzalanır ve doğrulanır; 1 yıl geçerli', () => {
    const { token, claims } = signDeviceToken(c, SECRET, T0);
    expect(claims.exp - claims.iat).toBe(365 * 24 * 3600);
    expect(verifyDeviceToken(token, SECRET, T0)).toMatchObject({ sub: DEV, pp: PERSON, typ: 'device' });
  });
  it('yanlış anahtar, değiştirilmiş gövde, süresi dolmuş, alg:none → null', () => {
    const { token } = signDeviceToken(c, SECRET, T0);
    expect(verifyDeviceToken(token, 'baska-anahtar-0123456789abcdef0123', T0)).toBeNull();
    const [hd, , sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...c, sub: DEV2, typ: 'device', exp: 9e9 })).toString('base64url');
    expect(verifyDeviceToken(`${hd}.${forged}.${sig}`, SECRET, T0)).toBeNull();
    expect(verifyDeviceToken(token, SECRET, new Date(T0.getTime() + 366 * 24 * 3600_000))).toBeNull();
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    expect(verifyDeviceToken(`${none}.${token.split('.')[1]}.`, SECRET, T0)).toBeNull();
    expect(verifyDeviceToken('abc', SECRET, T0)).toBeNull();
  });
});

describe('davet kodu', () => {
  it('6 hane, 15 dk; veritabanında düz metin yok', async () => {
    const inv = await svc.createInvite(PERSON, T0);
    expect(inv.code).toMatch(/^\d{6}$/);
    expect(inv.expiresAt).toBe(later(15).toISOString());
    const rows = await h.rows<{ code_hash: string }>('SELECT code_hash FROM profile.invite');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.code_hash).not.toContain(inv.code);
  });
  it('olmayan kişi 404', async () => {
    expect(await status(svc.createInvite('00000000-0000-0000-0000-0000000000ff', T0))).toBe(404);
    expect(await status(svc.createInvite('pp_demo', T0))).toBe(404);
  });
});

describe('POST /devices/enroll', () => {
  it('geçerli kod → cihaz kaydı + token (201); token doğrulanır', async () => {
    const { code } = await svc.createInvite(PERSON, T0);
    const r = await svc.enroll(enrollBody(code), '1.1.1.1', later(1));
    expect(r.created).toBe(true);
    expect(r.body).toMatchObject({ deviceId: DEV, protectedPersonId: PERSON });
    expect(new Date(r.body.refreshAfter) < new Date(r.body.expiresAt)).toBe(true);
    const [row] = await h.rows<Record<string, unknown>>(
      'SELECT kind, model, os_version, app_version, enrolled_at, protected_person_id::text AS pp FROM device.device',
    );
    expect(row).toMatchObject({ kind: 'IOS_PHONE', model: 'iPhone17,1', os_version: '26.1', pp: PERSON });
    expect(row!.enrolled_at).toBeTruthy();
    expect(await svc.authenticate(`Bearer ${r.body.token}`, later(2))).toEqual({
      deviceId: DEV,
      protectedPersonId: PERSON,
      kind: 'IOS_PHONE',
    });
  });

  it('yanlış kod 400 (kabul)', async () => {
    await svc.createInvite(PERSON, T0);
    expect(await status(svc.enroll(enrollBody('000000'), 'ip', later(1)))).toBe(400);
    expect(await status(svc.enroll(enrollBody('12ab56'), 'ip', later(1)))).toBe(400);
  });

  it('15 dk sonra kod geçersiz (400)', async () => {
    const { code } = await svc.createInvite(PERSON, T0);
    expect(await status(svc.enroll(enrollBody(code), 'ip', later(16)))).toBe(400);
  });

  it('tek kullanım: başka cihaz aynı kodla 400', async () => {
    const { code } = await svc.createInvite(PERSON, T0);
    await svc.enroll(enrollBody(code), 'ip', later(1));
    expect(await status(svc.enroll(enrollBody(code, { deviceId: DEV2 }), 'ip', later(2)))).toBe(400);
  });

  it('aynı cihaz aynı kodla yeniden dener (yanıt kayboldu) → 200 ve yeni token; ikinci cihaz satırı yok', async () => {
    const { code } = await svc.createInvite(PERSON, T0);
    await svc.enroll(enrollBody(code), 'ip', later(1));
    const again = await svc.enroll(enrollBody(code), 'ip', later(2));
    expect(again.created).toBe(false);
    expect(again.body.deviceId).toBe(DEV);
    expect(await h.rows('SELECT 1 FROM device.device')).toHaveLength(1);
  });

  it('kaldırılmış cihaz yeni davetle yeniden eşleşir (201); iptal öncesi token 401 kalır', async () => {
    const a = await svc.createInvite(PERSON, T0);
    const old = (await svc.enroll(enrollBody(a.code), 'ip', later(1))).body.token;
    await svc.revoke(DEV, later(2));
    const b = await svc.createInvite(OTHER, later(3));
    const r = await svc.enroll(enrollBody(b.code), 'ip', later(4));
    expect(r.created).toBe(true);
    expect(r.body.protectedPersonId).toBe(OTHER);
    expect(await status(svc.authenticate(`Bearer ${old}`, later(5)))).toBe(401);
    expect(await svc.authenticate(`Bearer ${r.body.token}`, later(5))).toMatchObject({ protectedPersonId: OTHER });
    // aynı kişiye geri eşleşse de eski token dirilmez
    await svc.revoke(DEV, later(6));
    const c = await svc.createInvite(PERSON, later(7));
    const r2 = await svc.enroll(enrollBody(c.code), 'ip', later(8));
    const forged = signDeviceToken({ sub: DEV, pp: PERSON, kind: 'IOS_PHONE' }, SECRET, later(1)).token;
    expect(await status(svc.authenticate(`Bearer ${forged}`, later(9)))).toBe(401);
    expect(await status(svc.authenticate(`Bearer ${r2.body.token}`, later(9)))).toBe('ok');
  });

  it('etkin kayıtlı cihaz kimliği yeni davetle → 409', async () => {
    const a = await svc.createInvite(PERSON, T0);
    await svc.enroll(enrollBody(a.code), 'ip', later(1));
    const b = await svc.createInvite(OTHER, later(2));
    expect(await status(svc.enroll(enrollBody(b.code), 'ip', later(3)))).toBe(409);
  });

  it('geçersiz gövde 400: SIMULATOR türü, UUID olmayan deviceId', async () => {
    const { code } = await svc.createInvite(PERSON, T0);
    expect(await status(svc.enroll(enrollBody(code, { kind: 'SIMULATOR' }), 'ip', later(1)))).toBe(400);
    expect(await status(svc.enroll(enrollBody(code, { deviceId: 'dev-1' }), 'ip', later(1)))).toBe(400);
  });

  it(`aynı IP'den ${ENROLL_MAX_FAILURES} hatalı kod → 429 (doğru kod da bekler); başka IP etkilenmez`, async () => {
    const { code } = await svc.createInvite(PERSON, T0);
    for (let i = 0; i < ENROLL_MAX_FAILURES; i++) await status(svc.enroll(enrollBody('999999'), 'kotu', later(1)));
    expect(await status(svc.enroll(enrollBody(code), 'kotu', later(1)))).toBe(429);
    expect(await status(svc.enroll(enrollBody(code), 'iyi', later(1)))).toBe('ok');
  });
});

describe('token doğrulama ve iptal', () => {
  let token: string;
  beforeEach(async () => {
    const { code } = await svc.createInvite(PERSON, T0);
    token = (await svc.enroll(enrollBody(code), 'ip', later(1))).body.token;
  });

  it('cihazı kaldır → 401 (kabul); ikinci kaldırma da 204 gibi sessiz, olmayan cihaz 404', async () => {
    await svc.revoke(DEV, later(5));
    expect(await status(svc.authenticate(`Bearer ${token}`, later(6)))).toBe(401);
    expect(await status(svc.revoke(DEV, later(7)))).toBe('ok');
    expect(await status(svc.revoke(DEV2, later(7)))).toBe(404);
  });

  it('başlık biçimi yanlış, cihaz kaydı yok, kişi uyuşmuyor → 401', async () => {
    expect(await status(svc.authenticate(token, later(2)))).toBe(401); // "Bearer " yok
    const ghost = signDeviceToken({ sub: DEV2, pp: PERSON, kind: 'IOS_PHONE' }, SECRET, later(2)).token;
    expect(await status(svc.authenticate(`Bearer ${ghost}`, later(2)))).toBe(401);
    const wrongPerson = signDeviceToken({ sub: DEV, pp: OTHER, kind: 'IOS_PHONE' }, SECRET, later(2)).token;
    expect(await status(svc.authenticate(`Bearer ${wrongPerson}`, later(2)))).toBe(401);
  });

  it('yenileme yeni ve daha geç biten token verir', async () => {
    const p = await svc.authenticate(`Bearer ${token}`, later(2));
    const r = svc.refresh(p, later(60 * 24));
    expect(r.token).not.toBe(token);
    expect(verifyDeviceToken(r.token, SECRET, later(60 * 24))!.exp).toBeGreaterThan(
      verifyDeviceToken(token, SECRET, later(2))!.exp,
    );
  });

  it('push token kaydı: APNS iOS için; kaldırınca silinir', async () => {
    const p = await svc.authenticate(`Bearer ${token}`, later(2));
    await svc.setPushToken(p, { provider: 'APNS', token: 'abc123', sandbox: true }, later(3));
    expect(await h.rows('SELECT push_provider, push_token, push_sandbox FROM device.device')).toEqual([
      { push_provider: 'APNS', push_token: 'abc123', push_sandbox: true },
    ]);
    expect(await status(svc.setPushToken(p, { provider: 'X', token: 'a' }))).toBe(400);
    expect(await status(svc.setPushToken({ ...p, kind: 'ANDROID_PHONE' }, { provider: 'APNS', token: 'a' }))).toBe(400);
    await svc.revoke(DEV, later(4));
    expect(await h.rows('SELECT push_token FROM device.device')).toEqual([{ push_token: null }]);
  });

  it('başka cihazın yolu 403', () => {
    const p: DevicePrincipal = { deviceId: DEV, protectedPersonId: PERSON, kind: 'IOS_PHONE' };
    expect(() => EnrollmentService.assertSelf(p, DEV2)).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => EnrollmentService.assertSelf(p, DEV.toUpperCase())).not.toThrow();
  });
});

describe('GET /devices/{id}/config', () => {
  const phone: DevicePrincipal = { deviceId: DEV, protectedPersonId: PERSON, kind: 'IOS_PHONE' };

  it('uyku penceresi, kural eşikleri, rol metinleri (telefon P-*, saat W-*)', async () => {
    const { body } = await svc.config(phone);
    expect(body.sleepWindow).toEqual({ timezone: 'Europe/Istanbul', start: '22:00', end: '08:00' });
    expect(body.devicePrompt).toEqual({ fallWindowSec: 60, inactivityWindowSec: 120 });
    expect(body.inactivityThresholdMin).toBe(30);
    expect(Object.keys(body.messages).every((k) => k.startsWith('P-'))).toBe(true);
    expect(body.messages['P-SOS-HOLD']).toMatchObject({ action: expect.any(String) });
    const watch = (await svc.config({ ...phone, kind: 'WEAROS_WATCH' })).body;
    expect(Object.keys(watch.messages).every((k) => k.startsWith('W-'))).toBe(true);
    expect(watch.messages['W-FALL-1']).toBeDefined();
  });

  it('ETag kararlı; If-None-Match eşleşirse 304 (kabul); eşik değişince ETag değişir', async () => {
    const a = await svc.config(phone);
    const b = await svc.config(phone);
    expect(a.etag).toBe(b.etag);
    expect(etagMatches(a.etag, a.etag)).toBe(true);
    expect(etagMatches(`W/${a.etag}, "x"`, a.etag)).toBe(true);
    expect(etagMatches('"baska"', a.etag)).toBe(false);
    expect(etagMatches(undefined, a.etag)).toBe(false);
    await h.pg.exec(
      `INSERT INTO event.threshold (protected_person_id, sleep_start, sleep_end) VALUES ('${PERSON}', '23:00', '07:00')`,
    );
    const c = await svc.config(phone);
    expect(c.body.sleepWindow).toMatchObject({ start: '23:00', end: '07:00' });
    expect(c.etag).not.toBe(a.etag);
    // T-070: kişiye özel (öğrenilmiş / aile) hareketsizlik eşiği cihaza gider, kuralın 15–90 aralığına kırpılır.
    await h.pg.exec(`UPDATE event.threshold SET inactivity_min = 45 WHERE protected_person_id = '${PERSON}'`);
    const d = await svc.config(phone);
    expect(d.body.inactivityThresholdMin).toBe(45);
    expect(d.etag).not.toBe(c.etag);
    await h.pg.exec(`UPDATE event.threshold SET inactivity_min = 200 WHERE protected_person_id = '${PERSON}'`);
    expect((await svc.config(phone)).body.inactivityThresholdMin).toBe(90);
  });
});

describe('guard: POST /signals ve cihaz uçları', () => {
  const prev = { ...process.env };
  afterEach(() => {
    process.env = { ...prev };
  });
  const ctx = (headers: Record<string, string>) => {
    const req: { headers: Record<string, string>; device?: DevicePrincipal } = { headers };
    return {
      req,
      ctx: { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext,
    };
  };
  let token: string;
  beforeEach(async () => {
    const { code } = await svc.createInvite(PERSON, new Date());
    token = (await svc.enroll(enrollBody(code), 'ip')).body.token;
  });

  it("simülatör açıkken token'sız sinyal geçer; kapalıyken 401", async () => {
    const g = new SignalAuthGuard(svc);
    process.env.SIMULATOR_ENABLED = 'true';
    expect(await g.canActivate(ctx({}).ctx)).toBe(true);
    process.env.SIMULATOR_ENABLED = 'false';
    expect(await status(g.canActivate(ctx({}).ctx))).toBe(401);
  });

  it('geçersiz token simülatör açık olsa da 401; geçerli token principal doldurur', async () => {
    process.env.SIMULATOR_ENABLED = 'true';
    const g = new SignalAuthGuard(svc);
    expect(await status(g.canActivate(ctx({ authorization: 'Bearer dev-token' }).ctx))).toBe(401);
    const ok = ctx({ authorization: `Bearer ${token}` });
    expect(await g.canActivate(ok.ctx)).toBe(true);
    expect(ok.req.device).toMatchObject({ deviceId: DEV, protectedPersonId: PERSON });
  });

  it("simülatör açıkken de kayıtlı veya kaldırılmış cihaz adına token'sız sinyal 401; tohum cihazı geçer", async () => {
    process.env.SIMULATOR_ENABLED = 'true';
    const g = new SignalAuthGuard(svc);
    const withBody = (deviceId: string) => {
      const c = ctx({});
      (c.req as { body?: unknown }).body = [{ deviceId, protectedPersonId: PERSON }];
      return c.ctx;
    };
    expect(await status(g.canActivate(withBody(DEV)))).toBe(401); // kayıtlı (enrolled_at dolu)
    await svc.revoke(DEV);
    expect(await status(g.canActivate(withBody(DEV)))).toBe(401); // kaldırılmış
    await h.pg.exec(
      `INSERT INTO device.device (id, protected_person_id, kind) VALUES ('${DEV2}', '${PERSON}', 'WEAROS_WATCH')`,
    );
    expect(await g.canActivate(withBody(DEV2))).toBe(true); // tohum/simülatör cihazı (packages/simulator)
    expect(await g.canActivate(withBody('sim-1'))).toBe(true); // kayıtsız
  });

  it("DeviceTokenGuard token'sız 401", async () => {
    expect(await status(new DeviceTokenGuard(svc).canActivate(ctx({}).ctx))).toBe(401);
  });

  it('token sahibi başka cihaz/kişi adına sinyal gönderemez (403); kendi adına geçer', () => {
    const p: DevicePrincipal = { deviceId: DEV, protectedPersonId: PERSON, kind: 'IOS_PHONE' };
    expect(() => assertOwnBatch(p, [{ deviceId: DEV, protectedPersonId: PERSON }])).not.toThrow();
    expect(() => assertOwnBatch(p, [{ deviceId: DEV2, protectedPersonId: PERSON }])).toThrow(
      expect.objectContaining({ status: 403 }),
    );
    expect(() =>
      assertOwnBatch(p, [
        { deviceId: DEV, protectedPersonId: PERSON },
        { deviceId: DEV, protectedPersonId: OTHER },
      ]),
    ).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => assertOwnBatch(undefined, [{ deviceId: 'x' }])).not.toThrow(); // simülatör yolu
  });

  it('SIMULATOR_ENABLED boş değer tanımsız sayılır (.env.example)', () => {
    expect(simulatorEnabled({ SIMULATOR_ENABLED: '', NODE_ENV: 'development' })).toBe(true);
    expect(simulatorEnabled({ SIMULATOR_ENABLED: '', NODE_ENV: 'production' })).toBe(false);
    expect(simulatorEnabled({ SIMULATOR_ENABLED: 'false', NODE_ENV: 'development' })).toBe(false);
  });
});
