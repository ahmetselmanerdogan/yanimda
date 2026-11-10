import type { KafkaEnvelope, Signal } from '@yanimda/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '../src/common/bus';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { ChainService } from '../src/modules/chain/chain.service';
import { DispatchService } from '../src/modules/chain/dispatch.service';
import { loadProcedures } from '../src/modules/chain/procedures';
import type { EventService } from '../src/modules/event/event.service';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * 112 bildirim ve intikal takibi: 112 adımı "ulaşıldı" → süreç açılır (NOTIFIED); aşamalar ileri gider, aileye
 * ekip ulaştı / hastane bildirimi, ulaşılmazsa amir uyarısı, olay kapansa da süreç sürer.
 */
const proc = loadProcedures('TR');
const OP = 'op-1';
const P = '01960000-0000-7000-8000-0000000000d1';

let h: Harness;
let timers: InMemoryTimers;
let events: EventService;
let chain: ChainService;
let dispatch: DispatchService;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  timers = new InMemoryTimers();
  events = h.events(timers);
  chain = new ChainService(h.db, events, proc);
  dispatch = new DispatchService(h.db, h.outbox, timers);
  dispatch.subscribe(bus);
});
afterAll(async () => {
  await h.close();
});

const op = { kind: 'OPERATOR' as const, id: OP };
const status = async (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status?: number }) => e.status,
  );
const outbox = async (topic: string) =>
  (
    await h.rows<{ envelope: { payload: Record<string, unknown> } }>(
      'SELECT envelope FROM event.outbox WHERE topic = $1 ORDER BY id',
      [topic],
    )
  ).map((r) => r.envelope.payload);

/** SOS → üstlen → 112'ye aktar → 112 adımı ulaşıldı (DISPATCH) → outbox teslim (süreç açılır). */
async function dispatched() {
  await bus.deliver<Signal>('signal.received', {
    payload: sig('SOS', { protectedPersonId: P }),
  } as unknown as KafkaEnvelope<Signal>);
  const [ev] = await events.all();
  await chain.claim(ev!.id, OP);
  await chain.escalate112(ev!.id, OP, { reason: 'sessiz hat' });
  const run = (await chain.get(ev!.id)).chain!;
  const n = run.steps.find((s) => s.kind === 'CALL_112' && !s.result)!.n;
  await chain.stepResult(ev!.id, n, OP, { result: 'REACHED' });
  await h.worker().drain();
  return ev!.id;
}

describe('112 süreci', () => {
  it('112 adımı ulaşıldı → süreç NOTIFIED, takip zamanlayıcısı kurulur (idempotent)', async () => {
    const id = await dispatched();
    const v = (await dispatch.get(id))!;
    expect(v).toMatchObject({ status: 'NOTIFIED', notifiedBy: OP, open: true });
    expect(v.timeline).toEqual([expect.objectContaining({ status: 'NOTIFIED', source: 'OPERATOR' })]);
    expect(timers.pendingIds()).toContain(`${id}.dispatch-check`);
    expect(await dispatch.open(id, OP)).toBe(false); // outbox tekrarı
  });

  it('aşamalar ileri gider; atlanan aşamalar zaman alır; aileye ekip ulaştı + hastane; geri alınamaz', async () => {
    const id = await dispatched();
    await dispatch.update(id, op, { status: 'ACCEPTED', caseRef: '112-778', etaMin: 12, source: 'EMS' });
    const onScene = await dispatch.update(id, op, { status: 'ON_SCENE', note: 'ekip kapıda' });
    expect(onScene.stages).toHaveProperty('EN_ROUTE');
    expect(onScene).toMatchObject({ status: 'ON_SCENE', caseRef: '112-778', etaMin: 12 });
    expect(onScene.arrivalMin).not.toBeNull();
    expect(await status(dispatch.update(id, op, { status: 'EN_ROUTE' }))).toBe(409);
    await dispatch.update(id, op, { status: 'TRANSPORTING', hospital: 'Kadıköy Devlet' });
    const done = await dispatch.update(id, op, { status: 'COMPLETED' });
    expect(done).toMatchObject({ status: 'COMPLETED', open: false, hospital: 'Kadıköy Devlet' });
    expect(done.timeline.map((t) => t.status)).toEqual([
      'NOTIFIED',
      'ACCEPTED',
      'ON_SCENE',
      'TRANSPORTING',
      'COMPLETED',
    ]);
    expect(await status(dispatch.update(id, op, { note: 'geç not' }))).toBe(409);
    const codes = (await outbox('notify.requested')).map((p) => p.code);
    expect(codes).toContain('F-112-ON-SCENE');
    expect(codes).toContain('F-112-HOSPITAL');
    expect(timers.pendingIds()).not.toContain(`${id}.dispatch-check`);
  });

  it('ekip ulaşmadıysa takip zamanlayıcısı amire uyarı verir ve yeniden kurulur; ulaşınca uyarı türü değişir', async () => {
    const id = await dispatched();
    await timers.fire(id, 'dispatch-check');
    let alerts = (await outbox('supervisor.alert')).map((p) => p.code);
    expect(alerts).toContain('O-DISPATCH-NO-ARRIVAL');
    expect(timers.pendingIds()).toContain(`${id}.dispatch-check`);
    expect((await dispatch.get(id))!.checks).toBe(1);
    await dispatch.update(id, op, { status: 'ON_SCENE' });
    await timers.fire(id, 'dispatch-check');
    alerts = (await outbox('supervisor.alert')).map((p) => p.code);
    expect(alerts).toContain('O-DISPATCH-OPEN');
  });

  it('olay kapansa da süreç sürer; süren süreçler listesi; geçersiz girdi 400', async () => {
    const id = await dispatched();
    await chain.close(id, OP, { outcome: 'EMERGENCY', note: 'ambulans çağrıldı', followUpAfterHours: 24 });
    expect((await events.get(id)).state).toBe('CLOSED');
    expect((await dispatch.list({ open: true })).map((d) => d.eventId)).toEqual([id]);
    await dispatch.update(id, op, { status: 'ON_SCENE' });
    expect(await status(dispatch.update(id, op, { status: 'UÇTU' }))).toBe(400);
    expect(await status(dispatch.update(id, op, { etaMin: 9999 }))).toBe(400);
    expect(await status(dispatch.update('01960000-0000-7000-8000-00000000ffff', op, { status: 'ON_SCENE' }))).toBe(404);
    await dispatch.update(id, op, { status: 'CANCELLED', note: 'aile özel araçla götürdü' });
    expect(await dispatch.list({ open: true })).toEqual([]);
  });
});
