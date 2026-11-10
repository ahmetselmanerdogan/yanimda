import { randomBytes } from 'node:crypto';

import type { FalseAlarm, KafkaEnvelope, Signal } from '@yanimda/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '../src/common/bus';
import { FieldCipher } from '../src/common/field-cipher';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import type { EventService } from '../src/modules/event/event.service';
import { FalseAlarmService } from '../src/modules/false-alarm/false-alarm.service';
import { SupervisorService } from '../src/modules/metrics/supervisor.service';
import type { Actor } from '../src/modules/profile/contacts';
import { ProfileService } from '../src/modules/profile/profile.service';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * T-071 (D-07, C-12) yanlış alarm yönetimi. Kabul: 3 iptal → bildirim + CALLBACK olayı; oran metriği doğru.
 * Ek: neden (USER_CANCEL / OPERATOR / FAMILY_FEEDBACK), olay başına bir kayıt, test olayı sayılmaz, 4. tekrarda
 * ikinci görüşme yok, aile geri bildirimi yalnız kendi kişisinin kapanmış olayına.
 */
const ALICE: Actor = { kind: 'FAMILY', id: 'fam-alice' };
const BOB: Actor = { kind: 'FAMILY', id: 'fam-bob' };
const OP = 'op-1';

let h: Harness;
let profile: ProfileService;
let timers: InMemoryTimers;
let events: EventService;
let falseAlarms: FalseAlarmService;
let pp: string;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  profile = new ProfileService(h.db, new FieldCipher(`k1:${randomBytes(32).toString('base64')}`), undefined, null);
  timers = new InMemoryTimers();
  events = h.events(timers);
  falseAlarms = new FalseAlarmService(h.db, h.outbox, events, profile);
  falseAlarms.subscribe(bus);
  pp = (await profile.create(ALICE, { displayName: 'Ayşe Y.' })).id;
});
afterAll(async () => {
  await h.close();
});

const deliver = (s: ReturnType<typeof sig>) =>
  bus.deliver<Signal>('signal.received', { payload: s } as unknown as KafkaEnvelope<Signal>);
/** Outbox → bus (event.false_alarm tüketilir). */
const pump = () => h.worker().drain();
const openEvent = async () => (await events.all()).find((e) => e.state !== 'CLOSED')!;

/** Kişi saatten iptal eder (FALL sorusuna "İyiyim"). */
async function userCancel() {
  await deliver(sig('FALL', { protectedPersonId: pp }));
  const ev = await openEvent();
  await deliver(sig('CANCEL', { protectedPersonId: pp }));
  await pump();
  return ev.id;
}
/** Operatör olayı üstlenip verilen sonuçla kapatır. */
async function operatorClose(outcome: string, kind = 'CALLBACK_REQUEST') {
  await deliver(sig(kind, { protectedPersonId: pp }));
  const ev = await openEvent();
  await events.claim(ev.id, OP);
  await events.closeByOperator(ev.id, OP, outcome);
  await pump();
  return ev.id;
}
const recorded = () =>
  h.rows<{ event_id: string; cause: string; review_at: Date | null }>(
    'SELECT event_id, cause, review_at FROM event.false_alarm ORDER BY at',
  );
const familyNotices = async () =>
  (
    await h.rows<{ envelope: { payload: { code: string; audience: string; eventId?: string; vars?: unknown } } }>(
      "SELECT envelope FROM event.outbox WHERE topic = 'notify.requested' ORDER BY id",
    )
  )
    .map((r) => r.envelope.payload)
    .filter((p) => p.audience === 'FAMILY');
const callbacks = async () => (await events.all()).filter((e) => e.type === 'CALLBACK' && e.state !== 'CLOSED');
const status = (p: Promise<unknown>) => p.then(() => 200).catch((e: { status?: number }) => e.status);

