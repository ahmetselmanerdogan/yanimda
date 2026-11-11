import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { BullTimers } from '../src/common/timers/bull-timers';

/**
 * Denetim bulgusu (HIGH): işleyici kendi türünü (aynı iş kimliği `<olayId>.<tür>`) yeniden kurarsa BullMQ işi o anda
 * hâlâ 'active' olduğundan `queue.add` sessizce no-op olur; yerel yedek de eski işin 'completed' olayıyla silinir.
 * Gerçek kurban: DispatchService.check ('dispatch-check' kendini yeniden kurar → yalnız bir 112 varış uyarısı gider).
 * InMemoryTimers işi çalıştırmadan önce sildiği için hatayı gizler → burada GERÇEK BullMQ + Redis.
 * Redis bu dosyada ayrı süreçtir (son testte durdurulur); redis-server yoksa testler atlanır.
 */
const hasRedisServer = spawnSync('redis-server', ['--version']).status === 0;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean | Promise<boolean>, ms = 8000) => {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('zaman aşımı');
    await sleep(20);
  }
};

async function startRedis(): Promise<{ url: string; proc: ChildProcess }> {
  const port = await freePort();
  const proc = spawn(
    'redis-server',
    ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'],
    {
      stdio: 'ignore',
    },
  );
  for (let i = 0; i < 100; i++) {
    if (
      spawnSync('redis-cli', ['-p', String(port), 'ping'])
        .stdout?.toString()
        .trim() === 'PONG'
    )
      break;
    await sleep(100);
  }
  return { url: `redis://127.0.0.1:${port}`, proc };
}

describe.skipIf(!hasRedisServer)('BullTimers: işleyici kendi türünü yeniden kurar (gerçek Redis)', () => {
  let redis: { url: string; proc: ChildProcess };
  let prefix: string;
  const open: BullTimers[] = [];
  const make = (opts: { backupGraceMs?: number; deferPollMs?: number } = {}) => {
    const t = new BullTimers({ url: redis.url, prefix, addTimeoutMs: 1500, backupGraceMs: 60_000, ...opts });
    open.push(t);
    return t;
  };

  beforeAll(async () => {
    redis = await startRedis();
  }, 30_000);
  afterAll(() => {
    redis?.proc.kill('SIGKILL');
  });
  beforeEach(() => {
    prefix = `resched-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });
  afterEach(async () => {
    await Promise.all(open.splice(0).map((t) => t.close()));
  });

  it('işleyici kendini 3 kez yeniden kurar → 4 kez tetiklenir (yedekten değil, BullMQ işinden)', async () => {
    const t = make(); // yedek 60 sn sonra: tetiklemeler yalnız Redis işinden gelebilir
    let n = 0;
    t.on('dispatch-check', async (j) => {
      n++;
      if (n < 4) await t.schedule(j.eventId, 'dispatch-check', 50);
    });
    await t.start();
    await t.schedule('ev-r1', 'dispatch-check', 50);
    await until(() => n === 4);
    await sleep(500);
    expect(n).toBe(4);
    expect(await t.pending()).not.toContain('ev-r1.dispatch-check');
  });

  it('yeniden kurulan iş verilen gecikmeye uyar (hemen tetiklenmez)', async () => {
    const t = make();
    const at: number[] = [];
    t.on('dispatch-check', async (j) => {
      at.push(Date.now());
      if (at.length === 1) await t.schedule(j.eventId, 'dispatch-check', 600);
    });
    await t.start();
    await t.schedule('ev-r2', 'dispatch-check', 10);
    await until(() => at.length === 2);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(550);
  });

  it('iptal hâlâ çalışır: kurulmadan önce, işleyici içinde ve yeniden kurulduktan sonra', async () => {
    const t = make();
    let n = 0;
    let cancelInside = false;
    t.on('dispatch-check', async (j) => {
      n++;
      await t.schedule(j.eventId, 'dispatch-check', 300);
      if (cancelInside) await t.cancel(j.eventId, 'dispatch-check'); // bekleyen yeniden kurulum da iptal olur
    });
    await t.start();

    // 1) iş çalışmadan iptal
    await t.schedule('ev-c1', 'dispatch-check', 300);
    await t.cancel('ev-c1', 'dispatch-check');
    await sleep(600);
    expect(n).toBe(0);

    // 2) işleyici kendini kurar, ardından (iş Redis'e geçtikten sonra) dışarıdan iptal
    await t.schedule('ev-c2', 'dispatch-check', 10);
    await until(() => n === 1);
    await until(async () => (await t.pending()).includes('ev-c2.dispatch-check'));
    await t.cancel('ev-c2', 'dispatch-check');
    await sleep(700);
    expect(n).toBe(1);

    // 3) işleyici kendini kurar ve aynı turda iptal eder (iş hâlâ 'active')
    cancelInside = true;
    await t.schedule('ev-c3', 'dispatch-check', 10);
    await until(() => n === 2);
    await sleep(700);
    expect(n).toBe(2);
    expect(await t.pending()).not.toContain('ev-c3.dispatch-check');
  });

  it('bekleyen (delayed) iş yeniden kurulursa mevcut anlam korunur: ilki kalır, bir kez tetiklenir', async () => {
    const t = make();
    const got: unknown[] = [];
    t.on('follow-up', async (j) => void got.push(j.data));
    await t.start();
    await t.schedule('ev-d', 'follow-up', 200, { v: 1 });
    await t.schedule('ev-d', 'follow-up', 50, { v: 2 });
    await until(() => got.length === 1);
    await sleep(400);
    expect(got).toEqual([{ v: 1 }]);
  });

  it('başka süreçte çalışan iş için kurulum, iş bitince uygulanır (yoklama)', async () => {
    const a = make(); // işçi
    const b = make({ deferPollMs: 100 }); // işçisi olmayan ikinci API örneği
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    a.on('dispatch-check', async () => {
      if (++n === 1) await gate;
    });
    await a.start();
    await a.schedule('ev-x', 'dispatch-check', 10);
    await until(() => n === 1); // iş A'da 'active'
    await b.schedule('ev-x', 'dispatch-check', 50);
    release();
    await until(() => n === 2);
  });

  it("yeniden kurulumdan sonra Redis durursa yerel yedek yine tetikler (eski işin 'completed'ı yedeği silmez)", async () => {
    const t = make({ backupGraceMs: 300 });
    let n = 0;
    t.on('dispatch-check', async (j) => {
      if (++n === 1) await t.schedule(j.eventId, 'dispatch-check', 800);
    });
    await t.start();
    await t.schedule('ev-b', 'dispatch-check', 10);
    await until(() => n === 1);
    await until(async () => (await t.pending()).includes('ev-b.dispatch-check')); // yeni iş Redis'te
    redis.proc.kill('SIGKILL'); // Redis çöktü: iş artık işçiye gelemez
    await until(() => n === 2, 5000); // 800 + 300 ms sonra yedekten
    expect(n).toBe(2);
  });
});
