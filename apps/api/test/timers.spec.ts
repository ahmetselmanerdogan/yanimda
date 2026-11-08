import { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';

import { BullTimers } from '../src/common/timers/bull-timers';
import { type TimerJob, timerJobId } from '../src/common/timers/timers';

/**
 * T-013 · D-09 Zamanlayıcılar (BullMQ, gerçek Redis). Kabul:
 *  - iş kimliği <olayId>.<tür>, aynı iş iki kez kurulmaz; iptal işi siler
 *  - süreç yeniden başlasa da iş Redis'te kalır ve süresi gelince çalışır
 *  - Redis yoksa yerel yedek zamanlayıcı yine tetikler (FALL sessizce kaybolmaz)
 */
const url = inject('redisTestUrl');
const until = async (cond: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('zaman aşımı');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe.skipIf(!url)('BullTimers (gerçek Redis)', () => {
  let prefix: string;
  const open: BullTimers[] = [];
  const make = () => {
    const t = new BullTimers({ url: url!, prefix, addTimeoutMs: 1500 });
    open.push(t);
    return t;
  };

  beforeEach(() => {
    prefix = `t013-${Date.now()}-${Math.random().toString(36).slice(2)}`; // testler birbirinin işini görmesin
  });
  afterEach(async () => {
    await Promise.all(open.splice(0).map((t) => t.close()));
  });

  it('iş kimliği <olayId>.<tür> (BullMQ ":" kabul etmez)', () => {
    expect(timerJobId('01a1-ev', 'prompt-expire')).toBe('01a1-ev.prompt-expire');
  });

  it('süresi gelince ilgili tür işleyicisini çağırır', async () => {
    const t = make();
    const got: TimerJob[] = [];
    t.on('prompt-expire', async (j) => void got.push(j));
    await t.start();
    const t0 = Date.now();
    await t.schedule('ev-1', 'prompt-expire', 300, { note: 'x' });
    await until(() => got.length === 1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
    expect(got[0]).toMatchObject({ eventId: 'ev-1', kind: 'prompt-expire', data: { note: 'x' } });
  });

  it('aynı iş iki kez kurulursa bir kez çalışır (idempotent)', async () => {
    const t = make();
    let n = 0;
    t.on('follow-up', async () => void n++);
    await t.start();
    await t.schedule('ev-2', 'follow-up', 200);
    await t.schedule('ev-2', 'follow-up', 200);
    await until(() => n >= 1);
    await new Promise((r) => setTimeout(r, 400));
    expect(n).toBe(1);
  });

  it('iptal işi siler, işleyici çağrılmaz', async () => {
    const t = make();
    let n = 0;
    t.on('prompt-expire', async () => void n++);
    await t.start();
    await t.schedule('ev-3', 'prompt-expire', 300);
    expect(await t.pending()).toContain('ev-3.prompt-expire');
    await t.cancel('ev-3', 'prompt-expire');
    expect(await t.pending()).not.toContain('ev-3.prompt-expire');
    await new Promise((r) => setTimeout(r, 600));
    expect(n).toBe(0);
  });

  it("süreç yeniden başlasa da iş Redis'te kalır ve yeni süreçte çalışır", async () => {
    const before = make();
    await before.start();
    await before.schedule('ev-4', 'prompt-expire', 500);
    await before.close(); // süreç öldü (iş henüz çalışmadı)

    const after = make(); // yeni süreç
    const got: string[] = [];
    after.on('prompt-expire', async (j) => void got.push(j.eventId));
    await after.start();
    await until(() => got.length === 1);
    expect(got).toEqual(['ev-4']);
  });

  it('işleyici hata verirse yeniden denenir', async () => {
    const t = make();
    let calls = 0;
    t.on('connection-lost', async () => {
      if (++calls < 3) throw new Error('geçici');
    });
    await t.start();
    await t.schedule('ev-5', 'connection-lost', 10);
    await until(() => calls === 3, 8000);
  });

  it('tamamlanan iş yeniden kurulabilir (aynı olay için yeni takip)', async () => {
    const t = make();
    let n = 0;
    t.on('watch-off-remind', async () => void n++);
    await t.start();
    await t.schedule('ev-6', 'watch-off-remind', 10);
    await until(() => n === 1);
    await t.schedule('ev-6', 'watch-off-remind', 10);
    await until(() => n === 2);
  });

  it('bilinmeyen tür reddedilir', async () => {
    const t = make();
    await expect(t.schedule('ev-7', 'nope' as never, 10)).rejects.toThrow(/tür/);
  });
});

describe('BullTimers Redis erişilemezken', () => {
  it('yerel yedek zamanlayıcı işleyiciyi yine çağırır (olay sessizce kaybolmaz)', async () => {
    const t = new BullTimers({ url: 'redis://127.0.0.1:1', prefix: 'down', addTimeoutMs: 300 });
    const got: string[] = [];
    t.on('prompt-expire', async (j) => void got.push(j.eventId));
    const t0 = Date.now();
    await t.schedule('ev-down', 'prompt-expire', 200); // asılı kalmaz
    expect(Date.now() - t0).toBeLessThan(1500);
    await until(() => got.length === 1, 3000);
    expect(got).toEqual(['ev-down']);
    await t.cancel('ev-down', 'prompt-expire');
    await t.close();
  });

  it('yedek zamanlayıcı da iptal edilebilir', async () => {
    const t = new BullTimers({ url: 'redis://127.0.0.1:1', prefix: 'down2', addTimeoutMs: 300 });
    let n = 0;
    t.on('prompt-expire', async () => void n++);
    await t.schedule('ev-c', 'prompt-expire', 300);
    await t.cancel('ev-c', 'prompt-expire');
    await new Promise((r) => setTimeout(r, 600));
    expect(n).toBe(0);
    await t.close();
  });
});

describe.skipIf(!url)('Redis anahtarları', () => {
  it('işler kalıcı Redis anahtarlarında durur (bull:<prefix>…)', async () => {
    const t = new BullTimers({ url: url!, prefix: 'keys-check' });
    await t.schedule('ev-k', 'battery-dead', 60_000);
    const r = new Redis(url!);
    const keys = await r.keys('keys-check:timers:ev-k.battery-dead');
    expect(keys).toHaveLength(1);
    await t.cancel('ev-k', 'battery-dead');
    r.disconnect();
    await t.close();
  });
});
