import type { KafkaEnvelope, Signal } from '@yanimda/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '../src/common/bus';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { ChainService } from '../src/modules/chain/chain.service';
import { loadProcedures } from '../src/modules/chain/procedures';
import type { EventService } from '../src/modules/event/event.service';
import { SupervisorService } from '../src/modules/metrics/supervisor.service';
import { AssignmentService } from '../src/modules/queue/assignment.service';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * Otomatik atama (1 milyon kişi değerlendirmesi, 2026-11-13): tek ortak kuyruk her olayı her operatöre gösteriyordu;
 * yüzlerce operatörde "kim alacak" belirsiz kalır. Amir bayrağı (`auto_assign`) açıkken kuyruktaki olay öncelik ve
 * yaş sırasıyla, en uzun süredir boşta kalan uygun operatöre atanır; operatör ACCEPT_SEC içinde olayı açmazsa olay
 * kuyruğa döner, operatör molaya alınır, amire uyarı gider.
 */
let h: Harness;
let events: EventService;
const T0 = new Date('2026-11-13T10:00:00Z');
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
let svc: (now?: Date) => AssignmentService;

beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  await h.rows('DELETE FROM event.supervisor_flag');
  events = h.events(new InMemoryTimers());
  svc = () => new AssignmentService(h.db, events, { acceptSec: 20 });
});
afterAll(async () => {
  await h.close();
});

const enable = (on = true) =>
  h.rows(
    "INSERT INTO event.supervisor_flag (key, enabled, changed_by) VALUES ('auto_assign', $1, 'sup') ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled",
    [on],
  );
/** Konsolu bağlı operatör: `idleSec` önce durum değiştirdi (en uzun boşta kalan önce atanır). */
const operator = (subject: string, o: { status?: string; seenSecAgo?: number; idleSec?: number; kind?: string } = {}) =>
  h.rows(
    `INSERT INTO identity.operator (subject, display_name, kind, status, status_at, last_seen_at)
     VALUES ($1, $1, $2, $3, $4, $5)`,
    [subject, o.kind ?? 'OPERATOR', o.status ?? 'AVAILABLE', at(-(o.idleSec ?? 600)), at(-(o.seenSecAgo ?? 5))],
  );
const raise = async (kind: string, person: string) => {
  await bus.deliver<Signal>('signal.received', {
    payload: sig(kind, { protectedPersonId: person, occurredAt: T0.toISOString() }),
  } as unknown as KafkaEnvelope<Signal>);
  const all = await events.all();
  return all.find((e) => e.protectedPersonId === person)!.id;
};
const status = async (subject: string) =>
  (
    await h.rows<{ status: string; status_by: string | null }>(
      'SELECT status, status_by FROM identity.operator WHERE subject = $1',
      [subject],
    )
  )[0];
const alerts = async () =>
  (
    await h.rows<{ envelope: { payload: { code: string; eventId: string; operatorId?: string } } }>(
      "SELECT envelope FROM event.outbox WHERE topic = 'supervisor.alert' ORDER BY id",
    )
  ).map((r) => r.envelope.payload);

