import type { KafkaEnvelope, Signal } from '@yanimda/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '../src/common/bus';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { ChainService } from '../src/modules/chain/chain.service';
import { loadProcedures } from '../src/modules/chain/procedures';
import type { EventService } from '../src/modules/event/event.service';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * Denetim 2026-11-11 bulgu 1–2 ve 9: açık olay yeni bir gerçek alarmı yutmamalı.
 *  1. "İyi" teyit edilmiş (CONFIRMED_OK) ama kapatılmamış olaya yeni SOS / FALL: eski olay sistemce kapanır, alarm
 *     YENİ olay olarak normal akışına girer (SOS → kuyruk P1; 112 yolu açık).
 *  2. Hareketsizlik (INACTIVITY) olayına FALL / SOS: olay o alarma yükseltilir (tür, öncelik; ses ön elemesi yok),
 *     kişi sorusu sürüyorsa hemen operatöre.
 *  9. Operatördeki (aktif) olaya yeni alarm: olay aynı kalır ama `event.updated` (NEW_ALARM) yayınlanır → konsol uyarır.
 */
const proc = loadProcedures('TR');
const OP = 'op-1';
const P = 'pp-new-alarm';

let h: Harness;
let timers: InMemoryTimers;
let events: EventService;
let chain: ChainService;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  timers = new InMemoryTimers();
  events = h.events(timers);
  chain = new ChainService(h.db, events, proc);
});
afterAll(async () => {
  await h.close();
});

const deliver = (kind: string, extra: Record<string, unknown> = {}) =>
  bus.deliver<Signal>('signal.received', {
    payload: sig(kind, { protectedPersonId: P, ...extra }),
  } as unknown as KafkaEnvelope<Signal>);
const byState = async () => (await events.all()).map((e) => [e.type, e.state, e.priority]);
const updates = async () =>
  (
    await h.rows<{ envelope: { payload: Record<string, unknown> } }>(
      "SELECT envelope FROM event.outbox WHERE topic = 'event.updated' ORDER BY id",
    )
  ).map((r) => r.envelope.payload);

/** SOS olayı operatörde, zincirde kişi "iyi" dedi → CONFIRMED_OK (operatör henüz kapatmadı). */
async function confirmedOk() {
  await deliver('SOS');
  const [ev] = await events.all();
  await chain.claim(ev!.id, OP);
  const r = await chain.stepResult(ev!.id, 1, OP, { result: 'REACHED', assessment: 'OK', note: 'yanlışlıkla bastı' });
  expect(r.event.state).toBe('CONFIRMED_OK');
  return ev!.id;
}

describe('teyit edilmiş ama kapanmamış olaya yeni alarm', () => {
  it('CONFIRMED_OK + yeni SOS → eski olay kapanır (OK), yeni SOS olayı kuyrukta P1; 112 kısayolu açık', async () => {
    const oldId = await confirmedOk();
    await deliver('SOS');
    const all = await events.all();
    expect(all).toHaveLength(2);
    const old = await events.get(oldId);
    expect(old).toMatchObject({ state: 'CLOSED', confirmedOutcome: 'OK' });
    const fresh = all.find((e) => e.id !== oldId)!;
    expect(fresh).toMatchObject({ type: 'SOS', state: 'OPERATOR_QUEUE', priority: 1 });
    const [audit] = await h.rows<{ data: Record<string, unknown> }>(
      "SELECT data FROM audit.log WHERE action = 'event.superseded' AND entity_id = $1",
      [oldId],
    );
    expect(audit!.data).toMatchObject({ by: fresh.id, alarm: 'SOS' });

    await chain.claim(fresh.id, OP);
    const esc = await chain.escalate112(fresh.id, OP, { reason: 'kişi yere düştüğünü söyledi' });
    expect(esc.event.state).not.toBe('CONFIRMED_OK');
  });

  it('CONFIRMED_OK + FALL → yeni FALL olayı kendi akışında (kişi sorusu)', async () => {
    const oldId = await confirmedOk();
    await deliver('FALL');
    expect((await events.get(oldId)).state).toBe('CLOSED');
    const fresh = (await events.all()).find((e) => e.id !== oldId)!;
    expect(fresh).toMatchObject({ type: 'FALL', state: 'DEVICE_PROMPT' });
  });

  it('aynı sinyal ikinci kez teslim edilirse (outbox) ikinci olay açılmaz', async () => {
    await confirmedOk();
    const s = sig('SOS', { protectedPersonId: P });
    const env = { payload: s } as unknown as KafkaEnvelope<Signal>;
    await bus.deliver<Signal>('signal.received', env);
    await bus.deliver<Signal>('signal.received', env);
    expect(await events.all()).toHaveLength(2);
  });
});

