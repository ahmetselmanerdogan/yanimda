import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import RedisMock from 'ioredis-mock';

import { bus as globalBus, LocalBus } from '../../src/common/bus';
import { OutboxBus } from '../../src/common/outbox';
import { OutboxWorker, type OutboxWorkerOptions } from '../../src/common/outbox.worker';
import { InMemoryTimers } from '../../src/common/timers/memory-timers';
import type { Timers } from '../../src/common/timers/timers';
import type { Db, SqlExecutor } from '../../src/db/client';
import { migrate } from '../../src/db/migrate';
import * as schema from '../../src/db/schema';
import { DeviceService } from '../../src/modules/device/device.service';
import { EventService } from '../../src/modules/event/event.service';
import type { RulePack, RulesProvider } from '../../src/modules/event/rules.loader';
import { IdempotencyStore } from '../../src/modules/signal/idempotency.store';
import { SignalService } from '../../src/modules/signal/signal.service';

/**
 * Docker'sız test düzeneği: PGlite (gömülü Postgres 16, WASM) + ioredis-mock.
 * Aynı migration'lar ve aynı SQL çalışır; yalnız TimescaleDB hypertable'ı yoktur (migration bunu koşullu atlar).
 * Testcontainers (gerçek Timescale + Redis) T-016'da CI'a eklenir.
 */
export interface Harness {
  pg: PGlite;
  db: Db;
  exec: SqlExecutor;
  redis: InstanceType<typeof RedisMock>;
  bus: LocalBus;
  outbox: OutboxBus;
  signals: SignalService;
  worker: (opts?: OutboxWorkerOptions) => OutboxWorker;
  /** Yeni EventService örneği (= yeni süreç); global bus'a abone olur, aynı veritabanını kullanır. */
  events: (timers?: Timers, rules?: RulePack | RulesProvider) => EventService;
  rows: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
  /** Testler arası: tabloları boşalt, Redis/outbox/servisleri yeniden kur (PGlite açılışı pahalı, paylaşılır). */
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

export function pgliteExecutor(pg: PGlite): SqlExecutor {
  return {
    exec: async (text) => {
      await pg.exec(text);
    },
    query: async (text, params = []) => (await pg.query(text, params)).rows as never,
  };
}

export async function createHarness(bus: LocalBus = globalBus): Promise<Harness> {
  const pg = new PGlite();
  const exec = pgliteExecutor(pg);
  await migrate(exec);
  const db = drizzle(pg, { schema }) as unknown as Db;
  const h = {
    pg,
    db,
    exec,
    bus,
    worker: (opts?: OutboxWorkerOptions) => new OutboxWorker(db, bus, h.outbox, opts),
    events: (timers?: Timers, rules?: RulePack | RulesProvider) => {
      const ev = new EventService(db, h.outbox, timers ?? new InMemoryTimers(), rules);
      ev.onModuleInit();
      return ev;
    },
    rows: async (sql: string, params?: unknown[]) => (await pg.query(sql, params ?? [])).rows as never,
    reset: async () => {
      h.redis?.disconnect();
      h.redis = new RedisMock();
      await h.redis.flushall(); // ioredis-mock örnekler arası veri paylaşır
      h.outbox = new OutboxBus(db);
      h.signals = new SignalService(db, new IdempotencyStore(h.redis), h.outbox, new DeviceService(db));
      bus.clear();
      await pg.exec(
        // audit.log append-only'dir (TRUNCATE reddedilir); testler kendi olay kimliğiyle süzer.
        'TRUNCATE chain.chain_step, chain.chain_run, signal.signal, event.outbox, event.outbox_dlq, event.outbox_lease, event.protection_state, event.threshold, event.transition, event.event, profile.invite, device.device, profile.protected_person RESTART IDENTITY CASCADE',
      );
    },
    close: async () => {
      h.redis.disconnect();
      await pg.close();
    },
  } as Harness;
  await h.reset();
  return h;
}

export const sig = (kind: string, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  idempotencyKey: `dev:${Date.now()}:${kind}:${Math.random().toString(36).slice(2)}`,
  deviceId: 'dev-1',
  protectedPersonId: 'pp-1',
  kind,
  occurredAt: new Date().toISOString(),
  ...extra,
});
