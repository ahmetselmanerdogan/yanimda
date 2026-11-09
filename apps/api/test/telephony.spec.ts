import type { KafkaEnvelope, Signal } from '@yanimda/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '../src/common/bus';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { ChainService } from '../src/modules/chain/chain.service';
import { loadProcedures } from '../src/modules/chain/procedures';
import { cpaasSignature, verifySignature } from '../src/modules/telephony/cpaas';
import { FAKE_CPAAS_TOKEN, FakeProvider } from '../src/modules/telephony/fake-cpaas';
import { MemoryRecordingStore, S3RecordingStore } from '../src/modules/telephony/recording-store';
import { CpaasWebhookController } from '../src/modules/telephony/telephony.controller';
import {
  mapStatus,
  suggestionFor,
  TelephonyService,
  type WebhookKind,
} from '../src/modules/telephony/telephony.service';
import { TwilioProvider } from '../src/modules/telephony/twilio';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * T-050 CPaaS giden arama ve kayıt (E-05). Kabul:
 *  - FakeProvider ile tam akış: Ara → çalıyor → görüşme → bitti → öneri REACHED → kayıt S3'te, sağlayıcıda yok
 *  - webhook imzası bozuksa 403
 *  - durum (meşgul / cevap yok / hatalı) adım sonucunu önerir
 *  - aranan tarafa kayıt anonsu; numara log/audit/call satırına yazılmaz
 * Twilio sandbox'ta gerçek arama hesap gerektirir (yapılmadı).
 */
const ENV = { CPAAS_WEBHOOK_BASE: 'https://api.test', CPAAS_AGENT_NUMBER: '+902120000000', COUNTRY_CODE: 'TR' };
const PERSON = 'pp-tel';
const NUM = { watch: '+905550000005', elder: '+905550000011', contact1: '+905550000020', neighbor: '+905550000039' };

let h: Harness;
let fake: FakeProvider;
let store: MemoryRecordingStore;
let tel: TelephonyService;
let chain: ChainService;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  store = new MemoryRecordingStore();
  // Sahte CPaaS webhook'ları doğrudan servise (imza denetleyici testinde ayrıca).
  fake = new FakeProvider({
    stepMs: 1,
    talkMs: 2,
    transport: async (url, params) => {
      const u = new URL(url);
      await tel.webhook(u.pathname.split('/').at(-1) as WebhookKind, u.searchParams.get('call')!, params);
    },
  });
  tel = new TelephonyService(h.db, h.outbox, fake, store, ENV);
  chain = new ChainService(h.db, h.events(new InMemoryTimers()), loadProcedures(), tel);
  await tel.setContacts(PERSON, [
    { role: 'WATCH', phone: NUM.watch },
    { role: 'ELDER', phone: NUM.elder },
    { role: 'CONTACT', priority: 1, displayName: 'Kızı', phone: NUM.contact1 },
    { role: 'NEIGHBOR', phone: NUM.neighbor },
  ]);
});
afterAll(async () => {
  await h.close();
});

async function claimed(person = PERSON) {
  await bus.deliver<Signal>('signal.received', {
    payload: sig('SOS', { protectedPersonId: person }),
  } as unknown as KafkaEnvelope<Signal>);
  const [{ id }] = await h.rows<{ id: string }>('SELECT id FROM event.event WHERE protected_person_id = $1', [person]);
  await chain.claim(id, 'op-1');
  return id;
}
const callsOf = async (id: string) => (await chain.get(id)).calls;

