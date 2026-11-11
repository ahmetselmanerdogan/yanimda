import { generateKeyPairSync } from 'node:crypto';

import { Logger } from '@nestjs/common';
import type { EventState, EventType, KafkaEnvelope, Signal } from '@yanimda/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { bus } from '../src/common/bus';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { DevicePush } from '../src/modules/device/device-push';
import { RecordingPush } from '../src/modules/device/push.port';
import { FcmClient, type FcmMessage, type FcmResult } from '../src/modules/notify/fcm-client';
import { NotifyService } from '../src/modules/notify/notify.service';
import { deliveryFor, familyNoticeFor } from '../src/modules/notify/policy';
import { FakeProvider } from '../src/modules/telephony/fake-cpaas';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * T-053 (D-08) bildirimler. Kabul:
 *  - her olay geçişi için beklenen bildirim kodu (tablo testi)
 *  - FCM hatasında SMS gönderilir
 *  - PII log'da yok
 * Ek: acilde push + SMS + sesli paralel; bilgi bildiriminde push, 10 sn teslim yoksa SMS; tekrar teslimde tek gönderim.
 */
const PERSON = '0190b000-0000-7000-8000-0000000000aa';
const NAME = 'Fatma Kaya';
const PHONES = { kizi: '+905550000021', oglu: '+905550000022' };
const TOKEN = 'fcm-token-'.padEnd(40, 'x');

class FakeFcm {
  readonly sent: FcmMessage[] = [];
  next: FcmResult['status'] = 'ok';
  async send(m: FcmMessage): Promise<FcmResult> {
    this.sent.push(m);
    if (this.next === 'ok') return { status: 'ok', id: `projects/p/messages/${this.sent.length}` };
    return { status: this.next, reason: this.next === 'invalid-token' ? 'UNREGISTERED' : 'UNAVAILABLE' } as FcmResult;
  }
}

let h: Harness;
let fcm: FakeFcm;
let cpaas: FakeProvider;
let devicePush: RecordingPush;
let notify: NotifyService;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  await h.pg.exec(`
    INSERT INTO profile.protected_person (id, display_name, address_line, district, city)
      VALUES ('${PERSON}', '${NAME}', 'Bağdat Cd. 1', 'Kadıköy', 'İstanbul');
    INSERT INTO profile.family_member (id, protected_person_id, subject, role)
      VALUES ('0190b000-0000-7000-8000-0000000000f1', '${PERSON}', 'fam-1', 'OWNER');
    INSERT INTO notify.push_target (id, subject, platform, token)
      VALUES ('0190b000-0000-7000-8000-0000000000b1', 'fam-1', 'FCM', '${TOKEN}');
    INSERT INTO profile.contact (id, protected_person_id, role, priority, phone_e164) VALUES
      ('0190b000-0000-7000-8000-0000000000c1', '${PERSON}', 'CONTACT', 1, '${PHONES.kizi}'),
      ('0190b000-0000-7000-8000-0000000000c2', '${PERSON}', 'CONTACT', 2, '${PHONES.oglu}'),
      ('0190b000-0000-7000-8000-0000000000c3', '${PERSON}', 'NEIGHBOR', 1, '+905550000039');
  `);
  fcm = new FakeFcm();
  cpaas = new FakeProvider({ stepMs: 1, talkMs: 1, transport: async () => undefined });
  devicePush = new RecordingPush();
  notify = new NotifyService(h.db, devicePush, fcm, cpaas, { NOTIFY_SWEEP_MS: '0' });
  notify.subscribe();
});
afterEach(async () => {
  await notify.settled();
  notify.onModuleDestroy();
});
afterAll(async () => {
  await h.close();
});

const rows = () =>
  h.rows<{ code: string; channel: string; status: string; recipient_id: string; error: string | null }>(
    'SELECT code, channel, status, recipient_id, error FROM notify.notification ORDER BY channel, recipient_id',
  );
const req = (code: string, audience: 'ELDER' | 'FAMILY' = 'FAMILY', key = `k:${code}`) => ({
  code,
  audience,
  protectedPersonId: PERSON,
  dedupeKey: key,
});

