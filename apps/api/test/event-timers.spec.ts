import type { KafkaEnvelope, Signal } from '@yanimda/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { bus } from '../src/common/bus';
import { BullTimers } from '../src/common/timers/bull-timers';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import type { EventService } from '../src/modules/event/event.service';
import { loadRulePack, type RulePack } from '../src/modules/event/rules.loader';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * T-013 · D-09 olay zamanlayıcıları. İşleyici olayın GÜNCEL durumunu veritabanından (FOR UPDATE) okur;
 * beklenen durumda değilse hiçbir şey yapmaz (yarış güvenli, çift tetiklemeye dayanıklı).
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

const deliver = (s: ReturnType<typeof sig>) =>
  bus.deliver<Signal>('signal.received', { payload: s } as unknown as KafkaEnvelope<Signal>);

describe('EventService + Timers (bellek içi)', () => {
  let timers: InMemoryTimers;
  let events: EventService;
  beforeEach(() => {
    timers = new InMemoryTimers();
    events = h.events(timers);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('FALL → prompt-expire 60 sn kurulur (iş kimliği <olayId>.prompt-expire), süre dolunca kuyruk', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await deliver(sig('FALL'));
    const [ev] = await events.all();
    expect(ev.state).toBe('DEVICE_PROMPT');
    expect(timers.pendingIds()).toEqual([`${ev.id}.prompt-expire`]);
    expect(timers.delayOf(`${ev.id}.prompt-expire`)).toBe(60_000);
    await vi.advanceTimersByTimeAsync(59_999);
    await timers.idle();
    expect((await events.get(ev.id)).state).toBe('DEVICE_PROMPT');
    await vi.advanceTimersByTimeAsync(1);
    await timers.idle();
    expect((await events.get(ev.id)).state).toBe('OPERATOR_QUEUE');
  });

  it('CANCEL → zamanlayıcı işi silinir', async () => {
    await deliver(sig('FALL'));
    await deliver(sig('CANCEL'));
    expect(timers.pendingIds()).toEqual([]);
    expect((await events.all())[0].state).toBe('CLOSED');
  });

  it('geç tetiklenen iş (iptalden sonra) durumu değiştirmez — yarış güvenli', async () => {
    await deliver(sig('FALL'));
    const [ev] = await events.all();
    await deliver(sig('CANCEL'));
    await timers.fire(ev.id, 'prompt-expire');
    const after = await events.get(ev.id);
    expect(after.state).toBe('CLOSED');
    expect(after.transitions.map((t) => t.to)).not.toContain('ESCALATED');
  });

  it('aynı iş iki kez (hatta eş zamanlı) çalışsa da tek ESCALATED', async () => {
    await deliver(sig('FALL'));
    const [ev] = await events.all();
    await Promise.all([timers.fire(ev.id, 'prompt-expire'), timers.fire(ev.id, 'prompt-expire')]);
    expect((await events.get(ev.id)).transitions.filter((t) => t.to === 'ESCALATED')).toHaveLength(1);
  });

  it('bilinmeyen olay için iş hata vermez', async () => {
    await expect(timers.fire('00000000-0000-7000-8000-00000000abcd', 'prompt-expire')).resolves.toBeUndefined();
  });

  it('INACTIVITY sessiz soru → silent-ask-expire 120 sn', async () => {
    await deliver(sig('INACTIVITY', { value: 45 }));
    const [ev] = await events.all();
    expect(timers.pendingIds()).toEqual([`${ev.id}.silent-ask-expire`]);
    expect(timers.delayOf(`${ev.id}.silent-ask-expire`)).toBe(120_000);
    await timers.fire(ev.id, 'silent-ask-expire');
    expect((await events.get(ev.id)).state).toBe('OPERATOR_QUEUE');
  });

  it('EMERGENCY kapanışı → 24 saat sonra follow-up → FOLLOW_UP olayı P4 kuyrukta (bir kez)', async () => {
    await deliver(sig('SOS'));
    const [ev] = await events.all();
    await events.claim(ev.id, 'op-1');
    await events.closeByOperator(ev.id, 'op-1', 'EMERGENCY', '112');
    expect(timers.delayOf(`${ev.id}.follow-up`)).toBe(24 * 3600 * 1000);
    await timers.fire(ev.id, 'follow-up');
    await timers.fire(ev.id, 'follow-up'); // çift tetikleme
    const fus = (await events.queue()).filter((e) => e.type === 'FOLLOW_UP');
    expect(fus).toHaveLength(1);
    expect(fus[0]).toMatchObject({ priority: 4, state: 'OPERATOR_QUEUE', protectedPersonId: 'pp-1' });
    expect(fus[0].sourceSignalIds).toEqual([`follow-up:${ev.id}`]);
  });

  it('OK kapanışında takip kurulmaz', async () => {
    await deliver(sig('SOS'));
    const [ev] = await events.all();
    await events.claim(ev.id, 'op-1');
    await events.closeByOperator(ev.id, 'op-1', 'OK');
    expect(timers.pendingIds()).toEqual([]);
  });
});

/** T-013 kabulü uçtan uca: FALL → süreç yeniden başlar (yeni EventService + yeni BullTimers) → ESCALATED. */
describe.skipIf(!inject('redisTestUrl'))('EventService + BullTimers (gerçek Redis + Postgres)', () => {
  it('FALL → süreç yeniden başlar → süre dolunca ESCALATED; CANCEL işi siler', async () => {
    const url = inject('redisTestUrl')!;
    const prefix = `t011b-e2e-${Date.now()}`;
    const base = loadRulePack();
    const pack: RulePack = {
      ...base,
      rules: base.rules.map((r) =>
        r.type === 'FALL' ? { ...r, devicePrompt: { ...r.devicePrompt!, windowSec: 0.8 } } : r,
      ),
    };

    // 1. süreç: iki FALL; biri iptal; süreç ölür
    const t1 = new BullTimers({ url, prefix });
    const events1 = h.events(t1, pack);
    await t1.start();
    await deliver(sig('FALL', { protectedPersonId: 'pp-a' }));
    await deliver(sig('FALL', { protectedPersonId: 'pp-b' }));
    const byPerson = async (ev: EventService, p: string) => (await ev.all()).find((e) => e.protectedPersonId === p)!;
    const a = await byPerson(events1, 'pp-a');
    const b = await byPerson(events1, 'pp-b');
    await deliver(sig('CANCEL', { protectedPersonId: 'pp-b' }));
    expect(await t1.pending()).toEqual([`${a.id}.prompt-expire`]);
    await t1.close();
    bus.clear();

    // 2. süreç: yeni EventService (bellekte hiçbir şey yok) + yeni BullTimers; olay veritabanından okunur
    const t2 = new BullTimers({ url, prefix });
    const events2 = h.events(t2, pack);
    await t2.start();
    await vi.waitFor(async () => expect((await events2.get(a.id)).state).toBe('OPERATOR_QUEUE'), {
      timeout: 5000,
      interval: 100,
    });
    expect((await events2.get(b.id)).state).toBe('CLOSED');
    await t2.close();
  });
});
