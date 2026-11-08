import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { bus } from '../src/common/bus';
import { EventService } from '../src/modules/event/event.service';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * Uçtan uca: simülatör FALL → signal.signal + outbox → OutboxWorker → EventService → 60 sn → OPERATOR_QUEUE;
 * CANCEL → operatöre düşmez. 03 "Kritik akışlar". Olay durumu hâlâ bellek içi (T-011b), zamanlayıcılar setTimeout (T-013).
 */
let h: Harness;
let events: EventService;
beforeAll(async () => {
  h = await createHarness(bus);
});
beforeEach(async () => {
  await h.reset();
  events = new EventService();
  events.onModuleInit();
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

describe('FALL akışı', () => {
  it('cevap yoksa 60 sn sonra kuyruğa düşer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await send(sig('FALL'));
    expect(events.queue()).toHaveLength(0);
    vi.advanceTimersByTime(60_000);
    const q = events.queue();
    expect(q).toHaveLength(1);
    expect(q[0].type).toBe('FALL');
    expect(q[0].state).toBe('OPERATOR_QUEUE');
    const ev = events.claim(q[0].id, 'op-1');
    expect(ev.state).toBe('OPERATOR_ASSIGNED');
    events.closeByOperator(ev.id, 'op-1', 'EMERGENCY', '112 arandı');
    expect(events.get(ev.id).state).toBe('CLOSED');
    expect(events.get(ev.id).transitions.map((t) => t.to)).toEqual([
      'CREATED',
      'DEVICE_PROMPT',
      'ESCALATED',
      'OPERATOR_QUEUE',
      'OPERATOR_ASSIGNED',
      'CONFIRMED_EMERGENCY',
      'DISPATCH',
      'CLOSED',
    ]);
  });

  it('kullanıcı iptal ederse operatöre düşmez', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await send(sig('FALL'));
    vi.advanceTimersByTime(5_000);
    await send(sig('CANCEL'));
    vi.advanceTimersByTime(60_000);
    expect(events.queue()).toHaveLength(0);
  });

  it('aynı idempotencyKey iki kez işlenmez', async () => {
    const s = sig('HEARTBEAT');
    expect(await h.signals.accept([s, s])).toEqual({ accepted: 1, duplicates: 1 });
  });
});
