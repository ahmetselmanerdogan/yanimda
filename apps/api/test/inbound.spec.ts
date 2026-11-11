import type { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { KafkaEnvelope, Signal } from '@yanimda/contracts';
import { t } from '@yanimda/messages';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '../src/common/bus';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { ChainService } from '../src/modules/chain/chain.service';
import { loadProcedures } from '../src/modules/chain/procedures';
import { OidcGuard, ROLES_KEY } from '../src/modules/identity/oidc.guard';
import { oidcConfigFromEnv, OidcVerifier } from '../src/modules/identity/oidc-verifier';
import { SupervisorService } from '../src/modules/metrics/supervisor.service';
import { cpaasSignature } from '../src/modules/telephony/cpaas';
import { FAKE_CPAAS_TOKEN, FakeProvider } from '../src/modules/telephony/fake-cpaas';
import {
  InboundWebhookController,
  OperatorsController,
  TelephonyConfigController,
} from '../src/modules/telephony/inbound.controller';
import { InboundService } from '../src/modules/telephony/inbound.service';
import { MemoryRecordingStore } from '../src/modules/telephony/recording-store';
import { TelephonyService } from '../src/modules/telephony/telephony.service';
import { type FakeOidc, startFakeOidc } from './support/fake-oidc';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * T-051 kalan (E-05): gelen SOS aramaları. Kabul:
 *  - olayı olan kişiden (rehberdeki saat/telefon numarası) gelen arama o olayı yürüten operatöre çalar
 *  - yoksa bağlı (90 sn içinde görülen) ve AVAILABLE operatörler, en uzun boşta kalan önce, sırayla
 *  - kimse yoksa kuyruk + bekleme anonsu (katalog V-INBOUND-WAIT); operatör müsait olunca kuyruktan ona bağlanır
 *  - operatör kendi durumunu seçer (`PUT /v1/operators/me/status`); molada olan çalmaz
 *  - arayan numara hiçbir kayıtta (satır, audit) yok; görüşme kaydı depoda
 */
const ENV = {
  CPAAS_WEBHOOK_BASE: 'https://api.test',
  COUNTRY_CODE: 'TR',
  CPAAS_AGENT_NUMBER: '+902120000000',
  INBOUND_RING_SEC: '20',
  INBOUND_RETRY_SEC: '30',
};
const PERSON = 'pp-inbound';
const WATCH = '+905550000005';
const STRANGER = '+905559999999';
const SERVICE = '+908500000000';

let h: Harness;
let fake: FakeProvider;
let store: MemoryRecordingStore;
let tel: TelephonyService;
let inbound: InboundService;
let sup: SupervisorService;
let chain: ChainService;
let idp: FakeOidc;

const make = (env: Record<string, string> = ENV) => {
  tel = new TelephonyService(h.db, h.outbox, fake, store, env);
  inbound = new InboundService(h.db, h.outbox, tel, fake, store, env);
};

beforeAll(async () => {
  h = await createHarness();
  idp = await startFakeOidc();
});
beforeEach(async () => {
  await h.reset();
  store = new MemoryRecordingStore();
  fake = new FakeProvider({ stepMs: 1 });
  sup = new SupervisorService(h.db);
  make();
  chain = new ChainService(h.db, h.events(new InMemoryTimers()), loadProcedures(), tel);
  await tel.setContacts(PERSON, [{ role: 'WATCH', phone: WATCH }]);
});
afterAll(async () => {
  await h.close();
  await idp.close();
});

const ago = (sec: number, from = new Date()) => new Date(from.getTime() - sec * 1000);

/** Operatör bağlı (WS "görüldü") ve durumu `status` (statusAt: boşta kalmaya başladığı an). */
async function operator(sub: string, status: 'AVAILABLE' | 'BREAK' | 'OFFLINE', statusAt: Date, seenAt = new Date()) {
  await sup.seen(sub, `Ad ${sub}`, 'OPERATOR', seenAt);
  await sup.setStatus(sub, status, 'amir', statusAt);
}

const ring = (from: string, sid = `CA${Math.random().toString(16).slice(2)}`) =>
  inbound.webhook('call', undefined, { CallSid: sid, From: from, To: SERVICE, CallStatus: 'ringing' });

/** TwiML'den çalan uç: yazılım telefonu kimliği ya da masa hattı. */
const target = (twiml: string) =>
  /<Identity>([^<]+)<\/Identity>/.exec(twiml)?.[1] ?? /<Number[^>]*>([^<]+)<\/Number>/.exec(twiml)?.[1] ?? null;
const idOf = (twiml: string) => /call=([0-9a-f-]{36})/.exec(twiml)?.[1] ?? '';
const rowOf = async (id: string) =>
  (await h.rows<Record<string, unknown>>('SELECT * FROM telephony.inbound_call WHERE id = $1', [id]))[0]!;

async function openEvent(claimedBy?: string): Promise<string> {
  await bus.deliver<Signal>('signal.received', {
    payload: sig('SOS', { protectedPersonId: PERSON }),
  } as unknown as KafkaEnvelope<Signal>);
  const [{ id }] = await h.rows<{ id: string }>('SELECT id FROM event.event WHERE protected_person_id = $1', [PERSON]);
  if (claimedBy) await chain.claim(id, claimedBy);
  return id;
}

describe('gelen SOS araması: yönlendirme', () => {
  it('kayıtsız numara: en uzun boşta kalan müsait operatör çalar, cevapsızsa sıradaki; molada, bağlı değil, amir ve aramada olan atlanır', async () => {
    const now = new Date();
    await operator('op-a', 'AVAILABLE', ago(600, now));
    await operator('op-b', 'AVAILABLE', ago(300, now));
    await operator('op-c', 'BREAK', ago(900, now));
    await operator('op-d', 'AVAILABLE', ago(1200, now), ago(300, now)); // 5 dk önce görüldü: bağlı değil
    await sup.seen('sup-1', 'Amir', 'SUPERVISOR', now);
    await operator('op-e', 'AVAILABLE', ago(1800, now));
    const ev = await openEvent();
    // op-e giden bir aramada (köprü sürüyor): çalmaz.
    await h.rows(
      `INSERT INTO telephony.call (id, event_id, step_n, operator_id, provider, status)
       VALUES (gen_random_uuid(), $1, 1, 'op-e', 'fake', 'in-progress')`,
      [ev],
    );

    const first = await ring(STRANGER);
    expect(first).toContain(t('V-CALL-RECORDED'));
    expect(target(first)).toBe('op_a');
    expect(first).toContain('timeout="20"');
    expect(first).toContain('record="record-from-answer-dual"');
    const id = idOf(first);
    expect(first).toContain(`<Parameter name="inboundId" value="${id}"/>`);
    expect(await rowOf(id)).toMatchObject({ status: 'ringing', operator_id: 'op-a', event_id: null });

    const second = await inbound.webhook('dial', id, { DialCallStatus: 'no-answer' });
    expect(target(second)).toBe('op_b');
    expect(second).not.toContain(t('V-CALL-RECORDED')); // anons yalnız başta

    const third = await inbound.webhook('dial', id, { DialCallStatus: 'busy' });
    expect(third).toContain('<Enqueue');
    const row = await rowOf(id);
    expect(row.status).toBe('queued');
    expect((row.attempts as { op: string; result: string }[]).map((a) => [a.op, a.result])).toEqual([
      ['op-a', 'no-answer'],
      ['op-b', 'busy'],
    ]);
  });

  it('olayı olan kişiden: olayı yürüten operatöre (molada olsa bile); cevapsızsa müsaitlere', async () => {
    const now = new Date();
    await operator('op-x', 'BREAK', ago(60, now));
    await operator('op-a', 'AVAILABLE', ago(600, now));
    const ev = await openEvent('op-x');

    const first = await ring(WATCH);
    const id = idOf(first);
    expect(target(first)).toBe('op_x');
    expect(first).toContain(`<Parameter name="eventId" value="${ev}"/>`);
    expect(await rowOf(id)).toMatchObject({ event_id: ev, protected_person_id: PERSON });

    const next = await inbound.webhook('dial', id, { DialCallStatus: 'no-answer' });
    expect(target(next)).toBe('op_a');
  });

  it('asılı giden arama (eski queued / en uzun süreyi aşan in-progress) operatörü meşgul göstermez', async () => {
    const now = new Date();
    await operator('op-a', 'AVAILABLE', ago(600, now));
    const ev = await openEvent();
    const insert = (status: string, updatedSecAgo: number, createdSecAgo: number) =>
      h.rows(
        `INSERT INTO telephony.call (id, event_id, step_n, operator_id, provider, status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 1, 'op-a', 'fake', $2,
                 now() - make_interval(secs => $4), now() - make_interval(secs => $3))`,
        [ev, status, updatedSecAgo, createdSecAgo],
      );
    // Taze queued: meşgul → kuyruk.
    await insert('queued', 10, 10);
    expect(await ring(STRANGER)).toContain('<Enqueue');
    await h.rows('DELETE FROM telephony.call');
    await h.rows('DELETE FROM telephony.inbound_call');
    // 10 dk önce queued kalmış (arama öncesi çökme) ve 3 saatlik in-progress (webhook gelmedi): meşgul değil.
    await insert('queued', 600, 600);
    await insert('in-progress', 3000, 3 * 3600);
    expect(target(await ring(STRANGER))).toBe('op_a');
  });

  it('SIP trunk biçimindeki arayan (ulusal biçim, sip: URI) da eşleşir', async () => {
    await operator('op-x', 'AVAILABLE', ago(60));
    const ev = await openEvent('op-x');
    const twiml = await ring('sip:05550000005@yanimda.sip.twilio.com');
    expect(await rowOf(idOf(twiml))).toMatchObject({ event_id: ev });
  });

  it('kimse yoksa kuyruk + bekleme anonsu; operatör müsait olunca kuyruktan çıkarılıp ona bağlanır', async () => {
    const first = await ring(STRANGER);
    const id = idOf(first);
    expect(first).toContain('<Enqueue');
    expect(first).toContain(`waitUrl="https://api.test/v1/webhooks/cpaas-inbound/wait?call=${id}"`);
    expect(first).toContain(`action="https://api.test/v1/webhooks/cpaas-inbound/leave?call=${id}"`);
    expect((await rowOf(id)).queued_at).not.toBeNull();

    const hold = await inbound.webhook('wait', id, { QueuePosition: '1', QueueTime: '5' });
    expect(hold).toContain(t('V-INBOUND-WAIT'));
    expect(hold).toMatch(/<Pause length="\d+"\/>/);
    expect(hold).not.toContain('<Leave/>');

    // Operatör kendi durumunu "Müsait" yapar (konsol üst barı).
    await sup.seen('op-a', 'Ayşe', 'OPERATOR');
    const ops = new OperatorsController(sup, inbound);
    await ops.setMine({ status: 'BREAK' }, req('op-a'));
    expect(await inbound.webhook('wait', id, {})).not.toContain('<Leave/>');
    await ops.setMine({ status: 'AVAILABLE' }, req('op-a'));
    expect(await inbound.webhook('wait', id, {})).toContain('<Leave/>');

    const dial = await inbound.webhook('leave', id, { QueueResult: 'leave', QueueTime: '12' });
    expect(target(dial)).toBe('op_a');
  });

  it('cevapsız operatör INBOUND_RETRY_SEC sonra yeniden denenir', async () => {
    const now = new Date();
    await operator('op-a', 'AVAILABLE', ago(600, now));
    const id = idOf(await ring(STRANGER));
    expect(await inbound.webhook('dial', id, { DialCallStatus: 'no-answer' }, now)).toContain('<Enqueue');
    await sup.seen('op-a', null, 'OPERATOR', new Date(now.getTime() + 20_000));
    expect(await inbound.webhook('wait', id, {}, new Date(now.getTime() + 20_000))).not.toContain('<Leave/>');
    await sup.seen('op-a', null, 'OPERATOR', new Date(now.getTime() + 31_000));
    expect(await inbound.webhook('wait', id, {}, new Date(now.getTime() + 31_000))).toContain('<Leave/>');
  });

  it('cevaplandı: bağlı → bitti (süre), kayıt depoda ve sağlayıcıdan silinir; numara hiçbir kayıtta yok', async () => {
    await operator('op-a', 'AVAILABLE', ago(600));
    const id = idOf(await ring(STRANGER));
    await inbound.webhook('agent', id, { CallSid: 'CAchild', CallStatus: 'in-progress' });
    expect(await rowOf(id)).toMatchObject({ status: 'connected', operator_id: 'op-a' });
    expect((await rowOf(id)).answered_at).not.toBeNull();

    // Bağlıyken başka gelen arama op-a'yı çaldırmaz.
    expect(await ring(STRANGER)).toContain('<Enqueue');

    const end = await inbound.webhook('dial', id, { DialCallStatus: 'completed', DialCallDuration: '42' });
    expect(end).toContain('<Hangup/>');
    expect(await rowOf(id)).toMatchObject({ status: 'completed', duration_sec: 42 });

    fake.recordings.set('RE1', Buffer.from('FAKE-MP3'));
    await inbound.webhook('recording', id, { RecordingSid: 'RE1', RecordingStatus: 'completed' });
    expect(store.objects.has(`recordings/tr/inbound/${id}.mp3`)).toBe(true);
    expect(fake.deleted).toContain('RE1');
    expect(await rowOf(id)).toMatchObject({ recording_ref: `recordings/tr/inbound/${id}.mp3` });

    const audit = await h.rows<{ action: string }>(
      `SELECT action, data FROM audit.log WHERE data->>'inboundId' = $1 ORDER BY id`,
      [id],
    );
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'telephony.inbound.received',
        'telephony.inbound.ringing',
        'telephony.inbound.answered',
        'telephony.inbound.ended',
        'telephony.recording.stored',
      ]),
    );
    const dump = JSON.stringify([audit, await h.rows('SELECT * FROM telephony.inbound_call')]);
    expect(dump).not.toContain('5559999999');
  });

  it('kuyrukta arayan kapatırsa abandoned (numara düzeyi durum geri çağrısı CallSid ile)', async () => {
    const id = idOf(await ring(STRANGER, 'CAgone'));
    await inbound.webhook('status', undefined, { CallSid: 'CAgone', CallStatus: 'completed', CallDuration: '30' });
    const row = await rowOf(id);
    expect(row.status).toBe('abandoned');
    expect(row.ended_at).not.toBeNull();
    // Kuyruktan sağlayıcının "hangup" sonucu da aynı yere varır; bitmiş aramada bekleme döngüsü kapatır.
    expect(await inbound.webhook('leave', id, { QueueResult: 'hangup' })).toContain('<Hangup/>');
    expect(await inbound.webhook('wait', id, {})).toContain('<Hangup/>');
  });

  it('aynı CallSid tekrar gelirse yeni kayıt açılmaz; eşzamanlı iki arama farklı operatörlere düşer', async () => {
    await operator('op-a', 'AVAILABLE', ago(600));
    await operator('op-b', 'AVAILABLE', ago(300));
    const [x, y] = await Promise.all([ring(STRANGER, 'CA1'), ring(STRANGER, 'CA2')]);
    expect(new Set([target(x), target(y)])).toEqual(new Set(['op_a', 'op_b']));
    const again = await ring(STRANGER, 'CA1');
    expect(idOf(again)).toBe(idOf(x));
    expect(await h.rows('SELECT id FROM telephony.inbound_call')).toHaveLength(2);
  });

  it('masa hattı modu (yazılım telefonu kapalı): masa hattı çalar; cevapsızsa kuyruk', async () => {
    make({ ...ENV, CPAAS_SOFTPHONE: 'off' });
    const twiml = await ring(STRANGER);
    expect(target(twiml)).toBe('+902120000000');
    expect(await inbound.webhook('dial', idOf(twiml), { DialCallStatus: 'no-answer' })).toContain('<Enqueue');
  });
});