describe('kural tablosu (geçiş → aile bildirim kodu)', () => {
  const ev = (type: EventType, extra: Partial<{ isTest: boolean; confirmedOutcome: string }> = {}) => ({
    id: 'e',
    type,
    isTest: false,
    confirmedOutcome: null,
    ...extra,
  });
  const T = (from: EventState | undefined, to: EventState) => ({ from, to });
  it.each([
    ['FALL', T('ESCALATED', 'OPERATOR_QUEUE'), {}, 'F-EVT-FALL'],
    ['SOS', T('CREATED', 'OPERATOR_QUEUE'), {}, 'F-EVT-SOS'],
    ['SOS', T(undefined, 'OPERATOR_QUEUE'), {}, 'F-EVT-SOS'],
    ['WATCH_OFF', T('CREATED', 'OPERATOR_QUEUE'), {}, 'F-WATCH-OFF-4H'],
    ['CONNECTION_LOST', T('CREATED', 'OPERATOR_QUEUE'), {}, 'F-CONN-LOST'],
    ['INACTIVITY', T('ESCALATED', 'OPERATOR_QUEUE'), {}, null],
    ['FALL', T('OPERATOR_ASSIGNED', 'OPERATOR_QUEUE'), {}, null], // kilit düştü: aile zaten biliyor
    ['FALL', T('CONTACT_CHAIN', 'OPERATOR_QUEUE'), {}, null], // amir geri aldı
    ['FALL', T('CONFIRMED_EMERGENCY', 'DISPATCH'), {}, 'F-EVT-112'],
    ['SOS', T('CONTACT_CHAIN', 'DISPATCH'), {}, 'F-EVT-112'],
    ['FALL', T('CANCELLED_BY_USER', 'CLOSED'), {}, 'F-EVT-OK'],
    ['SOS', T('CANCELLED_BY_USER', 'CLOSED'), {}, 'F-EVT-OK'],
    ['INACTIVITY', T('CANCELLED_BY_USER', 'CLOSED'), {}, null],
    ['FOLLOW_UP', T('CONFIRMED_OK', 'CLOSED'), { confirmedOutcome: 'OK' }, 'F-FOLLOWUP'],
    ['FOLLOW_UP', T('CONTACT_CHAIN', 'CLOSED'), { confirmedOutcome: 'UNREACHABLE' }, null],
    ['FALL', T('CONFIRMED_OK', 'CLOSED'), { confirmedOutcome: 'OK' }, null],
    ['FALL', T('DEVICE_PROMPT', 'ESCALATED'), {}, null],
    // T-063 test olayı: yalnız test kodları, acil bildirim yok
    ['TEST', T('CREATED', 'OPERATOR_QUEUE'), { isTest: true }, 'F-TEST-QUEUED'],
    ['TEST', T('OPERATOR_ASSIGNED', 'OPERATOR_QUEUE'), { isTest: true }, null],
    ['TEST', T('CONTACT_CHAIN', 'CLOSED'), { isTest: true, confirmedOutcome: 'TEST' }, 'F-TEST-DONE'],
    ['TEST', T('CONTACT_CHAIN', 'DISPATCH'), { isTest: true }, null],
  ] as const)('%s %j %j → %s', (type, t, extra, code) => {
    expect(familyNoticeFor(ev(type, extra), t)).toBe(code);
  });

  it('teslim biçimi: acil paralel, bilgi 10 sn yedekli, akış yalnız push', () => {
    expect(deliveryFor('F-EVT-FALL')).toMatchObject({ urgency: 'URGENT', parallelSmsVoice: true });
    expect(deliveryFor('F-EVT-112')).toMatchObject({ urgency: 'URGENT', parallelSmsVoice: true });
    expect(deliveryFor('F-BAT-10')).toMatchObject({ urgency: 'INFO', smsFallbackSec: 10 });
    expect(deliveryFor('F-EVT-OK')).toMatchObject({ urgency: 'INFO', smsFallbackSec: null });
  });
});

