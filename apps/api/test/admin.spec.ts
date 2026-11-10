import type { KafkaEnvelope, Signal } from '@yanimda/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '../src/common/bus';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { AdminService } from '../src/modules/admin/admin.service';
import { ChainService } from '../src/modules/chain/chain.service';
import { DispatchService } from '../src/modules/chain/dispatch.service';
import { loadProcedures } from '../src/modules/chain/procedures';
import type { EventService } from '../src/modules/event/event.service';
import { MemoryRecordingStore } from '../src/modules/telephony/recording-store';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * Yönetim / çağrı merkezi paneli: çağrı kaydı (kim kimi aradı, cevap, süre; numara yok), ses kaydı dinleme
 * (denetim kaydına yazılır), analiz (SLA, arama, 112 varış, düzenli aramalar, operatörler), denetim, sağlık.
 */
const proc = loadProcedures('TR');
const OP = 'op-1';
const P = '01960000-0000-7000-8000-0000000000a9';

let h: Harness;
let events: EventService;
let chain: ChainService;
let dispatch: DispatchService;
let store: MemoryRecordingStore;
let admin: AdminService;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  const timers = new InMemoryTimers();
  events = h.events(timers);
  chain = new ChainService(h.db, events, proc);
  dispatch = new DispatchService(h.db, h.outbox, timers);
  dispatch.subscribe(bus);
  store = new MemoryRecordingStore();
  admin = new AdminService(h.db, store);
});
afterAll(async () => {
  await h.close();
});

/** SOS → üstlen → saati ara (cevap verildi, kayıtlı) → 112 → ulaşıldı → ekip olay yerinde → kapat. */
async function scenario() {
  await h.pg.query("INSERT INTO profile.protected_person (id, display_name) VALUES ($1, 'Ayşe Y.')", [P]);
  await bus.deliver<Signal>('signal.received', {
    payload: sig('SOS', { protectedPersonId: P }),
  } as unknown as KafkaEnvelope<Signal>);
  const [ev] = await events.all();
  await chain.claim(ev!.id, OP);
  await h.pg.query(
    `INSERT INTO telephony.call (id, event_id, step_n, operator_id, provider, status, answered, duration_sec, recording_ref)
     VALUES ('01960000-0000-7000-8000-0000000000c1', $1, 1, $2, 'fake', 'completed', true, 42, 'recordings/TR/x/c1.mp3'),
            ('01960000-0000-7000-8000-0000000000c2', $1, 2, $2, 'fake', 'no-answer', false, NULL, NULL)`,
    [ev!.id, OP],
  );
  await store.put('recordings/TR/x/c1.mp3', Buffer.from('ses'), 'audio/mpeg');
  await chain.escalate112(ev!.id, OP, { reason: 'sessiz hat' });
  const n = (await chain.get(ev!.id)).chain!.steps.find((s) => s.kind === 'CALL_112' && !s.result)!.n;
  await chain.stepResult(ev!.id, n, OP, { result: 'REACHED' });
  await h.worker().drain();
  await dispatch.update(ev!.id, { kind: 'OPERATOR', id: OP }, { status: 'ON_SCENE' });
  await chain.close(ev!.id, OP, { outcome: 'EMERGENCY', note: 'ambulans', followUpAfterHours: 24 });
  return ev!.id;
}

describe('yönetim paneli', () => {
  it('çağrı kaydı: kim kimi aradı (rehber rolü), cevap, süre, kayıt; numara yok', async () => {
    const id = await scenario();
    const calls = await admin.calls({ from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 60_000) });
    expect(calls).toHaveLength(2);
    const answered = calls.find((c) => c.answered)!;
    expect(answered).toMatchObject({
      direction: 'OUT',
      eventId: id,
      eventType: 'SOS',
      person: 'Ayşe Y.',
      operatorId: OP,
      party: 'CALL_WATCH',
      durationSec: 42,
      recording: true,
    });
    expect(JSON.stringify(calls)).not.toMatch(/\+90|phone_e164/);
    expect(await admin.calls({ from: new Date(0), to: new Date(Date.now() + 60_000), answered: false })).toHaveLength(
      1,
    );
  });

  it('ses kaydı dinleme denetim kaydına yazılır; kaydı olmayan çağrı 404', async () => {
    await scenario();
    const r = await admin.recording(
      '01960000-0000-7000-8000-0000000000c1',
      { id: 'sup-1', role: 'SUPERVISOR' },
      'kalite kontrol',
    );
    expect(r.body.toString()).toBe('ses');
    const [a] = await h.rows<{ actor_id: string; data: { reason: string } }>(
      "SELECT actor_id, data FROM audit.log WHERE action = 'recording.played' AND entity_id = '01960000-0000-7000-8000-0000000000c1'",
    );
    expect(a).toMatchObject({ actor_id: 'sup-1', data: { reason: 'kalite kontrol' } });
    await expect(
      admin.recording('01960000-0000-7000-8000-0000000000c2', { id: 'sup-1', role: 'SUPERVISOR' }, undefined),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('analiz: olaylar, SLA, arama cevap oranı, 112 varış, operatör performansı, günlük seri', async () => {
    await scenario();
    const a = await admin.analytics(7);
    expect(a.events.byType.SOS).toBe(1);
    expect(a.events.byOutcome.EMERGENCY).toBe(1);
    expect(a.calls).toMatchObject({ total: 2, answered: 1, answerRate: 0.5 });
    expect(a.calls.byParty.CALL_WATCH).toEqual({ total: 1, answered: 1 });
    expect(a.dispatch).toMatchObject({ total: 1, arrived: 1, late: 0 });
    expect(a.sla.claimP50Sec).not.toBeNull();
    expect(a.operators[0]).toMatchObject({ operatorId: OP, claims: 1, closed: 1, calls: 2, answered: 1 });
    expect(a.daily.length).toBeGreaterThanOrEqual(7);
  });

  it('denetim kaydı süzgeçle; sağlık özeti', async () => {
    const id = await scenario();
    const audit = await admin.audit({
      from: new Date(Date.now() - 3_600_000),
      to: new Date(Date.now() + 60_000),
      action: 'dispatch.',
      entityId: id,
    });
    expect(audit.map((x) => x.action)).toEqual(expect.arrayContaining(['dispatch.opened', 'dispatch.updated']));
    const hl = await admin.health();
    expect(hl).toMatchObject({ queue: { waiting: 0 }, dispatch: { open: 1, late: 0 }, outbox: { dlq: 0 } });
  });
});
