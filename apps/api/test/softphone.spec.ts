import { createHmac } from 'node:crypto';

import type { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { KafkaEnvelope, Signal } from '@yanimda/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '../src/common/bus';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { ChainService } from '../src/modules/chain/chain.service';
import { loadProcedures } from '../src/modules/chain/procedures';
import { OidcGuard, ROLES_KEY } from '../src/modules/identity/oidc.guard';
import { oidcConfigFromEnv, OidcVerifier } from '../src/modules/identity/oidc-verifier';
import { FakeProvider } from '../src/modules/telephony/fake-cpaas';
import { MemoryRecordingStore } from '../src/modules/telephony/recording-store';
import { TelephonyController } from '../src/modules/telephony/telephony.controller';
import { type CallView, TelephonyService, type WebhookKind } from '../src/modules/telephony/telephony.service';
import { TwilioProvider } from '../src/modules/telephony/twilio';
import {
  clientIdentity,
  twilioVoiceToken,
  type VoiceConfig,
  voiceConfigFromEnv,
} from '../src/modules/telephony/voice-token';
import { type FakeOidc, startFakeOidc } from './support/fake-oidc';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * T-051 konsol yazılım telefonu (E-05). Kabul (bu dilim):
 *  - `GET /v1/telephony/token` kısa ömürlü Twilio Voice token'ı (kimlik `client:<sub>`), yalnız OPERATOR/SUPERVISOR;
 *    sahte sağlayıcıda sahte token
 *  - operatör ucu: yazılım telefonu açıksa `client:<operatör>`, değilse masa hattı
 *  - konferansa aile eklenir (görüşme `<Conference>`'a taşınır, yakın aranır); bekletme; kapatma
 *  - konferans kaydı da olay kaydında (depoda); numara log/audit/satırda yok
 * Gelen SOS aramaları (müsait operatöre yönlendirme): test/inbound.spec.ts.
 */
const ENV = { CPAAS_WEBHOOK_BASE: 'https://api.test', CPAAS_AGENT_NUMBER: '+902120000000', COUNTRY_CODE: 'TR' };
const VOICE: VoiceConfig = {
  accountSid: 'AC1',
  apiKeySid: 'SK1',
  apiKeySecret: 'gizli-anahtar',
  twimlAppSid: 'AP1',
  ttlSec: 600,
};
const PERSON = 'pp-soft';
const NUM = { watch: '+905550000005', contact1: '+905550000022', contact2: '+905550000033' };

let h: Harness;
let fake: FakeProvider;
let store: MemoryRecordingStore;
let tel: TelephonyService;
let chain: ChainService;
let idp: FakeOidc;

const toService: ConstructorParameters<typeof FakeProvider>[0] = {
  stepMs: 1,
  talkMs: 60_000, // görüşme kapatılana kadar sürer
  transport: async (url, params) => {
    const u = new URL(url);
    await tel.webhook(u.pathname.split('/').at(-1) as WebhookKind, u.searchParams.get('call')!, params);
  },
};

beforeAll(async () => {
  h = await createHarness();
  idp = await startFakeOidc();
});
beforeEach(async () => {
  await h.reset();
  store = new MemoryRecordingStore();
  fake = new FakeProvider(toService);
  tel = new TelephonyService(h.db, h.outbox, fake, store, ENV);
  chain = new ChainService(h.db, h.events(new InMemoryTimers()), loadProcedures(), tel);
  await tel.setContacts(PERSON, [
    { role: 'WATCH', phone: NUM.watch },
    { role: 'CONTACT', priority: 1, displayName: 'Kızı', phone: NUM.contact1 },
    { role: 'CONTACT', priority: 2, displayName: 'Oğlu', phone: NUM.contact2 },
  ]);
});
afterEach(async () => {
  await Promise.all([fake.settled, fake.partiesSettled]);
  await new Promise((r) => setTimeout(r, 10)); // taşımanın dial webhook'u
});
afterAll(async () => {
  await h.close();
  await idp.close();
});

const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as { status?: number }).status ?? (e as Error).message;
  }
};

