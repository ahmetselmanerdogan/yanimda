import type { KafkaEnvelope, Signal } from '@yanimda/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '../src/common/bus';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * T-011b · D-10 Olay ve geçiş kalıcılığı. Kabul:
 *  - olay event.event'te, her geçiş event.transition'da; bellek Map'i yok (yeni süreç aynı olayı görür)
 *  - transition() tek transaction: durum + geçiş + audit + outbox (event.transitioned)
 *  - açık olay sorgusu state <> CLOSED; kişi başına tek açık olay
 *  - audit.log append-only: UPDATE/DELETE/TRUNCATE yetki hatası (42501)
 */
let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
});
afterAll(async () => {
  await h.close();
});

const envelope = (s: ReturnType<typeof sig>) => ({ payload: s }) as unknown as KafkaEnvelope<Signal>;
const deliver = (s: ReturnType<typeof sig>) => bus.deliver<Signal>('signal.received', envelope(s));
const states = async (eventId: string) =>
  (
    await h.rows<{ to_state: string }>('SELECT to_state FROM event.transition WHERE event_id = $1 ORDER BY seq', [
      eventId,
    ])
  ).map((r) => r.to_state);

describe('Olay kalıcılığı', () => {
  it('FALL → event.event satırı + CREATED, DEVICE_PROMPT geçişleri', async () => {
    const events = h.events();
    await deliver(sig('FALL', { location: { lat: 41, lng: 29 } }));
    const [row] = await h.rows<{
      id: string;
      state: string;
      type: string;
      priority: number;
      source_signal_ids: string[];
    }>('SELECT id, state, type, priority, source_signal_ids FROM event.event');
    expect(row).toMatchObject({ state: 'DEVICE_PROMPT', type: 'FALL', priority: 1 });
    expect(row.source_signal_ids).toHaveLength(1);
    expect(await states(row.id)).toEqual(['CREATED', 'DEVICE_PROMPT']);
    expect((await events.get(row.id)).location).toEqual({ lat: 41, lng: 29 });
  });

  it('yeni süreç (yeni EventService) aynı olayı görür ve zamanlayıcı onu yükseltir', async () => {
    const t1 = new InMemoryTimers();
    h.events(t1);
    await deliver(sig('FALL'));
    const [{ id }] = await h.rows<{ id: string }>('SELECT id FROM event.event');

    bus.clear(); // eski süreç öldü
    const t2 = new InMemoryTimers();
    const events2 = h.events(t2);
    await t2.fire(id, 'prompt-expire'); // BullMQ işi yeni süreçte çalıştı
    expect((await events2.get(id)).state).toBe('OPERATOR_QUEUE');
    expect((await events2.queue()).map((e) => e.id)).toEqual([id]);
    expect(await states(id)).toEqual(['CREATED', 'DEVICE_PROMPT', 'ESCALATED', 'OPERATOR_QUEUE']);
  });

  it('get: geçişler sırayla, aktör ve notla döner', async () => {
    const events = h.events();
    await deliver(sig('SOS'));
    const [{ id }] = await h.rows<{ id: string }>('SELECT id FROM event.event');
    await events.claim(id, 'op-7');
    const ev = await events.get(id);
    expect(ev.operatorId).toBe('op-7');
    expect(ev.transitions.map((t) => [t.from ?? null, t.to, t.actorKind])).toEqual([
      [null, 'CREATED', 'SYSTEM'],
      ['CREATED', 'ESCALATED', 'SYSTEM'],
      ['ESCALATED', 'OPERATOR_QUEUE', 'SYSTEM'],
      ['OPERATOR_QUEUE', 'OPERATOR_ASSIGNED', 'OPERATOR'],
    ]);
    expect(ev.transitions[3].actorId).toBe('op-7');
  });

  it('olmayan olay 404', async () => {
    await expect(h.events().get('00000000-0000-7000-8000-000000000000')).rejects.toMatchObject({ status: 404 });
  });
});

describe('Tek transaction: durum + geçiş + audit + outbox', () => {
  it("her geçiş outbox'a event.transitioned yazar", async () => {
    h.events();
    await deliver(sig('SOS'));
    const topics = (await h.rows<{ topic: string }>('SELECT topic FROM event.outbox ORDER BY id')).map((r) => r.topic);
    expect(topics).toEqual(['event.created', 'event.transitioned', 'event.transitioned', 'event.transitioned']);
  });

  it('outbox yazılamazsa geçiş de geri alınır (yarım durum yok)', async () => {
    const events = h.events();
    await deliver(sig('SOS'));
    const [{ id }] = await h.rows<{ id: string }>('SELECT id FROM event.event');
    await h.pg.exec('ALTER TABLE event.outbox RENAME TO outbox_off');
    await expect(events.claim(id, 'op-1')).rejects.toThrow();
    await h.pg.exec('ALTER TABLE event.outbox_off RENAME TO outbox');
    expect((await events.get(id)).state).toBe('OPERATOR_QUEUE');
    expect(await states(id)).not.toContain('OPERATOR_ASSIGNED');
  });

  it("her geçiş audit.log'a aktörüyle yazılır", async () => {
    const events = h.events();
    await deliver(sig('SOS'));
    const [{ id }] = await h.rows<{ id: string }>('SELECT id FROM event.event');
    await events.claim(id, 'op-9');
    const audit = await h.rows<{ actor_kind: string; actor_id: string | null; action: string; data: { to: string } }>(
      "SELECT actor_kind, actor_id, action, data FROM audit.log WHERE entity_type = 'event' AND entity_id = $1 ORDER BY id",
      [id],
    );
    expect(audit.map((a) => a.data.to)).toEqual(['CREATED', 'ESCALATED', 'OPERATOR_QUEUE', 'OPERATOR_ASSIGNED']);
    expect(audit[3]).toMatchObject({ actor_kind: 'OPERATOR', actor_id: 'op-9', action: 'event.transition' });
  });
});

