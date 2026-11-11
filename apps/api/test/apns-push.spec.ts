import { generateKeyPairSync, verify } from 'node:crypto';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ApnsClient,
  apnsConfigFromEnv,
  type ApnsRequest,
  type ApnsTransport,
  Http2Transport,
  providerToken,
} from '../src/modules/device/apns/apns-client';
import { DevicePush } from '../src/modules/device/device-push';
import { RecordingPush } from '../src/modules/device/push.port';
import { PushWakeService } from '../src/modules/device/push-wake.service';
import { createHarness, type Harness } from './support/harness';

/**
 * T-053 (cihaz tarafı) APNs ve T-073 iPhone uyandırma. Kabul (bu kapsam):
 *  - sağlayıcı token'ı ES256, Apple'ın beklediği başlık/gövde; 50 dk önbellek
 *  - sessiz push: apns-push-type background, öncelik 5, content-available; sandbox/üretim ayrımı
 *  - geçersiz token cihaz kaydından silinir; 429/5xx yeniden denenebilir
 *  - yalnız sessiz kalmış, kaldırılmamış, APNs token'lı iPhone'lar uyandırılır
 */
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const CFG = { keyId: 'KEY1234567', teamId: 'TEAM123456', privateKey: PEM, topic: 'app.yanimda.companion' };
const T0 = new Date('2026-11-09T09:00:00Z');

class FakeTransport implements ApnsTransport {
  calls: { origin: string; path: string; headers: Record<string, string>; body: unknown }[] = [];
  constructor(public reply: { status: number; body: string } | Error = { status: 200, body: '' }) {}
  async post(origin: string, path: string, headers: Record<string, string>, body: string) {
    this.calls.push({ origin, path, headers, body: JSON.parse(body) });
    if (this.reply instanceof Error) throw this.reply;
    return this.reply;
  }
  close() {}
}

const wake = (over: Partial<ApnsRequest> = {}): ApnsRequest => ({
  token: 'abc123',
  sandbox: false,
  pushType: 'background',
  priority: 5,
  expiration: 1,
  payload: { aps: { 'content-available': 1 } },
  ...over,
});

describe("APNs sağlayıcı token'ı", () => {
  it('ES256: başlık {alg, kid}, gövde {iss, iat}, imza açık anahtarla doğrulanır', () => {
    const jwt = providerToken(CFG, T0);
    const [h, p, s] = jwt.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'ES256', kid: CFG.keyId });
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toEqual({ iss: CFG.teamId, iat: T0.getTime() / 1000 });
    const ok = verify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(s, 'base64url'),
    );
    expect(ok).toBe(true);
  });

  it('ortamdan yapılandırma: eksikse null, kaçışlı PEM açılır, konu varsayılanı', () => {
    expect(apnsConfigFromEnv({})).toBeNull();
    const c = apnsConfigFromEnv({ APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T', APNS_PRIVATE_KEY: PEM.replace(/\n/g, '\\n') });
    expect(c).toMatchObject({ keyId: 'K', teamId: 'T', topic: 'app.yanimda.companion' });
    expect(c!.privateKey).toBe(PEM);
  });
});

