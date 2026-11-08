import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';

import type { GlobalSetupContext } from 'vitest/node';

/**
 * BullMQ testleri için GERÇEK Redis (ioredis-mock BullMQ'nun Lua betiklerini çalıştıramaz).
 * Öncelik: REDIS_TEST_URL (CI servis konteyneri) → yerel `redis-server` (boş portta, kalıcılıksız) → yok (testler atlanır).
 */
declare module 'vitest' {
  export interface ProvidedContext {
    redisTestUrl: string | null;
  }
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });

let child: ChildProcess | undefined;

export default async function setup({ provide }: GlobalSetupContext) {
  if (process.env.REDIS_TEST_URL) {
    provide('redisTestUrl', process.env.REDIS_TEST_URL);
    return;
  }
  if (spawnSync('redis-server', ['--version']).status !== 0) {
    console.warn('[test] redis-server yok ve REDIS_TEST_URL tanımsız: BullMQ testleri atlanacak');
    provide('redisTestUrl', null);
    return;
  }
  const port = await freePort();
  child = spawn('redis-server', ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], {
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    if (
      spawnSync('redis-cli', ['-p', String(port), 'ping'])
        .stdout?.toString()
        .trim() === 'PONG'
    )
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  provide('redisTestUrl', `redis://127.0.0.1:${port}`);
  return () => {
    child?.kill();
  };
}