async function talking(): Promise<{ eventId: string; call: CallView }> {
  await bus.deliver<Signal>('signal.received', {
    payload: sig('SOS', { protectedPersonId: PERSON }),
  } as unknown as KafkaEnvelope<Signal>);
  const [{ id }] = await h.rows<{ id: string }>('SELECT id FROM event.event WHERE protected_person_id = $1', [PERSON]);
  await chain.claim(id, 'op-1');
  await chain.call(id, 1, 'op-1');
  for (let i = 0; i < 200; i++) {
    const [c] = await tel.callsFor(id);
    if (c?.status === 'in-progress') return { eventId: id, call: c };
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('görüşme başlamadı');
}

describe("Twilio Voice erişim token'ı", () => {
  it('HS256 JWT, twilio-fpa başlığı, VoiceGrant (gelen + giden uygulama), kısa ömür', () => {
    const now = new Date('2026-11-09T10:00:00Z');
    const jwt = twilioVoiceToken(VOICE, 'op_1', now);
    const [head, body, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(head!, 'base64url').toString())).toEqual({
      typ: 'JWT',
      alg: 'HS256',
      cty: 'twilio-fpa;v=1',
    });
    const iat = now.getTime() / 1000;
    expect(JSON.parse(Buffer.from(body!, 'base64url').toString())).toEqual({
      jti: `SK1-${iat}`,
      iss: 'SK1',
      sub: 'AC1',
      iat,
      nbf: iat,
      exp: iat + 600,
      grants: { identity: 'op_1', voice: { incoming: { allow: true }, outgoing: { application_sid: 'AP1' } } },
    });
    expect(signature).toBe(createHmac('sha256', 'gizli-anahtar').update(`${head}.${body}`).digest('base64url'));
  });

  it('ortamdan: API anahtarı yoksa yok; ömür 60–3600 sn aralığına sıkıştırılır', () => {
    const base = { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_API_KEY_SID: 'SK1', TWILIO_API_KEY_SECRET: 's' };
    expect(voiceConfigFromEnv({ TWILIO_ACCOUNT_SID: 'AC1' })).toBeNull();
    expect(voiceConfigFromEnv(base)).toMatchObject({ ttlSec: 3600 });
    expect(voiceConfigFromEnv(base)).not.toHaveProperty('twimlAppSid');
    expect(voiceConfigFromEnv({ ...base, TWILIO_VOICE_TOKEN_TTL_SEC: '86400' })!.ttlSec).toBe(3600);
    expect(voiceConfigFromEnv({ ...base, TWILIO_VOICE_TOKEN_TTL_SEC: '5' })!.ttlSec).toBe(60);
  });

  it('istemci kimliği: OIDC sub yalnız harf/rakam/alt çizgiye indirgenir', () => {
    expect(clientIdentity('6f1c-4a2b.x@y')).toBe('6f1c_4a2b_x_y');
  });

  it('servis: sahte sağlayıcıda sahte token; Twilio + API anahtarı → gerçek biçim; telefoni kapalı → 503', async () => {
    const f = tel.voiceToken('op-1');
    expect(f).toMatchObject({ provider: 'fake', identity: 'op_1' });
    expect(f.token).toMatch(/^fake\./);

    const tw = new TwilioProvider({ accountSid: 'AC1', authToken: 't', from: '+908500000000' });
    const real = new TelephonyService(h.db, h.outbox, tw, null, {
      ...ENV,
      TWILIO_ACCOUNT_SID: 'AC1',
      TWILIO_API_KEY_SID: 'SK1',
      TWILIO_API_KEY_SECRET: 's',
      TWILIO_VOICE_TOKEN_TTL_SEC: '600',
    }).voiceToken('op-1');
    expect(real).toMatchObject({ provider: 'twilio', identity: 'op_1', ttlSec: 600 });
    expect(real.token.split('.')).toHaveLength(3);
    expect(Date.parse(real.expiresAt) - Date.now()).toBeGreaterThan(590_000);

    expect(
      await status(
        Promise.resolve().then(() => new TelephonyService(h.db, h.outbox, tw, null, ENV).voiceToken('op-1')),
      ),
    ).toBe(503);
    expect(
      await status(
        Promise.resolve().then(() => new TelephonyService(h.db, h.outbox, null, null, ENV).voiceToken('op-1')),
      ),
    ).toBe(503);
  });
});