describe('event.false_alarm kaydı ve nedeni', () => {
  it('kişi iptali → USER_CANCEL; operatör FALSE_ALARM → OPERATOR; OK kapanışı kayıt değil', async () => {
    const a = await userCancel();
    const b = await operatorClose('FALSE_ALARM');
    await operatorClose('OK');
    expect(await recorded()).toEqual([
      expect.objectContaining({ event_id: a, cause: 'USER_CANCEL', review_at: null }),
      expect.objectContaining({ event_id: b, cause: 'OPERATOR', review_at: null }),
    ]);
  });

  it('test olayı yanlış alarm sayılmaz', async () => {
    await operatorClose('FALSE_ALARM', 'TEST');
    expect(await recorded()).toEqual([]);
  });

  it('aynı olay tekrar teslim edilirse bir kez kaydedilir (ilk neden kalır)', async () => {
    const id = await userCancel();
    const fa: FalseAlarm = {
      protectedPersonId: pp,
      eventId: id,
      eventType: 'FALL',
      cause: 'FAMILY_FEEDBACK',
      at: new Date().toISOString(),
    };
    expect(await falseAlarms.record(fa)).toEqual({ recorded: false, review: false });
    expect((await recorded()).map((r) => r.cause)).toEqual(['USER_CANCEL']);
  });
});

describe('3. tekrarda eşik görüşmesi (30 gün)', () => {
  it('3 iptal → aileye F-EVT-OK + F-FA-REVIEW ve konsolda CALLBACK P4 "eşik görüşmesi"', async () => {
    await userCancel();
    await userCancel();
    expect(await callbacks()).toEqual([]);
    expect((await familyNotices()).filter((n) => n.code === 'F-FA-REVIEW')).toEqual([]);
    const third = await userCancel();

    const cb = await callbacks();
    expect(cb).toHaveLength(1);
    expect(cb[0]).toMatchObject({ type: 'CALLBACK', priority: 4, state: 'OPERATOR_QUEUE' });
    expect(cb[0]!.sourceSignalIds).toEqual([`false-alarm-review:${third}`]);
    const full = await events.get(cb[0]!.id);
    expect(full.transitions[0]).toMatchObject({ to: 'CREATED', note: 'eşik görüşmesi: 30 günde 3 yanlış alarm' });

    const notices = (await familyNotices()).filter((n) => n.eventId === third);
    expect(notices.map((n) => n.code).sort()).toEqual(['F-EVT-OK', 'F-FA-REVIEW']);
    expect(notices.find((n) => n.code === 'F-FA-REVIEW')!.vars).toEqual({ count: 3, windowDays: 30 });
    expect((await recorded()).filter((r) => r.review_at).map((r) => r.event_id)).toEqual([third]);
  });

  it('karışık nedenler de sayılır (iptal + operatör + aile); 4. tekrarda ikinci görüşme açılmaz', async () => {
    await userCancel();
    await operatorClose('FALSE_ALARM');
    const ok = await operatorClose('OK');
    await falseAlarms.feedback(ALICE, ok, { real: false });
    await pump();
    expect(await callbacks()).toHaveLength(1);
    // görüşme operatörde kapanır; 4. yanlış alarm yeni görüşme açmaz
    const cb = (await callbacks())[0]!;
    await events.claim(cb.id, OP);
    await events.closeByOperator(cb.id, OP, 'OK');
    await userCancel();
    expect(await callbacks()).toEqual([]);
    expect((await familyNotices()).filter((n) => n.code === 'F-FA-REVIEW')).toHaveLength(1);
    // Bulgu 11: tetikleyen kayıt aile geri bildirimi → "saatini iptal etti" (F-EVT-OK) gönderilmez.
    expect((await familyNotices()).filter((n) => n.code === 'F-EVT-OK')).toEqual([]);
  });

  it('acil olarak teyit edilmiş olay aile görüşüyle yanlış alarm sayılmaz: 409, kayıt yok (bulgu 11)', async () => {
    const em = await operatorClose('EMERGENCY', 'SOS');
    expect(await status(falseAlarms.feedback(ALICE, em, { real: false }))).toBe(409);
    await pump();
    expect(await recorded()).toEqual([]);
  });

  it('tekrar teslim (en az bir kez): görüşme ve bildirim tek', async () => {
    await userCancel();
    await userCancel();
    const third = await userCancel();
    const again: FalseAlarm = {
      protectedPersonId: pp,
      eventId: third,
      eventType: 'FALL',
      cause: 'USER_CANCEL',
      at: new Date().toISOString(),
    };
    expect(await falseAlarms.record(again)).toEqual({ recorded: false, review: true });
    expect(await callbacks()).toHaveLength(1);
    // Bildirim satırı tekrarı notify planında dedupeKey ile ayıklanır (aynı anahtar).
    const keys = (
      await h.rows<{ envelope: { payload: { code: string; dedupeKey: string } } }>(
        "SELECT envelope FROM event.outbox WHERE topic = 'notify.requested'",
      )
    )
      .map((r) => r.envelope.payload)
      .filter((p) => p.code === 'F-FA-REVIEW')
      .map((p) => p.dedupeKey);
    expect(new Set(keys)).toEqual(new Set([`false-alarm-review:${third}`]));
  });

  it('30 günden eski kayıtlar sayılmaz', async () => {
    await userCancel();
    await userCancel();
    await h.exec.exec("UPDATE event.false_alarm SET at = now() - interval '31 days'");
    await userCancel();
    expect(await callbacks()).toEqual([]);
  });
});