describe('uçtan uca: olay geçişi → aile', () => {
  it('SOS kuyruğa düşünce: push + tüm yakınlara SMS + ilk yakına sesli; metin katalogdan, ad profilden', async () => {
    const events = h.events(new InMemoryTimers());
    await bus.deliver<Signal>('signal.received', {
      payload: sig('SOS', { protectedPersonId: PERSON }),
    } as unknown as KafkaEnvelope<Signal>);
    await h.worker().drain(); // outbox → bus → notify planlar
    await notify.settled();
    expect((await rows()).map((r) => [r.code, r.channel, r.status])).toEqual([
      ['F-EVT-SOS', 'PUSH', 'sent'],
      ['F-EVT-SOS', 'SMS', 'sent'],
      ['F-EVT-SOS', 'SMS', 'sent'],
      ['F-EVT-SOS', 'VOICE', 'sent'],
    ]);
    const text = `${NAME} yardım istedi. Operatör hatta.`;
    expect(fcm.sent).toHaveLength(1);
    expect(fcm.sent[0]).toMatchObject({ token: TOKEN, body: text, priority: 'high' });
    // T-061: aile uygulaması bildirime dokununca olay ekranını açar (kişi + olay).
    expect(fcm.sent[0]!.data).toMatchObject({
      type: 'NOTICE',
      code: 'F-EVT-SOS',
      protectedPersonId: PERSON,
      eventId: expect.any(String),
    });
    expect(cpaas.sms.map((s) => s.to).sort()).toEqual([PHONES.kizi, PHONES.oglu]);
    expect(cpaas.sms[0]!.body).toBe(text);
    expect(cpaas.tts).toEqual([{ to: PHONES.kizi, text }]);
    // Komşu (NEIGHBOR) aile bildirimi almaz.
    expect(cpaas.sms.some((s) => s.to === '+905550000039')).toBe(false);

    // Outbox'un yeniden teslimi (en az bir kez) ikinci gönderim yapmaz.
    const [ev] = await h.rows<{ id: string }>('SELECT id FROM event.event WHERE protected_person_id = $1', [PERSON]);
    await notify.onTransition({ payload: { eventId: ev!.id, from: 'CREATED', to: 'OPERATOR_QUEUE' } } as never);
    await notify.settled();
    expect(await rows()).toHaveLength(4);
    expect(fcm.sent).toHaveLength(1);
    void events;
  });

  it('DISPATCH → F-EVT-112, adres profilden', async () => {
    const [{ id }] = await h.rows<{ id: string }>(
      `INSERT INTO event.event (id, protected_person_id, type, priority, state)
       VALUES ('0190b000-0000-7000-8000-0000000000e1', '${PERSON}', 'FALL', 1, 'DISPATCH') RETURNING id`,
    );
    await notify.onTransition({ payload: { eventId: id, from: 'CONFIRMED_EMERGENCY', to: 'DISPATCH' } } as never);
    await notify.settled();
    expect(fcm.sent[0]!.body).toBe("Operatör 112'yi aradı. Ambulans yolda. Adres: Bağdat Cd. 1, Kadıköy, İstanbul");
  });
});