describe('operatör ucu (agentFor)', () => {
  it('yazılım telefonu açıksa client:<operatör>, kapalıysa masa hattı', () => {
    expect(tel.agentFor('op-1')).toBe('client:op_1');
    expect(new TelephonyService(h.db, h.outbox, fake, store, { ...ENV, CPAAS_SOFTPHONE: 'off' }).agentFor('op-1')).toBe(
      '+902120000000',
    );
  });

  it('Twilio API anahtarı yoksa yazılım telefonu olamaz → masa hattı', () => {
    const tw = new TwilioProvider({ accountSid: 'AC1', authToken: 't', from: '+908500000000' });
    expect(new TelephonyService(h.db, h.outbox, tw, null, ENV).agentFor('op-1')).toBe('+902120000000');
    expect(
      new TelephonyService(h.db, h.outbox, tw, null, {
        ...ENV,
        TWILIO_ACCOUNT_SID: 'AC1',
        TWILIO_API_KEY_SID: 'SK1',
        TWILIO_API_KEY_SECRET: 's',
      }).agentFor('op-1'),
    ).toBe('client:op_1');
  });
});

describe('TelephonyController yetkisi', () => {
  const verifier = () => new OidcVerifier(oidcConfigFromEnv(idp.env));
  const ctx = (headers: Record<string, string>) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ headers }) }),
      getHandler: () => TelephonyController.prototype.token,
      getClass: () => TelephonyController,
    }) as unknown as ExecutionContext;
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

  it('OidcGuard + OPERATOR/SUPERVISOR', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, TelephonyController)).toContain(OidcGuard);
    expect(Reflect.getMetadata(ROLES_KEY, TelephonyController)).toEqual(['OPERATOR', 'SUPERVISOR']);
  });

  it('token yok 401; FAMILY ve yalnız ADMIN 403; OPERATOR ve SUPERVISOR geçer', async () => {
    const g = new OidcGuard(verifier(), new Reflector());
    expect(await status(g.canActivate(ctx({})))).toBe(401);
    expect(await status(g.canActivate(ctx(bearer(idp.token({ realm: 'consumers', roles: ['FAMILY'] })))))).toBe(403);
    expect(await status(g.canActivate(ctx(bearer(idp.token({ roles: ['ADMIN'] })))))).toBe(403);
    expect(await g.canActivate(ctx(bearer(idp.token({ roles: ['OPERATOR'] }))))).toBe(true);
    expect(await g.canActivate(ctx(bearer(idp.token({ roles: ['SUPERVISOR'] }))))).toBe(true);
  });

  it("token ucu operatörün sub'ını kullanır", () => {
    const ctl = new TelephonyController(tel);
    const r = ctl.token({ headers: {}, user: { sub: 'op-9', roles: ['OPERATOR'] } as never });
    expect(r.identity).toBe('op_9');
  });
});