describe('C-12 aile geri bildirimi "Gerçek miydi?"', () => {
  it('real=false → FAMILY_FEEDBACK kaydı; real=true → kayıt yok; son cevap saklanır', async () => {
    const a = await operatorClose('OK');
    const b = await operatorClose('OK');
    expect(await falseAlarms.feedback(ALICE, a, { real: true })).toEqual({ eventId: a, real: true, falseAlarm: false });
    expect(await falseAlarms.feedback(ALICE, b, { real: false })).toEqual({
      eventId: b,
      real: false,
      falseAlarm: true,
    });
    await pump();
    expect(await recorded()).toEqual([expect.objectContaining({ event_id: b, cause: 'FAMILY_FEEDBACK' })]);
    await falseAlarms.feedback(ALICE, a, { real: false });
    const fb = await h.rows<{ real: boolean }>('SELECT real FROM event.family_feedback WHERE event_id = $1', [a]);
    expect(fb).toEqual([{ real: false }]);
  });

  it('başka ailenin olayı 404, açık olay 409, yönetici 403, gövde hatalı 400, olay yok 404', async () => {
    const closed = await operatorClose('OK');
    await deliver(sig('CALLBACK_REQUEST', { protectedPersonId: pp }));
    const open = await openEvent();
    expect(await status(falseAlarms.feedback(BOB, closed, { real: false }))).toBe(404);
    expect(await status(falseAlarms.feedback(ALICE, open.id, { real: false }))).toBe(409);
    expect(await status(falseAlarms.feedback({ kind: 'ADMIN' }, closed, { real: false }))).toBe(403);
    expect(await status(falseAlarms.feedback(ALICE, closed, { real: 'hayır' }))).toBe(400);
    expect(await status(falseAlarms.feedback(ALICE, '0192f000-0000-7000-8000-000000000000', { real: true }))).toBe(404);
  });
});

describe('Oran (kişi ucu ve amir panosu)', () => {
  it('4 kapanan olaydan 2 yanlış alarm → 0.5; nedenlere göre; test olayı paydada yok', async () => {
    await userCancel();
    await operatorClose('FALSE_ALARM');
    await operatorClose('OK');
    await operatorClose('OK');
    await operatorClose('FALSE_ALARM', 'TEST');
    const s = await falseAlarms.personStats(ALICE, pp);
    expect(s).toEqual({
      protectedPersonId: pp,
      windowDays: 30,
      closedEvents: 4,
      falseAlarms: 2,
      ratio: 0.5,
      byCause: { USER_CANCEL: 1, OPERATOR: 1, FAMILY_FEEDBACK: 0 },
      repeatPersons: 0,
    });
    expect(await status(falseAlarms.personStats(BOB, pp))).toBe(404);

    const d = await new SupervisorService(h.db).dashboard();
    expect(d.falseAlarms).toMatchObject({ closedEvents: 4, falseAlarms: 2, ratio: 0.5, repeatPersons: 0 });
  });

  it('eşiği aşan kişi amir panosunda sayılır', async () => {
    for (let i = 0; i < 3; i++) await userCancel();
    const d = await new SupervisorService(h.db).dashboard();
    expect(d.falseAlarms).toMatchObject({ falseAlarms: 3, repeatPersons: 1, byCause: { USER_CANCEL: 3 } });
  });
});
