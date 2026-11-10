import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { KafkaEnvelope, Signal } from '@yanimda/contracts';
import { t } from '@yanimda/messages';
import Ajv2020 from 'ajv/dist/2020';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '../src/common/bus';
import { FieldCipher } from '../src/common/field-cipher';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import type { EventService } from '../src/modules/event/event.service';
import { loadRulePack, type Rule, type RulePack } from '../src/modules/event/rules.loader';
import { ProfileService } from '../src/modules/profile/profile.service';
import { RULES_DIR } from '../src/modules/rules/rules.service';
import { classifyScreening, type ScreeningConfig } from '../src/modules/screening/classify';
import { ScreeningWebhookController } from '../src/modules/screening/screening.controller';
import { ScreeningService } from '../src/modules/screening/screening.service';
import { cpaasSignature, screenTwiml } from '../src/modules/telephony/cpaas';
import { FAKE_CPAAS_TOKEN, FakeProvider } from '../src/modules/telephony/fake-cpaas';
import { TelephonyService } from '../src/modules/telephony/telephony.service';
import { TwilioProvider } from '../src/modules/telephony/twilio';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * T-072 (D-12) otomatik sesli ön eleme. INACTIVITY ve WATCH_OFF (asla SOS/FALL): sessiz soru / bekleme cevapsızsa
 * kişiye CPaaS TTS araması ("evet" deyin veya 1'e basın). "evet/iyiyim/1" → olay OK kapanır (SYSTEM);
 * anlaşılmaz / yardım / cevapsız → operatör kuyruğu. Her sonuç kayıtlı; öğrenme modunda (ilk ay) OK sonuçlarından
 * örneklem operatöre CALLBACK olarak düşer (yanlış pozitif ölçümü).
 * Kabul: FakeProvider ile 3 senaryo (iyiyim → kapanır; anlaşılmaz → kuyruk; cevapsız → kuyruk).
 * Gerçek STT'de "evet" tanıma ≥ %95 (10 deneme) Twilio hesabı gerektirir (yapılmadı).
 *
 * Sahte sağlayıcıda numaranın son hanesi: 0 cevap yok, 1 meşgul, 9 hatalı, 8 açar ama sessiz, 7 "yardım edin",
 * 6 anlaşılmaz konuşma, 5 tuş 1, 4 düşük güvenli "evet", diğerleri "evet iyiyim".
 */
const ENV = { CPAAS_WEBHOOK_BASE: 'https://api.test', COUNTRY_CODE: 'TR' };
const PERSON = 'pp-screen';
const phone = (last: string) => `+90555000001${last}`;
const KEYS = `k1:${randomBytes(32).toString('base64')}`;

let h: Harness;
let timers: InMemoryTimers;
let events: EventService;
let fake: FakeProvider;
let tel: TelephonyService;
let screening: ScreeningService;
let transport: 'direct' | 'drop';

const BASE = loadRulePack('TR');
/** tr.yaml'dan türetilmiş paket; kural değişikliği testleri için. */
function packWith(fn: (rules: Rule[]) => void): RulePack {
  const p = structuredClone(BASE);
  fn(p.rules);
  return p;
}
const rule = (rules: Rule[], type: string) => rules.find((r) => r.type === type)!;

function setup(pack: RulePack = BASE, provider: 'fake' | 'off' = 'fake') {
  timers = new InMemoryTimers();
  events = h.events(timers, pack);
  fake = new FakeProvider({
    stepMs: 1,
    transport: async (url, params) => {
      if (transport === 'drop') return;
      const u = new URL(url);
      await screening.webhook(u.pathname.split('/').at(-1) as 'gather' | 'status', u.searchParams.get('s')!, params);
    },
  });
  tel = new TelephonyService(h.db, h.outbox, provider === 'fake' ? fake : null, null, ENV);
  screening = new ScreeningService(h.db, tel, events);
  screening.onModuleInit();
}

beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  transport = 'direct';
  setup();
});
afterEach(async () => {
  await fake.screensSettled; // sahte aramanın webhook'ları sonraki teste taşmasın
});
afterAll(async () => {
  await h.close();
});

const deliver = (s: ReturnType<typeof sig>) =>
  bus.deliver<Signal>('signal.received', { payload: s } as unknown as KafkaEnvelope<Signal>);