describe('konferans, bekletme, kapatma (sahte CPaaS)', () => {
  it('aile ekle: görüşme konferansa taşınır, yakın aranır; dial webhook görüşmeyi bitirmez; numara hiçbir kayıtta yok', async () => {
    const { eventId, call } = await talking();
    const v = await tel.addFamily(call.id, 'op-1', 2);
    expect(v).toMatchObject({ status: 'in-progress', conference: true, parties: 1, held: false });
    expect(fake.conferences.map((c) => c.kind)).toEqual(['move', 'add']);
    const room = fake.conferences[0]!.room;
    expect(room).toBe(`yanimda-${call.id}`);
    expect(fake.parties).toEqual([{ room, to: NUM.contact2 }]);

    // Twilio: aranan bacak taşınınca operatörün Dial'ı biter → dial webhook'u operatörü aynı odaya alır (kayıtlı).
    const twiml = await tel.webhook('dial', call.id, { DialCallStatus: 'completed' });
    expect(twiml).toContain(`>${room}</Conference>`);
    expect(twiml).toContain('endConferenceOnExit="true"');
    expect(twiml).toContain('record="record-from-start"');
    expect((await tel.callsFor(eventId))[0]).toMatchObject({ status: 'in-progress' });

    await fake.partiesSettled;
    const actions = (
      await h.rows<{ action: string }>("SELECT action FROM audit.log WHERE action LIKE 'telephony.%' ORDER BY id")
    ).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['telephony.conference.added', 'telephony.party.status']));

    await tel.hangup(call.id, 'op-1');
    await fake.settled;
    expect((await tel.callsFor(eventId))[0]).toMatchObject({ status: 'completed', answered: true, recorded: true });

    const everything = JSON.stringify([
      await h.rows('SELECT * FROM telephony.call'),
      await h.rows("SELECT data FROM audit.log WHERE action LIKE 'telephony.%'"),
      await h.rows("SELECT envelope FROM event.outbox WHERE topic = 'event.updated'"),
    ]);
    for (const n of Object.values(NUM)) expect(everything).not.toContain(n);
  });

  it('beklet / devam: önce konferansa taşınır, aranan bacak bekletilir', async () => {
    const { call } = await talking();
    expect(await tel.hold(call.id, 'op-1', true)).toMatchObject({ held: true, conference: true, parties: 0 });
    expect(await tel.hold(call.id, 'op-1', false)).toMatchObject({ held: false });
    expect(fake.conferences.map((c) => [c.kind, 'hold' in c ? c.hold : null])).toEqual([
      ['move', null],
      ['hold', true],
      ['hold', false],
    ]);
    await tel.hangup(call.id, 'op-1');
    await fake.settled;
  });

  it('kapat: sağlayıcıda operatör bacağı kapanır, görüşme biter; tekrar kapatmak zararsız', async () => {
    const { eventId, call } = await talking();
    const [row] = await h.rows<{ provider_call_id: string }>('SELECT provider_call_id FROM telephony.call');
    await tel.hangup(call.id, 'op-1');
    await fake.settled;
    expect(fake.hungUp).toEqual([row!.provider_call_id]);
    expect((await tel.callsFor(eventId))[0]).toMatchObject({ status: 'completed', suggestedResult: 'REACHED' });
    await tel.hangup(call.id, 'op-1');
    expect(fake.hungUp).toHaveLength(1);
  });

  it('başka operatör 403; bilinmeyen arama 404; görüşme sürmüyorsa 409; yakın kayıtlı değilse 409', async () => {
    const { call } = await talking();
    expect(await status(tel.hold(call.id, 'op-2', true))).toBe(403);
    expect(await status(tel.addFamily(call.id, 'op-2'))).toBe(403);
    expect(await status(tel.hangup(call.id, 'op-2'))).toBe(403);
    expect(await status(tel.hold('01a1c000-0000-7000-8000-00000000dead', 'op-1', true))).toBe(404);
    expect(await status(tel.addFamily(call.id, 'op-1', 5))).toBe(409);
    await tel.hangup(call.id, 'op-1');
    await fake.settled;
    expect(await status(tel.addFamily(call.id, 'op-1'))).toBe(409);
    expect(await status(tel.hold(call.id, 'op-1', true))).toBe(409);
  });

  it('konferans kaydı ayrı nesne olarak depolanır; tekrar teslim çift yazmaz', async () => {
    const { eventId, call } = await talking();
    await tel.addFamily(call.id, 'op-1');
    await tel.hangup(call.id, 'op-1');
    await fake.settled;
    fake.recordings.set('REconf', Buffer.from('KONF'));
    await tel.webhook('recording', call.id, { RecordingSid: 'REconf', RecordingStatus: 'completed' });
    await tel.webhook('recording', call.id, { RecordingSid: 'REconf', RecordingStatus: 'completed' });
    const keys = [...store.objects.keys()].sort();
    expect(keys).toEqual([`recordings/tr/${eventId}/${call.id}-REconf.mp3`, `recordings/tr/${eventId}/${call.id}.mp3`]);
    expect(fake.deleted).toContain('REconf');
  });
});