describe('kanal yedekliliği', () => {
  it('FCM hatasında (geçersiz token) SMS gönderilir; geçersiz hedef silinir', async () => {
    fcm.next = 'invalid-token';
    await notify.plan(req('F-BAT-10'));
    await notify.settled();
    expect((await rows()).map((r) => [r.channel, r.status, r.recipient_id.slice(-2)])).toEqual([
      ['PUSH', 'failed', 'b1'],
      ['SMS', 'sent', 'c1'],
    ]);
    expect(cpaas.sms).toEqual([{ to: PHONES.kizi, body: `${NAME}'ın saat pili %10.` }]);
    expect(await h.rows('SELECT 1 FROM notify.push_target')).toHaveLength(0);
  });

  it('FCM geçici hata: üstel geri çekilmeyle yeniden dener, 5 denemede pes edip SMS yedeği', async () => {
    fcm.next = 'retry';
    const t0 = new Date();
    await notify.plan(req('F-CONN-LOST'), t0);
    await notify.settled();
    let now = t0;
    for (let i = 0; i < 6; i++) {
      now = new Date(now.getTime() + 60_000);
      await notify.drain(now);
    }
    expect(fcm.sent).toHaveLength(5);
    expect(cpaas.sms.map((s) => s.to)).toEqual([PHONES.kizi]);
  });

  it('bilgi bildirimi: push gönderildi, 10 sn onay yoksa SMS; onay gelirse SMS yok', async () => {
    const t0 = new Date();
    await notify.plan(req('F-WATCH-OFF-4H', 'FAMILY', 'a'), t0);
    await notify.plan(req('F-WATCH-OFF-4H', 'FAMILY', 'b'), t0);
    await notify.settled();
    expect(cpaas.sms).toHaveLength(0);
    const [b] = await h.rows<{ id: string }>("SELECT id FROM notify.notification WHERE dedupe_key = 'b'");
    await notify.ack('fam-1', b!.id);
    await expect(notify.ack('fam-2', b!.id)).rejects.toMatchObject({ status: 404 }); // başkasının bildirimi
    await notify.drain(new Date(t0.getTime() + 5_000));
    expect(cpaas.sms).toHaveLength(0); // süre dolmadı
    await notify.drain(new Date(t0.getTime() + 11_000));
    expect(cpaas.sms).toHaveLength(1); // yalnız onaylanmayan 'a'
    await notify.drain(new Date(t0.getTime() + 60_000));
    expect(cpaas.sms).toHaveLength(1);
  });

  it('push hedefi yoksa bilgi bildirimi doğrudan ilk yakına SMS; akış bildirimi (F-EVT-OK) SMS’e düşmez', async () => {
    await h.pg.exec('DELETE FROM notify.push_target');
    await notify.plan(req('F-BAT-10'));
    await notify.plan(req('F-EVT-OK'));
    await notify.settled();
    await notify.drain(new Date(Date.now() + 60_000));
    expect(cpaas.sms.map((s) => s.body)).toEqual([`${NAME}'ın saat pili %10.`]);
  });

  it('SMS teslim raporu: delivered/failed işlenir, durum geri gitmez', async () => {
    await h.pg.exec('DELETE FROM notify.push_target');
    await notify.plan(req('F-BAT-10'));
    await notify.settled();
    const [s] = await h.rows<{ id: string }>("SELECT id FROM notify.notification WHERE channel = 'SMS'");
    await notify.smsStatus(s!.id, { MessageStatus: 'delivered' });
    await notify.smsStatus(s!.id, { MessageStatus: 'failed' });
    expect((await rows())[0]!.status).toBe('delivered');
  });

  it('sağlayıcı yapılandırılmamışsa satır "unconfigured" ile başarısız; olay akışı durmaz', async () => {
    notify = new NotifyService(h.db, devicePush, null, null, { NOTIFY_SWEEP_MS: '0' });
    await notify.plan(req('F-EVT-SOS'));
    await notify.settled();
    expect(new Set((await rows()).map((r) => `${r.status}:${r.error}`))).toEqual(new Set(['failed:unconfigured']));
  });
});