describe('webhook imzası (Twilio şeması)', () => {
  const url = 'https://api.test/v1/webhooks/cpaas/status?call=1';
  const p = { CallSid: 'CA1', CallStatus: 'ringing', To: '+905550000000' };
  it('imza doğrulanır; parametre sırası önemsiz; URL/parametre/anahtar değişirse geçersiz', () => {
    const s = cpaasSignature('tok', url, p);
    expect(verifySignature('tok', url, { CallStatus: 'ringing', To: p.To, CallSid: 'CA1' }, s)).toBe(true);
    expect(verifySignature('tok', `${url}0`, p, s)).toBe(false);
    expect(verifySignature('tok', url, { ...p, CallStatus: 'completed' }, s)).toBe(false);
    expect(verifySignature('baska', url, p, s)).toBe(false);
    expect(verifySignature('tok', url, p, undefined)).toBe(false);
  });

  it('denetleyici: bozuk imza 403, doğru imza 200 + TwiML anons', async () => {
    const ctl = new CpaasWebhookController(tel);
    const res = {
      headers: {} as Record<string, string>,
      setHeader(k: string, v: string) {
        this.headers[k] = v;
      },
    };
    const path = '/v1/webhooks/cpaas/announce?call=01a1c000-0000-7000-8000-000000000001';
    await expect(
      ctl.webhook('announce', '01a1c000-0000-7000-8000-000000000001', {}, 'bozuk', { originalUrl: path }, res),
    ).rejects.toMatchObject({ status: 403 });
    const good = cpaasSignature(FAKE_CPAAS_TOKEN, `https://api.test${path}`, {});
    const twiml = await ctl.webhook(
      'announce',
      '01a1c000-0000-7000-8000-000000000001',
      {},
      good,
      { originalUrl: path },
      res,
    );
    expect(twiml).toContain('<Say language="tr-TR" voice="Polly.Filiz">Bu görüşme kaydedilmektedir.</Say>');
    expect(res.headers['content-type']).toContain('text/xml');
  });
});

describe('durum → öneri', () => {
  it.each([
    ['completed', true, 'REACHED'],
    ['completed', false, 'NO_ANSWER'],
    ['busy', false, 'BUSY'],
    ['no-answer', false, 'NO_ANSWER'],
    ['failed', false, 'WRONG_NUMBER'],
    ['canceled', false, null],
    ['ringing', false, null],
  ] as const)('%s (açıldı=%s) → %s', (s, a, r) => expect(suggestionFor(s, a)).toBe(r));
  it('Twilio durumları eşlenir', () => {
    expect(['initiated', 'ringing', 'answered', 'in-progress', 'x'].map(mapStatus)).toEqual([
      'queued',
      'ringing',
      'in-progress',
      'in-progress',
      null,
    ]);
  });
});