describe('ApnsClient', () => {
  it('sessiz push başlıkları ve yolu; sandbox ayrı sunucuya gider', async () => {
    const tr = new FakeTransport();
    const c = new ApnsClient(CFG, tr, { production: 'https://prod', sandbox: 'https://sandbox' }, () => T0);
    expect(await c.send(wake({ collapseId: 'wake' }))).toEqual({ status: 'ok' });
    await c.send(wake({ sandbox: true }));
    expect(tr.calls[0]).toMatchObject({
      origin: 'https://prod',
      path: '/3/device/abc123',
      headers: {
        'apns-topic': 'app.yanimda.companion',
        'apns-push-type': 'background',
        'apns-priority': '5',
        'apns-expiration': '1',
        'apns-collapse-id': 'wake',
      },
      body: { aps: { 'content-available': 1 } },
    });
    expect(tr.calls[0]!.headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(tr.calls[1]!.origin).toBe('https://sandbox');
  });

  it("sağlayıcı token'ı 50 dk yeniden kullanılır, sonra yenilenir", async () => {
    const tr = new FakeTransport();
    let now = T0;
    const c = new ApnsClient(CFG, tr, undefined, () => now);
    await c.send(wake());
    now = new Date(T0.getTime() + 49 * 60_000);
    await c.send(wake());
    now = new Date(T0.getTime() + 51 * 60_000);
    await c.send(wake());
    const auth = tr.calls.map((x) => x.headers.authorization);
    expect(auth[0]).toBe(auth[1]);
    expect(auth[2]).not.toBe(auth[1]);
  });

  it.each([
    [410, '{"reason":"Unregistered"}', 'invalid-token'],
    [400, '{"reason":"BadDeviceToken"}', 'invalid-token'],
    [400, '{"reason":"DeviceTokenNotForTopic"}', 'invalid-token'],
    [429, '{"reason":"TooManyRequests"}', 'retry'],
    [503, '', 'retry'],
    [403, '{"reason":"ExpiredProviderToken"}', 'retry'],
    [400, '{"reason":"BadPriority"}', 'error'],
  ])('HTTP %i %s → %s', async (status, body, expected) => {
    const c = new ApnsClient(CFG, new FakeTransport({ status, body }));
    expect((await c.send(wake())).status).toBe(expected);
  });

  it('ağ hatası → retry', async () => {
    const c = new ApnsClient(CFG, new FakeTransport(new Error('ECONNRESET')));
    expect(await c.send(wake())).toEqual({ status: 'retry', reason: 'ECONNRESET' });
  });
});

describe('Http2Transport (gerçek HTTP/2, yerel h2c sunucu)', () => {
  let server: http2.Http2Server;
  let origin: string;
  const seen: { headers: http2.IncomingHttpHeaders; body: string }[] = [];
  beforeAll(async () => {
    server = http2.createServer();
    server.on('stream', (stream, headers) => {
      let body = '';
      stream.on('data', (c) => (body += c));
      stream.on('end', () => {
        seen.push({ headers, body });
        if (String(headers[':path']).endsWith('/gone')) {
          stream.respond({ ':status': 410, 'content-type': 'application/json' });
          stream.end('{"reason":"Unregistered"}');
        } else {
          stream.respond({ ':status': 200, 'apns-id': 'x' });
          stream.end();
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('aynı oturum üzerinden istek/yanıt; 410 gövdesi okunur', async () => {
    const tr = new Http2Transport(2000);
    const c = new ApnsClient(CFG, tr, { production: origin, sandbox: origin });
    expect(await c.send(wake({ token: 'ok' }))).toEqual({ status: 'ok' });
    expect(await c.send(wake({ token: 'gone' }))).toEqual({ status: 'invalid-token', reason: 'Unregistered' });
    tr.close();
    expect(seen[0]!.headers[':method']).toBe('POST');
    expect(seen[0]!.headers['apns-push-type']).toBe('background');
    expect(JSON.parse(seen[0]!.body)).toEqual({ aps: { 'content-available': 1 } });
  });
});

const PERSON = '00000000-0000-0000-0000-0000000000b1';
const IOS = '00000000-0000-0000-0000-00000000e001';
const IOS_FRESH = '00000000-0000-0000-0000-00000000e002';
const IOS_REVOKED = '00000000-0000-0000-0000-00000000e003';
const IOS_NOTOKEN = '00000000-0000-0000-0000-00000000e004';
const ANDROID = '00000000-0000-0000-0000-00000000e005';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
  const ago = (min: number) => new Date(T0.getTime() - min * 60_000).toISOString();
  await h.pg.exec(`
    INSERT INTO profile.protected_person (id, display_name) VALUES ('${PERSON}', 'A');
    INSERT INTO device.device (id, protected_person_id, kind, push_provider, push_token, push_sandbox, last_seen_at, revoked_at) VALUES
      ('${IOS}', '${PERSON}', 'IOS_PHONE', 'APNS', 'tok-ios', true, '${ago(30)}', NULL),
      ('${IOS_FRESH}', '${PERSON}', 'IOS_PHONE', 'APNS', 'tok-fresh', false, '${ago(2)}', NULL),
      ('${IOS_REVOKED}', '${PERSON}', 'IOS_PHONE', 'APNS', 'tok-rev', false, '${ago(60)}', '${ago(5)}'),
      ('${IOS_NOTOKEN}', '${PERSON}', 'IOS_PHONE', NULL, NULL, NULL, NULL, NULL),
      ('${ANDROID}', '${PERSON}', 'ANDROID_PHONE', 'FCM', 'tok-fcm', NULL, '${ago(60)}', NULL)`);
});

describe("DevicePush (cihaz token'ına göre yönlendirme)", () => {
  it('APNs cihazına sessiz push: token ve sandbox kayıttan, collapse-id wake', async () => {
    const tr = new FakeTransport();
    const push = new DevicePush(h.db, new ApnsClient(CFG, tr), () => T0);
    expect(await push.deliver({ deviceId: IOS, priority: 'normal', data: { type: 'WAKE' }, ttlSec: 900 })).toBe('sent');
    expect(tr.calls[0]).toMatchObject({
      origin: 'https://api.sandbox.push.apple.com',
      path: '/3/device/tok-ios',
      headers: { 'apns-push-type': 'background', 'apns-priority': '5', 'apns-collapse-id': 'wake' },
      body: { aps: { 'content-available': 1 }, type: 'WAKE' },
    });
    expect(tr.calls[0]!.headers['apns-expiration']).toBe(String(T0.getTime() / 1000 + 900));
  });

  it('soru: "İyiyim" kategorili uyarı, metin katalogdan', async () => {
    const tr = new FakeTransport();
    const push = new DevicePush(h.db, new ApnsClient(CFG, tr), () => T0);
    await push.send({
      deviceId: IOS,
      priority: 'normal',
      data: { type: 'PROMPT', eventId: 'ev1', tts: 'W-INACT-1', windowSec: '120', silent: 'true' },
      ttlSec: 120,
    });
    expect(tr.calls[0]).toMatchObject({
      headers: { 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-collapse-id': 'ev1' },
      body: { aps: { alert: { body: 'İyi misiniz? Dokunun.' }, category: 'yanimda.inactivity' }, type: 'PROMPT' },
    });
  });

  it('düşme sorusu telefonda telefon metniyle (P-FALL-PROMPT); tür ve mutlak bitiş yükte', async () => {
    const tr = new FakeTransport();
    const push = new DevicePush(h.db, new ApnsClient(CFG, tr), () => T0);
    const until = new Date(T0.getTime() + 30_000).toISOString();
    await push.send({
      deviceId: IOS,
      priority: 'normal',
      data: { type: 'PROMPT', eventId: 'ev2', kind: 'FALL', tts: 'W-FALL-1', windowSec: '30', until, silent: 'false' },
      ttlSec: 30,
    });
    expect(tr.calls[0]).toMatchObject({
      body: {
        aps: { alert: { body: 'Düşme algılandı. İyi misiniz?' }, category: 'yanimda.inactivity' },
        type: 'PROMPT',
        eventId: 'ev2',
        kind: 'FALL',
        until,
      },
    });
  });

  it('geçersiz token cihaz kaydından silinir', async () => {
    const push = new DevicePush(
      h.db,
      new ApnsClient(CFG, new FakeTransport({ status: 410, body: '{"reason":"Unregistered"}' })),
    );
    expect(await push.deliver({ deviceId: IOS, priority: 'normal', data: { type: 'WAKE' }, ttlSec: 60 })).toBe(
      'invalid-token',
    );
    expect(await h.rows(`SELECT push_token FROM device.device WHERE id = '${IOS}'`)).toEqual([{ push_token: null }]);
  });

  it('token yok → gönderilmez; APNs yapılandırılmamış veya FCM → kaydedilir', async () => {
    const tr = new FakeTransport();
    const push = new DevicePush(h.db, new ApnsClient(CFG, tr));
    expect(await push.deliver({ deviceId: IOS_NOTOKEN, priority: 'normal', data: { type: 'WAKE' }, ttlSec: 60 })).toBe(
      'no-token',
    );
    expect(await push.deliver({ deviceId: ANDROID, priority: 'high', data: { type: 'RING' }, ttlSec: 30 })).toBe(
      'unconfigured',
    );
    const dev = new DevicePush(h.db, null);
    expect(await dev.deliver({ deviceId: IOS, priority: 'normal', data: { type: 'WAKE' }, ttlSec: 60 })).toBe(
      'unconfigured',
    );
    expect(dev.recorded.sent).toHaveLength(1);
    expect(tr.calls).toHaveLength(0);
  });
});

describe('PushWakeService', () => {
  it("yalnız sessiz kalmış (10 dk+), kaldırılmamış, APNs token'lı iPhone uyandırılır", async () => {
    const push = new RecordingPush();
    const n = await new PushWakeService(h.db, push).wakeStale(T0, 15 * 60_000);
    expect(n).toBe(1);
    expect(push.sent).toEqual([{ deviceId: IOS, priority: 'normal', data: { type: 'WAKE' }, ttlSec: 900 }]);
  });

  it('hiç görülmemiş iPhone da uyandırılır', async () => {
    await h.pg.exec(`UPDATE device.device SET last_seen_at = NULL WHERE id = '${IOS_FRESH}'`);
    const push = new RecordingPush();
    await new PushWakeService(h.db, push).wakeStale(T0);
    expect(push.sent.map((m) => m.deviceId).sort()).toEqual([IOS, IOS_FRESH]);
  });
});