const req = (sub: string, roles = ['OPERATOR']) => ({ headers: {}, user: { sub, roles } }) as never;
const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as { status?: number }).status ?? (e as Error).message;
  }
};

describe('operatörün kendi durumu (PUT /v1/operators/me/status)', () => {
  it('AVAILABLE ve BREAK seçilir (audit); OFFLINE ve geçersiz 400; GET kendi durumunu döner', async () => {
    const ops = new OperatorsController(sup, inbound);
    expect(await ops.mine(req('op-1'))).toMatchObject({ subject: 'op-1', status: 'AVAILABLE' });
    expect(await ops.setMine({ status: 'BREAK' }, req('op-1'))).toMatchObject({ subject: 'op-1', status: 'BREAK' });
    expect(await ops.mine(req('op-1'))).toMatchObject({ status: 'BREAK' });
    expect(await status(ops.setMine({ status: 'OFFLINE' }, req('op-1')))).toBe(400);
    expect(await status(ops.setMine({ status: 'x' }, req('op-1')))).toBe(400);
    const audit = await h.rows<{ actor_id: string; data: { status: string } }>(
      `SELECT actor_id, data FROM audit.log WHERE action = 'operator.status' AND entity_id = 'op-1'`,
    );
    expect(audit).toEqual([expect.objectContaining({ actor_id: 'op-1', data: { status: 'BREAK' } })]);
  });

  it('OidcGuard + OPERATOR/SUPERVISOR; FAMILY 403', async () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, OperatorsController)).toContain(OidcGuard);
    expect(Reflect.getMetadata(ROLES_KEY, OperatorsController)).toEqual(['OPERATOR', 'SUPERVISOR']);
    const g = new OidcGuard(new OidcVerifier(oidcConfigFromEnv(idp.env)), new Reflector());
    const ctx = (token: string) =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: `Bearer ${token}` } }) }),
        getHandler: () => OperatorsController.prototype.setMine,
        getClass: () => OperatorsController,
      }) as unknown as ExecutionContext;
    expect(await status(g.canActivate(ctx(idp.token({ realm: 'consumers', roles: ['FAMILY'] }))))).toBe(403);
    expect(await g.canActivate(ctx(idp.token({ roles: ['OPERATOR'] })))).toBe(true);
  });
});