describe('hareketsizlik olayına düşme / SOS', () => {
  it('INACTIVITY sorusu sürerken FALL → FALL, P1, hemen kuyrukta; soru zamanlayıcısı silinir; aileye F-EVT-FALL', async () => {
    await deliver('INACTIVITY');
    expect(await byState()).toEqual([['INACTIVITY', 'DEVICE_PROMPT', 2]]);
    await deliver('FALL');
    expect(await byState()).toEqual([['FALL', 'OPERATOR_QUEUE', 1]]);
    expect(timers.pendingIds().filter((id) => id.endsWith('ask-expire'))).toEqual([]);
    // Aile bildirimi (NotifyService) kuyruğa girişte türü veritabanından okur → FALL → F-EVT-FALL.
    const [row] = await h.rows<{ type: string }>('SELECT type FROM event.event');
    expect(row!.type).toBe('FALL');
    const { familyNoticeFor } = await import('../src/modules/notify/policy');
    expect(
      familyNoticeFor({ id: 'x', type: 'FALL', isTest: false, confirmedOutcome: null }, { to: 'OPERATOR_QUEUE' }),
    ).toBe('F-EVT-FALL');
  });

  it('kuyruktaki INACTIVITY olayına SOS → SOS, P1 (ses ön elemesi SOS/FALL için yapılmaz)', async () => {
    await deliver('INACTIVITY');
    const [ev] = await events.all();
    await timers.fire(ev!.id, 'silent-ask-expire').catch(() => undefined);
    await deliver('SOS');
    const [after] = await events.all();
    expect(after).toMatchObject({ type: 'SOS', priority: 1 });
  });
});

describe('operatördeki olaya yeni alarm', () => {
  it('zincir sürerken ikinci SOS → aynı olay, event.updated NEW_ALARM (konsol uyarır)', async () => {
    await deliver('SOS');
    const [ev] = await events.all();
    await chain.claim(ev!.id, OP);
    await chain.stepResult(ev!.id, 1, OP, { result: 'NO_ANSWER' });
    await deliver('SOS');
    expect(await events.all()).toHaveLength(1);
    expect(await updates()).toContainEqual(
      expect.objectContaining({ eventId: ev!.id, reason: 'NEW_ALARM', alarm: 'SOS' }),
    );
  });
});

describe('alarm olmayan tespit başka olaya eklenince', () => {
  it('P4 geri arama olayına pil bitti (P3) → öncelik P3 (bulgu 7b)', async () => {
    await deliver('CALLBACK_REQUEST');
    const [cb] = await events.all();
    expect(cb).toMatchObject({ type: 'CALLBACK', priority: 4 });
    // Cihaz taraması (sweepDevices) bu iç yolu kullanır.
    const create = (events as unknown as { create(t: string, s: object): Promise<boolean> }).create.bind(events);
    await create('BATTERY_DEAD', { protectedPersonId: P, sourceId: `battery-dead:${P}:t1` });
    const [after] = await events.all();
    expect(after).toMatchObject({ type: 'CALLBACK', priority: 3 });
  });
});
