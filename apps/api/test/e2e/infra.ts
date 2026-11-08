import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, createWriteStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from 'pg';
import YAML from 'yaml';

/**
 * T-016 uçtan uca / kaos test altyapısı — Docker'sız, gerçek süreçler:
 *   Redis      : redis-server (kalıcılıksız, sabit port; durdur/başlat)
 *   Postgres   : PGlite socket sunucusu, dosya veri dizini (durdur/başlat veriyi korur), çoklu bağlantı
 *   API        : `tsx src/main.ts` alt süreci (kill -9 / yeniden başlat)
 * Sınır: Postgres PGlite'tır (TimescaleDB hypertable yok). Gerçek Timescale ile koşum Docker/staging'de (T-083).
 */
const API_DIR = join(__dirname, '../..');
const RULES_SRC = join(API_DIR, '../../packages/rules');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });

/** Port dinleniyor mu: bağlanmayı dene (IPv4/IPv6 bağlamadan bağımsız). */
const portOpen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const sock = connect({ port, host: '127.0.0.1' });
    sock.once('connect', () => (sock.destroy(), resolve(true)));
    sock.once('error', () => resolve(false));
  });

async function until(cond: () => Promise<boolean> | boolean, ms: number, what: string) {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`zaman aşımı: ${what}`);
    await sleep(100);
  }
}

export const hasRedisServer = () => spawnSync('redis-server', ['--version']).status === 0;

interface Proc {
  url: string;
  start(): Promise<void>;
  stop(signal?: NodeJS.Signals): Promise<void>;
}

function managed(port: number, url: string, cmd: string, args: string[], logFile: string, env = {}): Proc {
  let child: ChildProcess | undefined;
  return {
    url,
    async start() {
      const log = createWriteStream(logFile, { flags: 'a' });
      child = spawn(cmd, args, { cwd: API_DIR, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout!.pipe(log);
      child.stderr!.pipe(log);
      await until(() => portOpen(port), 30_000, `${cmd} :${port}`);
    },
    async stop(signal = 'SIGTERM') {
      if (!child || child.exitCode !== null) return;
      const exited = new Promise((r) => child!.once('exit', r));
      child.kill(signal);
      await exited;
      await until(async () => !(await portOpen(port)), 10_000, `${cmd} kapanışı`);
    },
  };
}

export interface Stack {
  dir: string;
  redis: Proc;
  db: Proc;
  api: Proc & { base: string; env: Record<string, string> };
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

/**
 * Testler için hızlandırılmış kural paketi: süreler `timeScale` ile çarpılır (sn cinsinden tamsayı, en az 1).
 * Sürüm 999: depodaki paketle karışmaz.
 */
export function scaledRules(dir: string, timeScale: number) {
  const doc = YAML.parse(readFileSync(join(RULES_SRC, 'tr.yaml'), 'utf8'));
  doc.version = 999;
  for (const r of doc.rules)
    if (r.devicePrompt?.windowSec)
      r.devicePrompt.windowSec = Math.max(1, Math.round(r.devicePrompt.windowSec * timeScale));
  writeFileSync(join(dir, 'tr.yaml'), YAML.stringify(doc));
  copyFileSync(join(RULES_SRC, 'schema.json'), join(dir, 'schema.json'));
}

export async function startStack(opts: { timeScale?: number; env?: Record<string, string> } = {}): Promise<Stack> {
  const dir = mkdtempSync(join(tmpdir(), 'yanimda-e2e-'));
  scaledRules(dir, opts.timeScale ?? 1);
  const [redisPort, dbPort, apiPort] = [await freePort(), await freePort(), await freePort()];

  const redis = managed(
    redisPort,
    `redis://127.0.0.1:${redisPort}`,
    'redis-server',
    ['--port', String(redisPort), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'],
    join(dir, 'redis.log'),
  );
  const db = managed(
    dbPort,
    `postgres://postgres@127.0.0.1:${dbPort}/postgres`,
    join(API_DIR, 'node_modules/.bin/pglite-server'),
    [`--db=${join(dir, 'pgdata')}`, `--port=${dbPort}`, '--max-connections=20'],
    join(dir, 'pg.log'),
  );
  const env = {
    NODE_ENV: 'test',
    PORT: String(apiPort),
    DATABASE_URL: db.url,
    DATABASE_POOL_MAX: '5',
    REDIS_URL: redis.url,
    RULES_DIR: dir,
    TIMERS_PREFIX: `e2e-${apiPort}`,
    OUTBOX_POLL_MS: '200',
    EVENT_SWEEP_MS: '1000',
    EVENT_SWEEP_GRACE_MS: '5000',
    RULES_REFRESH_MS: '0',
    SIMULATOR_ENABLED: 'true',
    ...opts.env,
  };
  const apiProc = managed(
    apiPort,
    `http://127.0.0.1:${apiPort}`,
    join(API_DIR, 'node_modules/.bin/tsx'),
    ['src/main.ts'],
    join(dir, 'api.log'),
    env,
  );
  const api = { ...apiProc, base: `http://127.0.0.1:${apiPort}/v1`, env };

  await redis.start();
  await db.start();
  await api.start();

  let client: Client | undefined;
  const query = async <T>(sql: string, params: unknown[] = []) => {
    if (!client) {
      client = new Client({ connectionString: db.url });
      client.on('error', () => (client = undefined));
      await client.connect();
    }
    try {
      return (await client.query(sql, params)).rows as T[];
    } catch (e) {
      client = undefined;
      throw e;
    }
  };

  return {
    dir,
    redis,
    db,
    api,
    query,
    async close() {
      await client?.end().catch(() => undefined);
      await api.stop();
      await db.stop();
      await redis.stop();
      if (!process.env.E2E_KEEP) rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function waitFor<T>(
  fn: () => Promise<T | undefined | null | false>,
  ms: number,
  what: string,
): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`zaman aşımı (${ms} ms): ${what}`);
    await sleep(200);
  }
}