describe('sahte CPaaS ile tam akış', () => {
  it('Ara → çalıyor → görüşme → bitti: öneri REACHED; kayıt depoda, sağlayıcıdan silindi; numara hiçbir kayıtta yok', async () => {
    const id = await claimed();
    const r = await chain.call(id, 1, 'op-1');
    expect(r.event.state).toBe('CONTACT_CHAIN');
    expect(r.calls).toHaveLength(1);
    await fake.settled;
    const [c] = await callsOf(id);
    expect(c).toMatchObject({
      stepN: 1,
      status: 'completed',
      answered: true,
      suggestedResult: 'REACHED',
      recorded: true,
    });
    const key = `recordings/tr/${id}/${c!.id}.mp3`;
    expect(await store.exists(key)).toBe(true);
    expect(store.objects.get(key)!.contentType).toBe('audio/mpeg');
    expect(fake.recordings.size).toBe(0);
    expect(fake.deleted).toHaveLength(1);

    const everything = JSON.stringify([
      await h.rows('SELECT * FROM telephony.call'),
      await h.rows("SELECT data FROM audit.log WHERE action LIKE 'telephony.%' OR action LIKE 'profile.%'"),
      await h.rows("SELECT envelope FROM event.outbox WHERE topic = 'event.updated'"),
    ]);
    for (const n of Object.values(NUM)) expect(everything).not.toContain(n);
    const actions = (
      await h.rows<{ action: string }>("SELECT action FROM audit.log WHERE action LIKE 'telephony.%'")
    ).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(['telephony.call.started', 'telephony.call.status', 'telephony.recording.stored']),
    );
  });

  it('meşgul / cevap yok / hatalı numara adım sonucunu önerir; kayıt yok', async () => {
    await tel.setContacts(PERSON, [
      { role: 'WATCH', phone: '+905550000001' }, // 1 → meşgul
      { role: 'ELDER', phone: '+905550000000' }, // 0 → cevap yok
      { role: 'CONTACT', priority: 1, phone: '+905550000009' }, // 9 → hatalı
    ]);
    const id = await claimed();
    for (const [n, expected] of [
      [1, 'BUSY'],
      [2, 'NO_ANSWER'],
      [3, 'WRONG_NUMBER'],
    ] as const) {
      await chain.call(id, n, 'op-1');
      await fake.settled;
      expect((await callsOf(id)).at(-1)).toMatchObject({ stepN: n, suggestedResult: expected, recorded: false });
      await chain.stepResult(id, n, 'op-1', { result: expected }); // operatör onaylar
    }
    expect(store.objects.size).toBe(0);
  });

  it('süren aramada tekrar "Ara" yeni arama açmaz; bittikten sonra yeniden aranabilir', async () => {
    const id = await claimed();
    const slow = new FakeProvider({
      stepMs: 30,
      talkMs: 30,
      transport: async (url, p) => {
        const u = new URL(url);
        await tel.webhook(u.pathname.split('/').at(-1) as WebhookKind, u.searchParams.get('call')!, p);
      },
    });
    tel = new TelephonyService(h.db, h.outbox, slow, store, ENV);
    chain = new ChainService(h.db, h.events(new InMemoryTimers()), loadProcedures(), tel);
    await chain.call(id, 1, 'op-1');
    await chain.call(id, 1, 'op-1');
    expect(await callsOf(id)).toHaveLength(1);
    await slow.settled;
    await chain.call(id, 1, 'op-1');
    await slow.settled;
    expect((await callsOf(id)).map((c) => c.status)).toEqual(['completed', 'completed']);
  });

  it('webhook sırası bozuk gelirse durum geri gitmez; bilinmeyen arama sessizce yok sayılır', async () => {
    const id = await claimed();
    await chain.call(id, 1, 'op-1');
    await fake.settled;
    const [c] = await callsOf(id);
    await tel.webhook('status', c!.id, { CallStatus: 'ringing' });
    expect((await callsOf(id))[0]!.status).toBe('completed');
    expect(await tel.webhook('status', '01a1c000-0000-7000-8000-00000000dead', { CallStatus: 'ringing' })).toContain(
      '<Response/>',
    );
  });

  it('numara kayıtlı değilse ve 112 adımında CPaaS araması yok (yalnız arama zamanı)', async () => {
    const id = await claimed('pp-numarasiz');
    const r = await chain.call(id, 1, 'op-1');
    expect(r.calls).toEqual([]);
    expect(r.chain!.steps[0]!.calledAt).toBeDefined();

    const e = await claimed();
    await chain.escalate112(e, 'op-1', { reason: 'sessiz hat' });
    expect((await chain.call(e, 4, 'op-1')).calls).toEqual([]); // 112: masa hattından (T-052)
  });

  it('operatör hattı tanımlı değilse arama başarısız işaretlenir, olay akışı sürer', async () => {
    tel = new TelephonyService(h.db, h.outbox, fake, store, { ...ENV, CPAAS_AGENT_NUMBER: '', CPAAS_SOFTPHONE: 'off' });
    chain = new ChainService(h.db, h.events(new InMemoryTimers()), loadProcedures(), tel);
    const id = await claimed();
    const r = await chain.call(id, 1, 'op-1');
    expect(r.calls[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('CPAAS_AGENT_NUMBER') });
    expect(r.event.state).toBe('CONTACT_CHAIN');
  });

  it('kayıt deposu yoksa kayıt sağlayıcıda bırakılır (silinmez)', async () => {
    tel = new TelephonyService(h.db, h.outbox, fake, null, ENV);
    chain = new ChainService(h.db, h.events(new InMemoryTimers()), loadProcedures(), tel);
    const id = await claimed();
    await chain.call(id, 1, 'op-1');
    await fake.settled;
    expect((await callsOf(id))[0]!.recorded).toBe(false);
    expect(fake.deleted).toEqual([]);
    expect(fake.recordings.size).toBe(1);
  });

  it('rehber doğrulaması: E.164, rol, en fazla 20', async () => {
    await expect(tel.setContacts(PERSON, [{ role: 'ELDER', phone: '05550000000' }])).rejects.toMatchObject({
      status: 400,
    });
    await expect(tel.setContacts(PERSON, [{ role: 'BOSS', phone: '+905550000000' }])).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      tel.setContacts(PERSON, Array(21).fill({ role: 'CONTACT', phone: '+905550000000' })),
    ).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('Twilio sağlayıcısı', () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const http = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ sid: 'CA123' }), { status: 201 });
  }) as unknown as typeof fetch;
  const tw = new TwilioProvider({ accountSid: 'AC1', authToken: 'tok', from: '+908500000000' }, http);
  const urls = new TelephonyService(h?.db, h?.outbox, null, null, ENV).urls('c1');

  it('operatör ucunu arar; TwiML: iki kanallı kayıt, aranana anons, durum geri çağrıları', async () => {
    const { providerCallId } = await tw.call({
      callId: 'c1',
      to: '+905551112233',
      agent: '+902120000000',
      timeoutSec: 15,
      urls,
    });
    expect(providerCallId).toBe('CA123');
    const { url, init } = calls[0]!;
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC1/Calls.json');
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from('AC1:tok').toString('base64')}`,
    );
    const body = new URLSearchParams(init.body as URLSearchParams);
    expect(body.get('To')).toBe('+902120000000');
    const twiml = body.get('Twiml')!;
    expect(twiml).toContain('record="record-from-answer-dual"');
    expect(twiml).toContain('timeout="15"');
    expect(twiml).toContain(`<Number url="${urls.announce.replace(/&/g, '&amp;')}"`);
    expect(twiml).toContain('>+905551112233</Number>');
    expect(twiml).toContain(`recordingStatusCallback="${urls.recording}"`);
    expect(body.get('StatusCallback')).toBe(urls.agent);
  });

  it('kayıt indir (.mp3) ve sil', async () => {
    calls.length = 0;
    await tw.fetchRecording('RE1');
    await tw.deleteRecording('RE1');
    expect(calls.map((c) => [c.init.method ?? 'GET', c.url])).toEqual([
      ['GET', 'https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1.mp3'],
      ['DELETE', 'https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1.json'],
    ]);
  });
});

describe('S3 kayıt deposu', () => {
  it('SigV4 imzası AWS belgesindeki örnekle aynı (GET /test.txt, Range)', () => {
    const s3 = new S3RecordingStore(
      {
        endpoint: 'https://examplebucket.s3.amazonaws.com',
        bucket: 'examplebucket',
        region: 'us-east-1',
        accessKey: 'AKIAIOSFODNN7EXAMPLE',
        secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        retentionDays: 0,
      },
      fetch,
      () => new Date('2013-05-24T00:00:00Z'),
    );
    const { headers } = s3.sign('GET', '/test.txt', { range: 'bytes=0-9' }, Buffer.alloc(0));
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('PUT nesne kilidi başlıkları (COMPLIANCE, saklama süresi) ve Content-MD5', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const s3 = new S3RecordingStore(
      {
        endpoint: 'http://minio:9000',
        bucket: 'recordings',
        region: 'us-east-1',
        accessKey: 'a',
        secretKey: 'b',
        retentionDays: 365,
      },
      (async (url: string, init: RequestInit) => {
        seen.push({ url, headers: init.headers as Record<string, string> });
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
      () => new Date('2026-11-09T10:00:00.123Z'),
    );
    await s3.put('recordings/tr/e1/c1.mp3', Buffer.from('ses'), 'audio/mpeg');
    expect(seen[0]!.url).toBe('http://minio:9000/recordings/recordings/tr/e1/c1.mp3');
    expect(seen[0]!.headers).toMatchObject({
      'x-amz-object-lock-mode': 'COMPLIANCE',
      'x-amz-object-lock-retain-until-date': '2027-11-09T10:00:00Z',
      'content-md5': '8rMr2oWlpKYT60f7AcV84w==',
      'content-type': 'audio/mpeg',
    });
    expect(seen[0]!.headers.authorization).toMatch(
      /SignedHeaders=content-md5;content-type;host;x-amz-content-sha256;x-amz-date;x-amz-object-lock-mode;x-amz-object-lock-retain-until-date,/,
    );
  });
});
