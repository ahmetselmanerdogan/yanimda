import { describe, expect, it, vi } from 'vitest';

import { EventService } from '../src/modules/event/event.service';
import { SignalService } from '../src/modules/signal/signal.service';

/** Uçtan uca (bellek içi): simülatör FALL → 60 sn → OPERATOR_QUEUE; CANCEL → CLOSED(FALSE_ALARM). 03 "Kritik akışlar". */
const sig = (kind: string, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  idempotencyKey: `dev:${Date.now()}:${kind}:${Math.random()}`,
  deviceId: 'dev-1',
  protectedPersonId: 'pp-1',
  kind,
  occurredAt: new Date().toISOString(),
  ...extra,
});

describe('FALL akışı', () => {
  it('cevap yoksa 60 sn sonra kuyruğa düşer', () => {
    vi.useFakeTimers();
    const events = new EventService();
    events.onModuleInit();
    const signals = new SignalService();
    signals.accept([sig('FALL')]);
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
    vi.useRealTimers();
  });
  it('kullanıcı iptal ederse operatöre düşmez', () => {
    vi.useFakeTimers();
    const events = new EventService();
    events.onModuleInit();
    const signals = new SignalService();
    signals.accept([sig('FALL')]);
    vi.advanceTimersByTime(5_000);
    signals.accept([sig('CANCEL')]);
    vi.advanceTimersByTime(60_000);
    expect(events.queue()).toHaveLength(0);
    vi.useRealTimers();
  });
  it('aynı idempotencyKey iki kez işlenmez', () => {
    const signals = new SignalService();
    const s = sig('HEARTBEAT');
    expect(signals.accept([s, s])).toEqual({ accepted: 1, duplicates: 1 });
  });
});