describe('audit.log append-only', () => {
  beforeEach(async () => {
    await h.pg.exec(
      "INSERT INTO audit.log (actor_kind, action, entity_type, entity_id) VALUES ('SYSTEM', 'test', 'test', 'x')",
    );
  });
  it.each([
    ['UPDATE', "UPDATE audit.log SET action = 'değişti' WHERE entity_type = 'test'"],
    ['DELETE', "DELETE FROM audit.log WHERE entity_type = 'test'"],
    ['TRUNCATE', 'TRUNCATE audit.log'],
  ])('%s yetki hatası verir (42501)', async (_op, stmt) => {
    await expect(h.pg.exec(stmt)).rejects.toMatchObject({ code: '42501' });
  });
});

describe('Açık olay ve yeniden teslim', () => {
  it('aynı kişinin açık olayı varken yeni sinyal olaya eklenir (tek açık olay)', async () => {
    const events = h.events();
    const a = sig('SOS');
    const b = sig('FALL');
    await deliver(a);
    await deliver(b);
    const rows = await h.rows<{ source_signal_ids: string[] }>('SELECT source_signal_ids FROM event.event');
    expect(rows).toHaveLength(1);
    expect(rows[0].source_signal_ids).toEqual([a.idempotencyKey, b.idempotencyKey]);
    expect(await events.queue()).toHaveLength(1);
  });

  it('kapanmış olaydan sonra yeni sinyal yeni olay açar (açık = state <> CLOSED)', async () => {
    const events = h.events();
    await deliver(sig('FALL'));
    await deliver(sig('CANCEL'));
    await deliver(sig('SOS'));
    const rows = await h.rows<{ type: string; state: string }>(
      'SELECT type, state FROM event.event ORDER BY created_at',
    );
    expect(rows).toEqual([
      { type: 'FALL', state: 'CLOSED' },
      { type: 'SOS', state: 'OPERATOR_QUEUE' },
    ]);
    expect(await events.queue()).toHaveLength(1);
  });

  it('aynı sinyal ikinci kez teslim edilirse (outbox en az bir kez) yeni olay açılmaz', async () => {
    h.events();
    const s = sig('SOS');
    await deliver(s);
    await h.pg.exec("UPDATE event.event SET state = 'CLOSED'"); // olay kapanmış olsa bile
    await deliver(s);
    expect(await h.rows('SELECT id FROM event.event')).toHaveLength(1);
  });

  it('veritabanı kişi başına ikinci açık olayı reddeder', async () => {
    h.events();
    await deliver(sig('SOS'));
    await expect(
      h.pg.exec(`INSERT INTO event.event (id, protected_person_id, type, priority, state)
                 VALUES ('00000000-0000-7000-8000-000000000001', 'pp-1', 'SOS', 1, 'OPERATOR_QUEUE')`),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

describe('Eş zamanlı operatör işlemleri', () => {
  it('iki operatör aynı anda üstlenirse biri kazanır, diğeri 409', async () => {
    const events = h.events();
    await deliver(sig('SOS'));
    const [{ id }] = await h.rows<{ id: string }>('SELECT id FROM event.event');
    const r = await Promise.allSettled([events.claim(id, 'op-a'), events.claim(id, 'op-b')]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const rejected = r.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409 });
    expect((await states(id)).filter((s) => s === 'OPERATOR_ASSIGNED')).toHaveLength(1);
  });

  it('başkasının olayını kapatmak 409', async () => {
    const events = h.events();
    await deliver(sig('SOS'));
    const [{ id }] = await h.rows<{ id: string }>('SELECT id FROM event.event');
    await events.claim(id, 'op-a');
    await expect(events.closeByOperator(id, 'op-b', 'OK')).rejects.toMatchObject({ status: 409 });
  });
});

describe('Gecikmiş cihaz sorusu taraması (Redis + süreç birlikte kaybolursa)', () => {
  it('süresi geçmiş DEVICE_PROMPT olayı yükseltilir; süresi gelmemiş olana dokunulmaz', async () => {
    const timers = new InMemoryTimers(); // işler "kayboldu": hiç tetiklenmeyecek
    const events = h.events(timers);
    await deliver(sig('FALL', { protectedPersonId: 'pp-old' }));
    await deliver(sig('FALL', { protectedPersonId: 'pp-new' }));
    await h.pg.exec(
      "UPDATE event.event SET device_prompt_until = now() - interval '5 minutes' WHERE protected_person_id = 'pp-old'",
    );
    expect(await events.recoverOverdue()).toBe(1);
    const rows = await h.rows<{ protected_person_id: string; state: string }>(
      'SELECT protected_person_id, state FROM event.event ORDER BY protected_person_id',
    );
    expect(rows).toEqual([
      { protected_person_id: 'pp-new', state: 'DEVICE_PROMPT' },
      { protected_person_id: 'pp-old', state: 'OPERATOR_QUEUE' },
    ]);
  });
});
