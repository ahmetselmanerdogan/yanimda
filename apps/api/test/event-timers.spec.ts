import type { KafkaEnvelope, Signal } from '@yanimda/contracts';
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { bus } from '../src/common/bus';
import { BullTimers } from '../src/common/timers/bull-timers';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { EventService } from '../src/modules/event/event.service';
import { loadRulePack, type RulePack } from '../src/modules/event/rules.loader';
import { sig } from './support/harness';

/**
 * T-013 · D-09 olay zamanlayıcıları: EventService setTimeout yerine Timers arayüzünü kullanır.
 * İşleyici olayın GÜNCEL durumunu okur; beklenen durumda değilse hiçbir şey yapmaz (yarış güvenli).
 */
const deliver = (s: ReturnType<typeof sig>) =>
  bus.deliver<Signal>('signal.received', { payload: s } as unknown as KafkaEnvelope<Signal>);

describe('EventService + Timers (bellek içi, sahte saat)', () => {
  let timers: InMemoryTimers;
  let events: EventService;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    bus.clear();
    timers = new InMemoryTimers();
    events = new EventService(timers);
    events.onModuleInit();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('FALL → prompt-expire 60 sn kurulur (iş kimliği <olayId>.prompt-expire)', async () => {
    await deliver(sig('FALL'));
    const [ev] = events.all();
    expect(ev.state).toBe('DEVICE_PROMPT');
    expect(timers.pendingIds()).toEqual([`${ev.id}.prompt-expire`]);
    expect(timers.delayOf(`${ev.id}.prompt-expire`)).toBe(60_000);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(events.get(ev.id).state).toBe('DEVICE_PROMPT');
    await vi.advanceTimersByTimeAsync(1);
    expect(events.get(ev.id).state).toBe('OPERATOR_QUEUE');
  });

  it('CANCEL → zamanlayıcı işi silinir', async () => {
    await deliver(sig('FALL'));
    await deliver(sig('CANCEL'));
    expect(timers.pendingIds()).toEqual([]);
    expect(events.all()[0].state).toBe('CLOSED');
  });

  it('geç tetiklenen iş (iptalden sonra) durumu değiştirmez — yarış güvenli', async () => {
    await deliver(sig('FALL'));
    const [ev] = events.all();
    await deliver(sig('CANCEL'));
    await timers.fire(ev.id, 'prompt-expire'); // iptal yarışı kaybetti, iş yine de çalıştı
    expect(events.get(ev.id).state).toBe('CLOSED');
    expect(events.get(ev.id).transitions.map((t) => t.to)).not.toContain('ESCALATED');
  });

  it('aynı iş iki kez çalışsa da tek ESCALATED (en az bir kez teslim)', async () => {
    await deliver(sig('FALL'));
    const [ev] = events.all();
    await timers.fire(ev.id, 'prompt-expire');
    await timers.fire(ev.id, 'prompt-expire');
    expect(events.get(ev.id).transitions.filter((t) => t.to === 'ESCALATED')).toHaveLength(1);
  });

  it('bilinmeyen olay için iş (ör. yeniden başlatmada bellek kaybı) hata vermez', async () => {
    await expect(timers.fire('yok-olay', 'prompt-expire')).resolves.toBeUndefined();
  });

  it('INACTIVITY sessiz soru → silent-ask-expire 120 sn', async () => {
    await deliver(sig('INACTIVITY', { value: 45 }));
    const [ev] = events.all();
    expect(timers.pendingIds()).toEqual([`${ev.id}.silent-ask-expire`]);
    expect(timers.delayOf(`${ev.id}.silent-ask-expire`)).toBe(120_000);
    await timers.fire(ev.id, 'silent-ask-expire');
    expect(events.get(ev.id).state).toBe('OPERATOR_QUEUE');
  });

  it('EMERGENCY kapanışı → 24 saat sonra follow-up → FOLLOW_UP olayı P4 kuyrukta', async () => {
    await deliver(sig('SOS'));
    const [ev] = events.all();
    events.claim(ev.id, 'op-1');
    events.closeByOperator(ev.id, 'op-1', 'EMERGENCY', '112');
    expect(timers.delayOf(`${ev.id}.follow-up`)).toBe(24 * 3600 * 1000);
    await timers.fire(ev.id, 'follow-up');
    const fu = events.queue().find((e) => e.type === 'FOLLOW_UP')!;
    expect(fu).toMatchObject({ priority: 4, state: 'OPERATOR_QUEUE', protectedPersonId: 'pp-1' });
    expect(fu.sourceSignalIds).toEqual([`follow-up:${ev.id}`]);
  });

  it('OK kapanışında takip kurulmaz', async () => {
    await deliver(sig('SOS'));
    const [ev] = events.all();
    events.claim(ev.id, 'op-1');
    events.closeByOperator(ev.id, 'op-1', 'OK');
    expect(timers.pendingIds()).toEqual([]);
  });
});

/** Kabul: FALL → süreç yeniden başlat → süre dolunca ESCALATED (BullMQ işi Redis'te kalır). */
describe.skipIf(!inject('redisTestUrl'))('EventService + BullTimers (gerçek Redis)', () => {
  it('FALL → zamanlayıcı süreci yeniden başlar → süre dolunca ESCALATED; CANCEL işi siler', async () => {
    bus.clear();
    const url = inject('redisTestUrl')!;
    const prefix = `t013-e2e-${Date.now()}`;
    const base = loadRulePack();
    const pack: RulePack = {
      ...base,
      rules: base.rules.map((r) =>
        r.type === 'FALL' ? { ...r, devicePrompt: { ...r.devicePrompt!, windowSec: 0.6 } } : r,
      ),
    };

    // 1. süreç: FALL alındı, iş kuruldu, süreç öldü
    const t1 = new BullTimers({ url, prefix });
    const events = new EventService(t1, pack);
    events.onModuleInit();
    await t1.start();
    await deliver(sig('FALL', { protectedPersonId: 'pp-a' }));
    await deliver(sig('FALL', { protectedPersonId: 'pp-b' }));
    const [a, b] = events.all();
    await deliver(sig('CANCEL', { protectedPersonId: 'pp-b' })); // b iptal → iş silinir
    expect(await t1.pending()).toEqual([`${a.id}.prompt-expire`]);
    await t1.close();

    // 2. süreç: yeni zamanlayıcı işçisi. Olay durumu T-011b'ye kadar bellekte; burada aynı EventService
    //    örneği "kalıcı olay deposu" yerine geçer ve yeni zamanlayıcıyı dinler.
    const t2 = new BullTimers({ url, prefix });
    events.useTimers(t2);
    await t2.start();
    await vi.waitFor(() => expect(events.get(a.id).state).toBe('OPERATOR_QUEUE'), { timeout: 5000 });
    expect(events.get(b.id).state).toBe('CLOSED');
    await t2.close();
  });
});
