import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import type { Pool } from 'pg';

import { bus } from './common/bus';
import { OutboxBus } from './common/outbox';
import { OutboxWorker } from './common/outbox.worker';
import { createDb, createPool, DB, type Db, PG_POOL, pgExecutor } from './db/client';
import { migrate } from './db/migrate';
import { IdempotencyStore, REDIS } from './modules/signal/idempotency.store';

const log = new Logger('Core');

/** Uygulama açılırken (EventService abone olduktan sonra) işçiyi başlatır, kapanırken durdurur. */
@Injectable()
class Lifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    @Inject(OutboxWorker) private readonly worker: OutboxWorker,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}
  onApplicationBootstrap() {
    if (process.env.OUTBOX_WORKER !== 'off') this.worker.start();
  }
  async onApplicationShutdown() {
    this.worker.stop();
    await this.worker.drain().catch(() => undefined);
    this.redis.disconnect();
    await this.pool.end();
  }
}

/** Ortak altyapı: Postgres (Drizzle), Redis, outbox yazıcı ve işçi. */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: async () => {
        const pool = createPool();
        if (process.env.DB_MIGRATE_ON_START !== 'false') {
          const client = await pool.connect();
          try {
            const ran = await migrate(pgExecutor(client));
            if (ran.length) log.log(`Migration uygulandı: ${ran.join(', ')}`);
          } finally {
            client.release();
          }
        }
        return pool;
      },
    },
    { provide: DB, inject: [PG_POOL], useFactory: (pool: Pool) => createDb(pool) },
    {
      provide: REDIS,
      useFactory: () => {
        const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false, // Redis yoksa komut hemen hata verir → veritabanı tekilliğine düşülür
        });
        let last = 0;
        redis.on('error', (e) => {
          if (Date.now() - last > 30_000) log.warn(`Redis: ${e.message}`);
          last = Date.now();
        });
        return redis;
      },
    },
    { provide: IdempotencyStore, inject: [REDIS], useFactory: (r: Redis) => new IdempotencyStore(r) },
    { provide: OutboxBus, inject: [DB], useFactory: (db: Db) => new OutboxBus(db) },
    {
      provide: OutboxWorker,
      inject: [DB, OutboxBus],
      useFactory: (db: Db, o: OutboxBus) => new OutboxWorker(db, bus, o),
    },
    Lifecycle,
  ],
  exports: [DB, REDIS, IdempotencyStore, OutboxBus],
})
export class CoreModule {}