describe('kişinin cihazı (ELDER)', () => {
  it('W-BAT-20 → kişinin push token’lı, kaldırılmamış cihazlarına', async () => {
    await h.pg.exec(`
      INSERT INTO device.device (id, protected_person_id, kind, push_provider, push_token) VALUES
        ('0190b000-0000-7000-8000-0000000000d1', '${PERSON}', 'WEAROS_WATCH', 'FCM', 'tok-1'),
        ('0190b000-0000-7000-8000-0000000000d2', '${PERSON}', 'IOS_PHONE', NULL, NULL);
      INSERT INTO device.device (id, protected_person_id, kind, push_provider, push_token, revoked_at) VALUES
        ('0190b000-0000-7000-8000-0000000000d3', '${PERSON}', 'ANDROID_PHONE', 'FCM', 'tok-3', now());`);
    await notify.plan(req('W-BAT-20', 'ELDER'));
    await notify.settled();
    expect(devicePush.sent.map((m) => [m.deviceId.slice(-2), m.data.code])).toEqual([['d1', 'W-BAT-20']]);
  });

  describe('kanal yönlendirmesi: W-* yalnız saat kategorisine, P-* yalnız telefona', () => {
    const WATCH = '0190b000-0000-7000-8000-0000000000d1';
    const PHONE = '0190b000-0000-7000-8000-0000000000d2';
    const PENDANT = '0190b000-0000-7000-8000-0000000000d4';
    const TOKENLESS_WATCH = '0190b000-0000-7000-8000-0000000000d5';
    const sent = () => devicePush.sent.map((m) => [m.deviceId.slice(-2), m.data.code, m.data.forDeviceId?.slice(-2)]);
    beforeEach(async () => {
      await h.pg.exec(`
        INSERT INTO device.device (id, protected_person_id, kind, category, push_provider, push_token) VALUES
          ('${WATCH}', '${PERSON}', 'WEAROS_WATCH', NULL, 'FCM', 'tok-1'),
          ('${PHONE}', '${PERSON}', 'ANDROID_PHONE', NULL, 'FCM', 'tok-2'),
          ('${PENDANT}', '${PERSON}', 'SIMULATOR', 'PENDANT', 'FCM', 'tok-4');`);
    });
    // Kolye (PENDANT) saat kategorisi değil: W-* almaz.
    const TABLE: [string, (string | undefined)[][]][] = [
      ['W-BAT-PLAN', [['d1', 'W-BAT-PLAN', undefined]]],
      ['P-CHARGE-NOW', [['d2', 'P-CHARGE-NOW', undefined]]],
      ['P-WATCH-OFF-2H', [['d2', 'P-WATCH-OFF-2H', undefined]]],
    ];
    it.each(TABLE)('%s', async (code, expected) => {
      await notify.plan(req(code, 'ELDER'));
      await notify.settled();
      expect(sent()).toEqual(expected);
    });

    it('push token’ı olmayan saate W-* bildirimi telefon üzerinden (NOTICE, forDeviceId = saat); tekrar teslimde tek', async () => {
      await h.pg.exec(`UPDATE device.device SET push_token = NULL, push_provider = NULL WHERE id = '${WATCH}';
        INSERT INTO device.device (id, protected_person_id, kind) VALUES ('${TOKENLESS_WATCH}', '${PERSON}', 'WEAROS_WATCH');`);
      expect(await notify.plan(req('W-CHARGE-DONE', 'ELDER'))).toBe(2);
      expect(await notify.plan(req('W-CHARGE-DONE', 'ELDER'))).toBe(0);
      await notify.settled();
      expect(sent().sort()).toEqual([
        ['d2', 'W-CHARGE-DONE', 'd1'],
        ['d2', 'W-CHARGE-DONE', 'd5'],
      ]);
      expect(devicePush.sent[0]!.data).toEqual({
        type: 'NOTICE',
        code: 'W-CHARGE-DONE',
        notificationId: expect.any(String),
        forDeviceId: expect.stringMatching(/^0190b000/),
      });
      const r = await h.rows<{ recipient_kind: string; status: string }>(
        'SELECT recipient_kind, status FROM notify.notification',
      );
      expect(r.every((x) => x.recipient_kind === 'DEVICE_RELAY' && x.status === 'sent')).toBe(true);
    });

    it('köprü telefonu yoksa (token yok) aktarım başarısız sayılır; olay akışı durmaz', async () => {
      await h.pg.exec(
        `UPDATE device.device SET push_token = NULL, push_provider = NULL WHERE id IN ('${WATCH}', '${PHONE}')`,
      );
      expect(await notify.plan(req('W-WEAR-REMIND', 'ELDER'))).toBe(1);
      await notify.settled();
      expect(devicePush.sent).toHaveLength(0);
      expect((await rows()).map((x) => [x.status, x.error])).toEqual([['failed', 'no-bridge']]);
    });

    it('DevicePush: aktarılan NOTICE telefonda görünür bildirim değil (FCM data-only, APNs arka plan)', async () => {
      const dp = new DevicePush(h.db, null, undefined, fcm);
      const data = { type: 'NOTICE', code: 'W-CHARGE-DONE', forDeviceId: WATCH };
      expect(await dp.deliver({ deviceId: PHONE, priority: 'high', ttlSec: 60, data })).toBe('sent');
      expect(fcm.sent[0]).toMatchObject({ token: 'tok-2', data });
      expect(fcm.sent[0]!.body).toBeUndefined();
      const apns = {
        sent: [] as unknown[],
        send: async (r: unknown) => (apns.sent.push(r), { status: 'ok' as const }),
      };
      await h.pg.exec(`UPDATE device.device SET push_provider = 'APNS' WHERE id = '${PHONE}'`);
      expect(await new DevicePush(h.db, apns).deliver({ deviceId: PHONE, priority: 'high', ttlSec: 60, data })).toBe(
        'sent',
      );
      expect(apns.sent[0]).toMatchObject({
        pushType: 'background',
        priority: 5,
        payload: { aps: { 'content-available': 1 }, type: 'NOTICE', code: 'W-CHARGE-DONE', forDeviceId: WATCH },
      });
    });
  });

  it('DevicePush: FCM cihazına NOTICE görünür bildirim (metin katalogdan); geçersiz token silinir', async () => {
    await h.pg.exec(`INSERT INTO device.device (id, protected_person_id, kind, push_provider, push_token)
      VALUES ('0190b000-0000-7000-8000-0000000000d1', '${PERSON}', 'WEAROS_WATCH', 'FCM', 'tok-1')`);
    const dp = new DevicePush(h.db, null, undefined, fcm);
    const msg = { deviceId: '0190b000-0000-7000-8000-0000000000d1', priority: 'high' as const, ttlSec: 60 };
    expect(await dp.deliver({ ...msg, data: { type: 'NOTICE', code: 'W-BAT-20' } })).toBe('sent');
    expect(fcm.sent[0]).toMatchObject({ token: 'tok-1', body: 'Saatinizi şarja takın.' });
    fcm.next = 'invalid-token';
    expect(await dp.deliver({ ...msg, data: { type: 'WAKE' } })).toBe('invalid-token');
    expect(await h.rows('SELECT push_token FROM device.device')).toEqual([{ push_token: null }]);
  });
});