const contacts = (person: string, list: { role: string; phone: string }[]) => tel.setContacts(person, list);
async function only() {
  const all = await events.all();
  expect(all).toHaveLength(1);
  return events.get(all[0]!.id);
}
const rowOf = async (eventId: string) =>
  (
    await h.rows<Record<string, unknown>>(
      'SELECT status, input, matched, confidence, call_status, sampled, provider_call_id, reason FROM event.voice_screening WHERE event_id = $1',
      [eventId],
    )
  )[0];
/** INACTIVITY olayı açar ve sessiz soruyu cevapsız bırakır (ön elemeyi başlatır). */
async function inactivityUnanswered(last: string, person = PERSON) {
  await contacts(person, [{ role: 'ELDER', phone: phone(last) }]);
  await deliver(sig('INACTIVITY', { protectedPersonId: person }));
  const ev = await only();
  await timers.fire(ev.id, 'silent-ask-expire');
  return ev.id;
}
const settle = () => fake.screensSettled;

describe('Kabul: FakeProvider ile 3 senaryo', () => {
  it('1) "evet iyiyim" → olay OK kapanır (SYSTEM), sonuç kayıtlı, zamanlayıcı yok', async () => {
    const id = await inactivityUnanswered('2');
    // arama sürerken olay hâlâ cihaz sorusunda; ön eleme süresi kadar uzatıldı, süre zamanlayıcısı kurulu
    const during = await events.get(id);
    expect(during.state).toBe('DEVICE_PROMPT');
    expect(new Date(during.devicePromptUntil!).getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect(timers.pendingIds()).toEqual([`${id}.voice-screen-expire`]);
    expect(fake.screens).toEqual([{ to: phone('2'), text: t('V-SCREEN-ASK') }]);

    await settle();
    const ev = await events.get(id);
    expect(ev.state).toBe('CLOSED');
    expect(ev.confirmedOutcome).toBe('OK');
    const ok = ev.transitions.find((x) => x.to === 'CANCELLED_BY_USER')!;
    expect(ok.actorKind).toBe('SYSTEM');
    expect(ok.note).toBe('sesli ön eleme: iyiyim (SPEECH)');
    expect(ev.transitions.find((x) => x.to === 'CLOSED')!.actorKind).toBe('SYSTEM');
    expect(await rowOf(id)).toMatchObject({ status: 'OK', input: 'SPEECH', matched: 'evet', call_status: 'completed' });
    expect(timers.pendingIds()).toEqual([]);
    // yanlış alarm sayacına (kullanıcı iptali) yazılmaz: kişi sesle "iyiyim" dedi, olay OK teyitli
    const fa = await h.rows("SELECT 1 FROM event.outbox WHERE topic = 'event.false_alarm'");
    expect(fa).toEqual([]);
  });

  it('2) anlaşılmaz cevap → operatör kuyruğu', async () => {
    const id = await inactivityUnanswered('6');
    await settle();
    const ev = await events.get(id);
    expect(ev.state).toBe('OPERATOR_QUEUE');
    expect(ev.transitions.find((x) => x.to === 'ESCALATED')!.note).toBe('sesli ön eleme: anlaşılmadı');
    expect(await rowOf(id)).toMatchObject({ status: 'UNCLEAR', input: 'SPEECH', matched: null });
    expect(timers.pendingIds()).toEqual([]);
  });

  it('3) cevapsız arama → operatör kuyruğu', async () => {
    const id = await inactivityUnanswered('0');
    await settle();
    const ev = await events.get(id);
    expect(ev.state).toBe('OPERATOR_QUEUE');
    expect(ev.transitions.find((x) => x.to === 'ESCALATED')!.note).toBe('sesli ön eleme: cevapsız');
    expect(await rowOf(id)).toMatchObject({ status: 'NO_ANSWER', call_status: 'no-answer', input: null });
  });
});

describe('Diğer sonuçlar', () => {
  it.each([
    ['5', 'OK', 'DTMF', 'CLOSED'],
    ['8', 'NO_ANSWER', null, 'OPERATOR_QUEUE'],
    ['7', 'HELP', 'SPEECH', 'OPERATOR_QUEUE'],
    ['4', 'UNCLEAR', 'SPEECH', 'OPERATOR_QUEUE'],
    ['1', 'NO_ANSWER', null, 'OPERATOR_QUEUE'],
    ['9', 'FAILED', null, 'OPERATOR_QUEUE'],
  ])('son hane %s → %s (%s) → %s', async (last, status, input, state) => {
    const id = await inactivityUnanswered(last);
    await settle();
    expect(await rowOf(id)).toMatchObject({ status, input });
    expect((await events.get(id)).state).toBe(state);
  });

  it('gather yanıtı sonuca göre katalogdan TwiML: OK teşekkür, diğerleri operatör arayacak', async () => {
    const id = await inactivityUnanswered('2');
    await settle();
    const [{ id: sid }] = await h.rows<{ id: string }>('SELECT id FROM event.voice_screening WHERE event_id = $1', [
      id,
    ]);
    const ok = await screening.webhook('gather', sid, { Digits: '1' });
    expect(ok).toContain(t('V-SCREEN-OK'));
    expect(ok).toContain('<Hangup/>');
    const help = await screening.webhook('gather', sid, { SpeechResult: 'yardım' });
    expect(help).toContain(t('V-SCREEN-HELP'));
    // tekrar teslim: ilk sonuç kalır
    expect(await rowOf(id)).toMatchObject({ status: 'OK', input: 'SPEECH' });
    expect((await events.get(id)).state).toBe('CLOSED');
  });

  it('bilinmeyen ön eleme kimliği → boş TwiML', async () => {
    expect(await screening.webhook('gather', '018f0000-0000-7000-8000-000000000000', { Digits: '1' })).toContain(
      '<Response/>',
    );
  });
});

describe('Güvenlik ağları (olay kaybı sıfır)', () => {
  it('webhook hiç gelmezse süre dolunca cevapsız → kuyruk, arama kapatılır', async () => {
    transport = 'drop';
    const id = await inactivityUnanswered('2');
    await timers.fire(id, 'voice-screen-expire');
    const ev = await events.get(id);
    expect(ev.state).toBe('OPERATOR_QUEUE');
    expect(ev.transitions.find((x) => x.to === 'ESCALATED')!.note).toBe('sesli ön eleme: cevapsız');
    expect(await rowOf(id)).toMatchObject({ status: 'NO_ANSWER', reason: 'TIMEOUT' });
    expect(fake.hungUp).toHaveLength(1);
    // geç gelen webhook olayı değiştirmez
    const [{ id: sid }] = await h.rows<{ id: string }>('SELECT id FROM event.voice_screening WHERE event_id = $1', [
      id,
    ]);
    await screening.webhook('gather', sid, { Digits: '1' });
    expect((await events.get(id)).state).toBe('OPERATOR_QUEUE');
  });

  it('arama başlatılamazsa hemen kuyruk (FAILED)', async () => {
    fake.screenCall = async () => {
      throw new Error('sağlayıcı 500');
    };
    const id = await inactivityUnanswered('2');
    expect((await events.get(id)).state).toBe('OPERATOR_QUEUE');
    expect(await rowOf(id)).toMatchObject({ status: 'FAILED' });
    expect((await events.get(id)).transitions.find((x) => x.to === 'ESCALATED')!.note).toBe(
      'sesli ön eleme: aranamadı',
    );
  });

  it('ön eleme sürerken saatten "iyiyim" → yanlış alarm kapanışı, ön eleme iptal, arama kapatılır', async () => {
    transport = 'drop';
    const id = await inactivityUnanswered('2');
    await deliver(sig('OK', { protectedPersonId: PERSON }));
    expect((await events.get(id)).state).toBe('CLOSED');
    expect(await rowOf(id)).toMatchObject({ status: 'CANCELLED' });
    expect(fake.hungUp).toHaveLength(1);
    expect(timers.pendingIds()).toEqual([]);
  });

  it('ön eleme sürerken SOS → P1 kuyruk, ön eleme iptal', async () => {
    transport = 'drop';
    const id = await inactivityUnanswered('2');
    await deliver(sig('SOS', { protectedPersonId: PERSON }));
    const ev = await events.get(id);
    expect(ev).toMatchObject({ state: 'OPERATOR_QUEUE', priority: 1 });
    expect(await rowOf(id)).toMatchObject({ status: 'CANCELLED' });
  });

  it('tarama: süre + pay geçince ön eleme bekleyen olay da yükseltilir', async () => {
    transport = 'drop';
    const id = await inactivityUnanswered('2');
    expect(await events.recoverOverdue(-10 * 60_000)).toBe(1);
    expect((await events.get(id)).state).toBe('OPERATOR_QUEUE');
  });

  it('olay başına bir ön eleme: aynı zamanlayıcı ikinci kez gelirse yeni arama yok', async () => {
    transport = 'drop';
    const id = await inactivityUnanswered('2');
    await timers.fire(id, 'silent-ask-expire');
    expect(fake.screens).toHaveLength(1);
    expect((await events.get(id)).state).toBe('DEVICE_PROMPT');
  });

  it('kişinin telefonu/saat numarası yoksa ön elemesiz kuyruk', async () => {
    await deliver(sig('INACTIVITY', { protectedPersonId: PERSON }));
    const ev = await only();
    await timers.fire(ev.id, 'silent-ask-expire');
    expect((await events.get(ev.id)).state).toBe('OPERATOR_QUEUE');
    expect(fake.screens).toEqual([]);
    expect(await rowOf(ev.id)).toBeUndefined();
  });

  it('telefon numarası yoksa saatin numarası aranır (LTE saat)', async () => {
    await contacts(PERSON, [{ role: 'WATCH', phone: phone('3') }]);
    await deliver(sig('INACTIVITY', { protectedPersonId: PERSON }));
    const ev = await only();
    await timers.fire(ev.id, 'silent-ask-expire');
    expect(fake.screens.map((s) => s.to)).toEqual([phone('3')]);
  });

  it('telefoni kapalıysa (CPAAS_PROVIDER=off) ön elemesiz kuyruk', async () => {
    setup(BASE, 'off');
    await contacts(PERSON, [{ role: 'ELDER', phone: phone('2') }]);
    await deliver(sig('INACTIVITY', { protectedPersonId: PERSON }));
    const ev = await only();
    await timers.fire(ev.id, 'silent-ask-expire');
    expect((await events.get(ev.id)).state).toBe('OPERATOR_QUEUE');
  });

  it('kuralda kapalıysa ön elemesiz kuyruk', async () => {
    setup(packWith((r) => (rule(r, 'INACTIVITY').autoVoiceScreening!.enabled = false)));
    const id = await inactivityUnanswered('2');
    expect((await events.get(id)).state).toBe('OPERATOR_QUEUE');
    expect(fake.screens).toEqual([]);
  });

  it('numara audit/outbox/ön eleme satırına yazılmaz', async () => {
    const id = await inactivityUnanswered('2');
    await settle();
    const dump = JSON.stringify([
      await h.rows('SELECT * FROM audit.log WHERE entity_id = $1', [id]),
      await h.rows('SELECT envelope FROM event.outbox'),
      await h.rows('SELECT * FROM event.voice_screening'),
    ]);
    expect(dump).not.toContain(phone('2'));
    expect(dump).toContain('event.voice_screening_started');
  });
});

describe('Asla SOS/FALL', () => {
  it('FALL: paket ön eleme açsa bile soru cevapsız → doğrudan kuyruk', async () => {
    setup(
      packWith((r) => {
        rule(r, 'FALL').autoVoiceScreening = { ...rule(r, 'INACTIVITY').autoVoiceScreening! };
      }),
    );
    await contacts(PERSON, [{ role: 'ELDER', phone: phone('2') }]);
    await deliver(sig('FALL', { protectedPersonId: PERSON }));
    const ev = await only();
    await timers.fire(ev.id, 'prompt-expire');
    expect((await events.get(ev.id)).state).toBe('OPERATOR_QUEUE');
    expect(fake.screens).toEqual([]);
  });

  it('SOS: doğrudan kuyruk, arama yok', async () => {
    await contacts(PERSON, [{ role: 'ELDER', phone: phone('2') }]);
    await deliver(sig('SOS', { protectedPersonId: PERSON }));
    expect((await only()).state).toBe('OPERATOR_QUEUE');
    expect(fake.screens).toEqual([]);
  });

  it("kural şeması SOS/FALL'da autoVoiceScreening'i reddeder; tr.yaml geçerli", () => {
    const ajv = new Ajv2020({ allErrors: true });
    const validate = ajv.compile(JSON.parse(readFileSync(join(RULES_DIR, 'schema.json'), 'utf8')));
    expect(validate(BASE)).toBe(true);
    const bad = packWith((r) => {
      rule(r, 'SOS').autoVoiceScreening = { ...rule(r, 'INACTIVITY').autoVoiceScreening! };
    });
    expect(validate(bad)).toBe(false);
    const badFall = packWith((r) => {
      rule(r, 'FALL').autoVoiceScreening = { ...rule(r, 'INACTIVITY').autoVoiceScreening! };
    });
    expect(validate(badFall)).toBe(false);
  });
});

describe('WATCH_OFF', () => {
  it('saat takılmadı (bekleme doldu) → ön eleme; "evet" → OK kapanır', async () => {
    await contacts(PERSON, [{ role: 'ELDER', phone: phone('2') }]);
    await deliver(sig('OFF_BODY', { protectedPersonId: PERSON, occurredAt: '2026-11-10T09:00:00.000Z' }));
    const ev = await only();
    expect(ev.type).toBe('WATCH_OFF');
    await timers.fire(ev.id, 'watch-off-operator');
    expect(fake.screens).toHaveLength(1);
    await settle();
    expect(await events.get(ev.id)).toMatchObject({ state: 'CLOSED', confirmedOutcome: 'OK' });
  });
});

describe('Öğrenme modu ve operatör örneklemesi (ilk ay)', () => {
  let profile: ProfileService;
  const person = async () =>
    (await profile.create({ kind: 'FAMILY', id: 'fam-1' }, { displayName: 'Ayşe Y.' }, new Date())).id;
  beforeEach(() => {
    profile = new ProfileService(h.db, new FieldCipher(KEYS), undefined, null);
  });

  it('öğrenme modunda önce 2. sessiz soru, sonra ön eleme', async () => {
    const id = await person();
    await contacts(id, [{ role: 'ELDER', phone: phone('6') }]);
    await deliver(sig('INACTIVITY', { protectedPersonId: id }));
    const ev = await only();
    await timers.fire(ev.id, 'silent-ask-expire');
    expect(fake.screens).toEqual([]);
    expect(timers.pendingIds()).toEqual([`${ev.id}.learning-ask-expire`]);
    await timers.fire(ev.id, 'learning-ask-expire');
    expect(fake.screens).toHaveLength(1);
    await settle();
    expect((await events.get(ev.id)).state).toBe('OPERATOR_QUEUE');
  });

  it('örnekleme oranı 1: OK sonucu operatöre CALLBACK (P4) olarak düşer; istatistikte görünür', async () => {
    setup(packWith((r) => (rule(r, 'INACTIVITY').autoVoiceScreening!.operatorSampleRate = 1)));
    const id = await person();
    await contacts(id, [{ role: 'ELDER', phone: phone('2') }]);
    await deliver(sig('INACTIVITY', { protectedPersonId: id }));
    const [first] = await events.all();
    await timers.fire(first!.id, 'silent-ask-expire');
    await timers.fire(first!.id, 'learning-ask-expire');
    await settle();
    expect((await events.get(first!.id)).state).toBe('CLOSED');
    expect(await rowOf(first!.id)).toMatchObject({ status: 'OK', sampled: true });
    const cb = await events.get((await events.all()).find((e) => e.type === 'CALLBACK')!.id);
    expect(cb).toMatchObject({ priority: 4, state: 'OPERATOR_QUEUE' });
    expect(cb.transitions[0]!.note).toBe('sesli ön eleme örneklemesi');

    // operatör geri arar, kişi aslında iyi değil → yanlış pozitif
    await events.claim(cb.id, 'op-1');
    await events.closeByOperator(cb.id, 'op-1', 'EMERGENCY');
    const s = await screening.stats(new Date(Date.now() - 3600_000));
    expect(s).toMatchObject({
      total: 1,
      byResult: { OK: 1 },
      sampled: 1,
      sampleReviewed: 1,
      sampleFalsePositive: 1,
    });
  });

  it('öğrenme modu dışında örneklem yok (oran 1 olsa da)', async () => {
    setup(packWith((r) => (rule(r, 'INACTIVITY').autoVoiceScreening!.operatorSampleRate = 1)));
    const id = await inactivityUnanswered('2');
    await settle();
    expect(await rowOf(id)).toMatchObject({ status: 'OK', sampled: false });
    expect((await events.all()).filter((e) => e.type === 'CALLBACK')).toEqual([]);
  });
});

describe('classifyScreening (saf)', () => {
  const cfg: ScreeningConfig = {
    acceptIf: ['evet', 'iyiyim'],
    helpIf: ['hayır', 'yardım', 'imdat', 'değil', 'kötü'],
    acceptDigits: ['1'],
    minConfidence: 0.5,
  };
  it.each([
    [{ Digits: '1' }, 'OK', 'DTMF', '1'],
    [{ Digits: '2' }, 'UNCLEAR', 'DTMF', null],
    [{ SpeechResult: 'EVET.', Confidence: '0.9' }, 'OK', 'SPEECH', 'evet'],
    [{ SpeechResult: 'İyiyim kızım', Confidence: '0.8' }, 'OK', 'SPEECH', 'iyiyim'],
    [{ SpeechResult: 'iyi değilim', Confidence: '0.9' }, 'HELP', 'SPEECH', 'değil'],
    [{ SpeechResult: 'evet ama yardım lazım', Confidence: '0.9' }, 'HELP', 'SPEECH', 'yardım'],
    [{ SpeechResult: 'Hayır', Confidence: '0.2' }, 'HELP', 'SPEECH', 'hayır'],
    [{ SpeechResult: 'evet', Confidence: '0.3' }, 'UNCLEAR', 'SPEECH', null],
    [{ SpeechResult: 'evet' }, 'OK', 'SPEECH', 'evet'],
    [{ SpeechResult: 'nevet' }, 'UNCLEAR', 'SPEECH', null],
    [{ SpeechResult: '' }, 'NO_ANSWER', null, null],
    [{}, 'NO_ANSWER', null, null],
  ])('%j → %s', (p, status, input, matched) => {
    expect(classifyScreening(p as Record<string, string>, cfg)).toMatchObject({ status, input, matched });
  });
});

describe('Webhook ucu ve Twilio', () => {
  it('imzasız/bozuk imza 403; geçerli imza işlenir', async () => {
    transport = 'drop';
    const id = await inactivityUnanswered('2');
    const [{ id: sid }] = await h.rows<{ id: string }>('SELECT id FROM event.voice_screening WHERE event_id = $1', [
      id,
    ]);
    const ctrl = new ScreeningWebhookController(screening, tel);
    const path = `/v1/webhooks/screening/gather?s=${sid}`;
    const body = { Digits: '1' };
    const res = { setHeader: () => undefined };
    await expect(ctrl.webhook('gather', sid, body, 'bozuk', { originalUrl: path }, res)).rejects.toMatchObject({
      status: 403,
    });
    const sigOk = cpaasSignature(FAKE_CPAAS_TOKEN, `${ENV.CPAAS_WEBHOOK_BASE}${path}`, body);
    await expect(ctrl.webhook('nope', sid, body, sigOk, { originalUrl: path }, res)).rejects.toMatchObject({
      status: 404,
    });
    const twiml = await ctrl.webhook('gather', sid, body, sigOk, { originalUrl: path }, res);
    expect(twiml).toContain(t('V-SCREEN-OK'));
    expect((await events.get(id)).state).toBe('CLOSED');
  });

  it('TwiML: DTMF + konuşma (tr-TR), soru bir kez tekrarlanır, boş sonuçta da action çağrılır', () => {
    const x = screenTwiml({
      ask: t('V-SCREEN-ASK'),
      gatherUrl: 'https://api.test/v1/webhooks/screening/gather?s=1&x=2',
      hints: ['evet', 'iyiyim'],
      digits: 1,
    });
    expect(x.match(/<Gather /g)).toHaveLength(2);
    expect(x).toContain('input="dtmf speech"');
    expect(x).toContain('language="tr-TR"');
    expect(x).toContain('numDigits="1"');
    expect(x).toContain('hints="evet, iyiyim"');
    expect(x).toContain('actionOnEmptyResult="true"');
    expect(x).toContain('s=1&amp;x=2');
    expect(x).toContain('&apos;evet&apos;');
  });

  it('TwilioProvider.screenCall: arama TwiML ile, durum geri çağrısı, numara gövdede yalnız To', async () => {
    const reqs: { url: string; body: URLSearchParams }[] = [];
    const http = (async (url: string, init: { body: URLSearchParams }) => {
      reqs.push({ url, body: init.body });
      return new Response(JSON.stringify({ sid: 'CA123' }), { status: 201 });
    }) as unknown as typeof fetch;
    const tw = new TwilioProvider({ accountSid: 'AC1', authToken: 'tok', from: '+902120000001' }, http);
    const r = await tw.screenCall({
      screeningId: 's1',
      to: '+905550000012',
      ask: 'soru',
      hints: ['evet'],
      digits: 1,
      ringTimeoutSec: 25,
      urls: { gather: 'https://api.test/g', status: 'https://api.test/s' },
    });
    expect(r).toEqual({ providerCallId: 'CA123' });
    const b = reqs[0]!.body;
    expect(reqs[0]!.url).toMatch(/\/Accounts\/AC1\/Calls\.json$/);
    expect(b.get('To')).toBe('+905550000012');
    expect(b.get('StatusCallback')).toBe('https://api.test/s');
    expect(b.getAll('StatusCallbackEvent')).toEqual(['initiated', 'ringing', 'answered', 'completed']);
    expect(b.get('Timeout')).toBe('25');
    expect(b.get('Twiml')).toContain('<Gather ');
  });
});