describe('otomatik atama', () => {
  it('amir bayrağı: PUT ile açılır (denetim); pano bayrağı ve son 24 saatin kabul / cevapsız sayılarını gösterir', async () => {
    const sup = new SupervisorService(h.db);
    await expect(sup.setAutoAssign('evet', 'sup-1')).rejects.toMatchObject({ status: 400 });
    expect(await sup.setAutoAssign(true, 'sup-1')).toMatchObject({ enabled: true, changedBy: 'sup-1' });
    expect(await svc().enabled()).toBe(true);
    await operator('op-1', { idleSec: 3000 });
    await operator('op-2', { idleSec: 100 });
    const a = await raise('SOS', 'pp-1');
    await raise('SOS', 'pp-2');
    await svc().run(at(1));
    await events.claim(a, 'op-1');
    await svc().run(at(30)); // op-2 cevapsız: olay kuyruğa döner, boşta operatör yok
    const d = await sup.dashboard(at(31));
    expect(d.autoAssign).toMatchObject({ enabled: true, last24h: { offered: 2, accepted: 1, missed: 1 } });
    const [audit] = await h.rows<{ data: Record<string, unknown> }>(
      "SELECT data FROM audit.log WHERE action = 'supervisor.auto_assign' ORDER BY at DESC LIMIT 1",
    );
    expect(audit!.data).toEqual({ enabled: true });
  });

  it('bayrak kapalıyken hiçbir olay atanmaz', async () => {
    await operator('op-1');
    const id = await raise('SOS', 'pp-1');
    expect(await svc().run(at(1))).toEqual({ assigned: 0, missed: 0 });
    expect(await events.get(id)).toMatchObject({ state: 'OPERATOR_QUEUE' });
  });

  it('önce öncelik: P1 SOS, daha eski P4 TEST’ten önce tek operatöre atanır; denetim ve geçiş SYSTEM', async () => {
    await enable();
    await operator('op-1');
    const test = await raise('TEST', 'pp-test');
    const sos = await raise('SOS', 'pp-sos');
    expect(await svc().run(at(1))).toEqual({ assigned: 1, missed: 0 });

    const ev = await events.get(sos);
    expect(ev).toMatchObject({ state: 'OPERATOR_ASSIGNED', operatorId: 'op-1' });
    expect(ev.transitions.at(-1)).toMatchObject({
      to: 'OPERATOR_ASSIGNED',
      actorKind: 'SYSTEM',
      note: 'otomatik atama',
    });
    expect(await events.get(test)).toMatchObject({ state: 'OPERATOR_QUEUE' });
    const [audit] = await h.rows<{ actor_id: string; data: Record<string, unknown> }>(
      "SELECT actor_id, data FROM audit.log WHERE action = 'event.auto_assigned' AND entity_id = $1",
      [sos],
    );
    expect(audit).toMatchObject({ data: { operatorId: 'op-1' } });
  });

  it('uygun operatör: müsait, bağlı, operatör (amir değil), elinde olay yok; en uzun boşta kalan önce', async () => {
    await enable();
    await operator('op-break', { status: 'BREAK', idleSec: 5000 });
    await operator('op-offline', { status: 'OFFLINE', idleSec: 5000 });
    await operator('op-stale', { seenSecAgo: 600, idleSec: 5000 });
    await operator('sup-1', { kind: 'SUPERVISOR', idleSec: 5000 });
    await operator('op-busy', { idleSec: 4000 });
    await operator('op-fresh', { idleSec: 60 });
    await operator('op-idle', { idleSec: 3000 });
    const busy = await raise('TEST', 'pp-busy');
    await events.claim(busy, 'op-busy');

    const a = await raise('SOS', 'pp-a');
    const b = await raise('SOS', 'pp-b');
    expect(await svc().run(at(1))).toEqual({ assigned: 2, missed: 0 });
    expect((await events.get(a)).operatorId).toBe('op-idle'); // daha eski olay, en uzun boşta kalan operatör
    expect((await events.get(b)).operatorId).toBe('op-fresh');
  });

  it('operatör başına tek olay: 1 operatör, 3 olay → 1 atanır; ikinci tur yeni atama yapmaz', async () => {
    await enable();
    await operator('op-1');
    for (const p of ['pp-1', 'pp-2', 'pp-3']) await raise('SOS', p);
    expect(await svc().run(at(1))).toEqual({ assigned: 1, missed: 0 });
    expect(await svc().run(at(2))).toEqual({ assigned: 0, missed: 0 });
    expect((await events.all()).filter((e) => e.state === 'OPERATOR_QUEUE')).toHaveLength(2);
  });

  it('kabul: operatör "Kabul et" (üstlen) derse süre dolduğunda olay onda kalır', async () => {
    await enable();
    await operator('op-1');
    const id = await raise('SOS', 'pp-1');
    await svc().run(at(1));
    // Konsol geri sayımı: kuyruk satırı kabul son anını taşır.
    expect((await events.queueItem(id))?.offerUntil).toBe(at(21).toISOString());
    await events.claim(id, 'op-1'); // operatör "Kabul et"
    expect((await events.queueItem(id))?.offerUntil).toBeNull();
    const updated = await h.rows<{ envelope: { payload: { reason?: string } } }>(
      "SELECT envelope FROM event.outbox WHERE topic = 'event.updated'",
    );
    expect(updated.map((r) => r.envelope.payload.reason)).toContain('ASSIGNMENT_ACCEPTED');
    expect(await svc().run(at(30))).toEqual({ assigned: 0, missed: 0 });
    expect(await events.get(id)).toMatchObject({ state: 'OPERATOR_ASSIGNED', operatorId: 'op-1' });
    expect((await status('op-1')).status).toBe('AVAILABLE');
  });

  it('okuma kabul değildir: konsol kişi kartını, 112 metnini okur ve kalp atışı gönderir; teklif yine süre dolunca iade', async () => {
    // CI bulgusu: konsol olayı açınca kişi kartını okuyor; okuma `operate` üzerinden kabul sayılıyordu (kabul 0 sn).
    await enable();
    await operator('op-1');
    const id = await raise('SOS', 'pp-1');
    await svc().run(at(1));
    const chain = new ChainService(h.db, events, loadProcedures('TR'));
    await chain.personCard(id, 'op-1', at(2));
    await chain.heartbeat(id, 'op-1', at(3));
    await chain.dispatchScript(id, 'op-1', 'dispatch112', at(4)).catch(() => undefined);
    expect((await events.queueItem(id))?.offerUntil).toBe(at(21).toISOString());
    expect(await svc().run(at(22))).toMatchObject({ missed: 1 });
    expect((await status('op-1')).status).toBe('BREAK');
  });

  it('"Kabul et" (üstlen) teklifi kabul eder ve zinciri kurar', async () => {
    await enable();
    await operator('op-1');
    const id = await raise('SOS', 'pp-1');
    await svc().run(at(1));
    const chain = new ChainService(h.db, events, loadProcedures('TR'));
    const view = await chain.claim(id, 'op-1', at(2)); // "Kabul et"
    expect(view.chain!.current).toBeGreaterThan(0);
    expect((await events.queueItem(id))?.offerUntil).toBeNull();
  });

  it('cevapsız atama: süre dolunca olay kuyruğa döner, operatör molaya alınır, amire O-ASSIGN-MISSED; sonra başkasına', async () => {
    await enable();
    await operator('op-1', { idleSec: 3000 });
    const id = await raise('SOS', 'pp-1');
    await svc().run(at(1));
    expect((await events.get(id)).operatorId).toBe('op-1');

    await operator('op-2', { idleSec: 100 });
    expect(await svc().run(at(19))).toEqual({ assigned: 0, missed: 0 }); // süre dolmadı
    expect(await svc().run(at(22))).toEqual({ assigned: 1, missed: 1 });

    const ev = await events.get(id);
    expect(ev).toMatchObject({ state: 'OPERATOR_ASSIGNED', operatorId: 'op-2' });
    expect(ev.transitions.map((t) => [t.to, t.note])).toContainEqual(['OPERATOR_QUEUE', 'atama cevapsız']);
    expect(await status('op-1')).toEqual({ status: 'BREAK', status_by: 'system' });
    expect(await alerts()).toContainEqual(
      expect.objectContaining({ code: 'O-ASSIGN-MISSED', eventId: id, operatorId: 'op-1' }),
    );
  });

  it('cevapsız atama sırasında operatör olayı başkasına bırakmışsa (amir geri aldı) yanlış iade yapılmaz', async () => {
    await enable();
    await operator('op-1');
    const id = await raise('SOS', 'pp-1');
    await svc().run(at(1));
    await events.unclaim(id, 'sup-1', 'amir aldı');
    await events.claim(id, 'op-9');
    expect(await svc().run(at(30))).toMatchObject({ missed: 0 });
    expect(await events.get(id)).toMatchObject({ operatorId: 'op-9' });
    expect((await status('op-1')).status).toBe('AVAILABLE');
  });

  it('iki API sunucusu aynı anda: her olay bir kez, her operatöre en çok bir olay', async () => {
    await enable();
    for (let i = 0; i < 4; i++) await operator(`op-${i}`, { idleSec: 1000 - i });
    for (let i = 0; i < 6; i++) await raise('SOS', `pp-${i}`);
    const [x, y] = await Promise.all([svc().run(at(1)), svc().run(at(1))]);
    expect(x.assigned + y.assigned).toBe(4);
    const assigned = (await events.all()).filter((e) => e.state === 'OPERATOR_ASSIGNED');
    expect(new Set(assigned.map((e) => e.operatorId)).size).toBe(4);
  });
});
