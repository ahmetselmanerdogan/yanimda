import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { InMemoryTimers } from '../src/common/timers/memory-timers';
import type { EventService } from '../src/modules/event/event.service';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * Uçtan uca: simülatör FALL → signal.signal + outbox → OutboxWorker → EventService (event.event/transition)
 * → 60 sn → OPERATOR_QUEUE; CANCEL → operatöre düşmez. 03 "Kritik akışlar".
 */
let h: Harness;
let timers: InMemoryTimers;
let events: EventService;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  timers = new InMemoryTimers();
  events = h.events(timers);
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  await h.close();
});

/** sinyali kabul et ve outbox'ı boşalt (işçinin bir turu) */
const send = async (...signals: ReturnType<typeof sig>[]) => {
  await h.signals.accept(signals);
  await h.worker().drain();
};
const advance = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  await timers.idle();
};

describe('FALL akışı', () => {
  it('cevap yoksa 60 sn sonra kuyruğa düşer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await send(sig('FALL'));
    expect(await events.queue()).toHaveLength(0);
    await advance(60_000);
    const q = await events.queue();
    expect(q).toHaveLength(1);
    expect(q[0].type).toBe('FALL');
    expect(q[0].state).toBe('OPERATOR_QUEUE');
    const ev = await events.claim(q[0].id, 'op-1');
    expect(ev.state).toBe('OPERATOR_ASSIGNED');
    await events.closeByOperator(ev.id, 'op-1', 'EMERGENCY', '112 arandı');
    const closed = await events.get(ev.id);
    expect(closed.state).toBe('CLOSED');
    expect(closed.transitions.map((t) => t.to)).toEqual([
      'CREATED',
      'DEVICE_PROMPT',
      'ESCALATED',
      'OPERATOR_QUEUE',
      'OPERATOR_ASSIGNED',
      'CONFIRMED_EMERGENCY', // 112 zincirde ulaşılmadı ve notified112 yok → DISPATCH'siz kapanış
      'CLOSED',
    ]);
  });

  it('kullanıcı iptal ederse operatöre düşmez', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await send(sig('FALL'));
    await advance(5_000);
    await send(sig('CANCEL'));
    await advance(60_000);
    expect(await events.queue()).toHaveLength(0);
  });

  it('aynı idempotencyKey iki kez işlenmez', async () => {
    const s = sig('HEARTBEAT');
    expect(await h.signals.accept([s, s])).toEqual({ accepted: 1, duplicates: 1 });
  });
});