describe('gelen arama webhook denetleyicisi', () => {
  const call = (
    ctl: InboundWebhookController,
    kind: string,
    params: Record<string, string>,
    q: string | undefined,
    signature?: string,
  ) => {
    const path = `/v1/webhooks/cpaas-inbound/${kind}${q ? `?call=${q}` : ''}`;
    const sigv = signature ?? cpaasSignature(FAKE_CPAAS_TOKEN, `https://api.test${path}`, params);
    const headers: Record<string, string> = {};
    return ctl.webhook(
      kind,
      q as string,
      params,
      sigv,
      { originalUrl: path },
      { setHeader: (k, v) => (headers[k] = v) },
    );
  };

  it('imzalı istek TwiML döner; imza bozuksa 403; bilinmeyen tür 404; call gereken türde uuid yoksa 404', async () => {
    const ctl = new InboundWebhookController(inbound, tel);
    const ok = await call(ctl, 'call', { CallSid: 'CAz', From: STRANGER, To: SERVICE }, undefined);
    expect(ok).toContain('<Response>');
    expect(await status(call(ctl, 'call', { CallSid: 'CAz', From: STRANGER }, undefined, 'bozuk'))).toBe(403);
    expect(await status(call(ctl, 'nope', {}, undefined))).toBe(404);
    expect(await status(call(ctl, 'wait', {}, 'abc'))).toBe(404);
  });
});

describe('telefoni yapılandırması (GET /v1/telephony/config)', () => {
  it('masa hattı ulusal biçimde, 112 kural paketinden; numara yoksa null', () => {
    const ctl = new TelephonyConfigController(inbound);
    expect(ctl.config()).toEqual({
      softphone: true,
      inbound: true,
      deskLine: '0212 000 00 00',
      emergencyNumber: '112',
    });
    make({ CPAAS_WEBHOOK_BASE: 'https://api.test', CPAAS_SOFTPHONE: 'off' });
    expect(new TelephonyConfigController(inbound).config()).toMatchObject({ softphone: false, deskLine: null });
  });
});