describe('PII', () => {
  it('log’da numara, ad, token, bildirim metni yok; satırda metin ve numara yok', async () => {
    const lines: string[] = [];
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((m) =>
      vi.spyOn(Logger.prototype, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' '))),
    );
    try {
      fcm.next = 'invalid-token';
      await notify.plan(req('F-EVT-SOS'));
      await notify.settled();
      fcm.next = 'retry';
      await notify.plan(req('F-BAT-10', 'FAMILY', 'x'));
      await notify.settled();
      for (let i = 0; i < 6; i++) await notify.drain(new Date(Date.now() + (i + 1) * 60_000));
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    const all = lines.join('\n') + JSON.stringify(await h.rows('SELECT * FROM notify.notification'));
    for (const secret of [PHONES.kizi, PHONES.oglu, NAME, 'Fatma', TOKEN, 'yardım istedi', 'Bağdat'])
      expect(all).not.toContain(secret);
    expect(lines.some((l) => l.includes('F-EVT-SOS'))).toBe(true); // kod log'da olabilir
  });
});

describe('FcmClient (HTTP v1)', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const cfg = { projectId: 'yanimda-test', clientEmail: 'svc@yanimda-test.iam.gserviceaccount.com', privateKey: pem };
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it('OAuth token’ı önbelleğe alır; mesaj gövdesi doğru; hata kodları sınıflanır', async () => {
    const calls: { url: string; body: string; auth?: string }[] = [];
    const queue: Response[] = [
      reply(200, { access_token: 'ya29.x', expires_in: 3599 }),
      reply(200, { name: 'projects/yanimda-test/messages/1' }),
      reply(404, { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }),
      reply(503, { error: { status: 'UNAVAILABLE' } }),
      reply(400, { error: { status: 'INVALID_ARGUMENT' } }),
    ];
    const http = (async (url: string, init: RequestInit) => {
      calls.push({
        url: String(url),
        body: String(init.body),
        auth: (init.headers as Record<string, string>).authorization,
      });
      return queue.shift()!;
    }) as unknown as typeof fetch;
    const c = new FcmClient(cfg, http, () => 1_800_000_000_000);
    const m = { token: 't', body: 'Merhaba', data: { code: 'F-BAT-10' }, priority: 'high' as const, ttlSec: 60 };
    expect(await c.send(m)).toEqual({ status: 'ok', id: 'projects/yanimda-test/messages/1' });
    expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/token');
    const assertion = new URLSearchParams(calls[0]!.body).get('assertion')!;
    const claims = JSON.parse(Buffer.from(assertion.split('.')[1]!, 'base64url').toString());
    expect(claims).toMatchObject({ iss: cfg.clientEmail, scope: 'https://www.googleapis.com/auth/firebase.messaging' });
    expect(calls[1]).toMatchObject({
      url: 'https://fcm.googleapis.com/v1/projects/yanimda-test/messages:send',
      auth: 'Bearer ya29.x',
    });
    expect(JSON.parse(calls[1]!.body).message).toMatchObject({
      token: 't',
      notification: { body: 'Merhaba' },
      data: { code: 'F-BAT-10' },
      android: { priority: 'HIGH', ttl: '60s' },
    });
    expect(await c.send(m)).toEqual({ status: 'invalid-token', reason: 'UNREGISTERED' });
    expect(await c.send(m)).toEqual({ status: 'retry', reason: 'UNAVAILABLE' });
    expect(await c.send(m)).toEqual({ status: 'invalid-token', reason: 'INVALID_ARGUMENT' });
    expect(calls.filter((x) => x.url.includes('oauth2'))).toHaveLength(1);
  });
});