describe('Twilio konferans işlemleri', () => {
  const seen: { url: string; method: string; body: URLSearchParams | null }[] = [];
  const http = (async (url: string, init: RequestInit = {}) => {
    seen.push({
      url,
      method: init.method ?? 'GET',
      body: init.body ? new URLSearchParams(init.body as URLSearchParams) : null,
    });
    if (url.includes('/Conferences.json')) return new Response(JSON.stringify({ conferences: [{ sid: 'CF9' }] }));
    return new Response(JSON.stringify({ sid: 'CAnew' }), { status: 201 });
  }) as unknown as typeof fetch;
  const tw = new TwilioProvider({ accountSid: 'AC1', authToken: 'tok', from: '+908500000000' }, http);
  const base = 'https://api.twilio.com/2010-04-01/Accounts/AC1';
  const urls = new TelephonyService(h?.db, h?.outbox, null, null, ENV).urls('c1');

  it('move: aranan bacak odaya (operatör çıkınca bitmez)', async () => {
    seen.length = 0;
    await tw.conference({ kind: 'move', room: 'yanimda-c1', legCallId: 'CAleg', urls });
    expect(seen[0]!.url).toBe(`${base}/Calls/CAleg.json`);
    const twiml = seen[0]!.body!.get('Twiml')!;
    expect(twiml).toContain('<Dial><Conference');
    expect(twiml).toContain('endConferenceOnExit="false"');
    expect(twiml).toContain('>yanimda-c1</Conference>');
  });

  it('add: yakını arar; açınca anons + oda; durum geri çağrıları party ucuna', async () => {
    seen.length = 0;
    const r = await tw.conference({
      kind: 'add',
      room: 'yanimda-c1',
      to: '+905551112233',
      announce: 'Bu görüşme kaydedilmektedir.',
      urls,
    });
    expect(r.providerCallId).toBe('CAnew');
    const b = seen[0]!.body!;
    expect(seen[0]!.url).toBe(`${base}/Calls.json`);
    expect(b.get('To')).toBe('+905551112233');
    expect(b.get('StatusCallback')).toBe(urls.party);
    expect(b.getAll('StatusCallbackEvent')).toEqual(['initiated', 'ringing', 'answered', 'completed']);
    expect(b.get('Twiml')).toMatch(
      /<Say language="tr-TR" voice="Polly.Filiz">Bu görüşme kaydedilmektedir.<\/Say><Dial><Conference/,
    );
  });

  it('hold: oda adından konferans SID bulunur, katılımcı bekletilir', async () => {
    seen.length = 0;
    await tw.conference({ kind: 'hold', room: 'yanimda-c1', legCallId: 'CAleg', hold: true });
    expect(seen.map((s) => [s.method, s.url])).toEqual([
      ['GET', `${base}/Conferences.json?FriendlyName=yanimda-c1&Status=in-progress`],
      ['POST', `${base}/Conferences/CF9/Participants/CAleg.json`],
    ]);
    expect(seen[1]!.body!.get('Hold')).toBe('true');
  });
});
