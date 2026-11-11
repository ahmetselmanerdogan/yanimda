import { Logger } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { Pool, type PoolClient, type QueryConfig } from 'pg';

import { safeError } from '../common/safe-error';
import * as schema from './schema';

const poolLog = new Logger('Postgres');

/** Sürücüden bağımsız Drizzle veritabanı (üretim: node-postgres; test: PGlite). */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Migration çalıştırıcı için tek bağlantılı ham SQL arayüzü (çok ifadeli metin + parametreli sorgu). */
export interface SqlExecutor {
  exec(text: string): Promise<void>;
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

export const DB = Symbol('DB');
export const PG_POOL = Symbol('PG_POOL');

const positive = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

/** Migration (dizin oluşturma vb.) uzun sürebilir: sorgu zaman aşımı yalnız uygulama sorguları için. */
const MIGRATION_QUERY_TIMEOUT_MS = 3_600_000;
/** pg sorgu başına `query_timeout`'u destekler (client.js), tip tanımı içermez. */
const longQuery = (text: string, values?: unknown[]) =>
  ({ text, values, query_timeout: MIGRATION_QUERY_TIMEOUT_MS }) as QueryConfig;

/**
 * Postgres havuzu. Zaman aşımları olay kaybını / gecikmesini önler: Postgres yeniden başlarken (failover, ağ
 * bölünmesi) TCP'yi kabul edip yanıt vermeyen bir bağlantı zaman aşımı olmadan sonsuza dek bekler; outbox işçisi
 * o sorguda takılır ve SOS kuyruğa düşmez (T-080 kaos, CI 2026-11-11). Bağlantı `DATABASE_CONNECT_TIMEOUT_MS`
 * (5 sn), sorgu `DATABASE_QUERY_TIMEOUT_MS` (30 sn) sonra hata verir → istek 503, işçi bir sonraki turda yeniden
 * dener. Okuma zaman aşımına uğrayan bağlantı kapatılır (yanıtı hâlâ beklenen bağlantı havuza dönmez).
 */
export function createPool(
  url = process.env.DATABASE_URL,
  opts: { connectTimeoutMs?: number; queryTimeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Pool {
  if (!url) throw new Error('DATABASE_URL tanımlı değil (.env.example)');
  const env = opts.env ?? process.env;
  const pool = new Pool({
    connectionString: url,
    max: Number(env.DATABASE_POOL_MAX ?? 10),
    connectionTimeoutMillis: opts.connectTimeoutMs ?? positive(env.DATABASE_CONNECT_TIMEOUT_MS, 5_000),
    query_timeout: opts.queryTimeoutMs ?? positive(env.DATABASE_QUERY_TIMEOUT_MS, 30_000),
    // Ağ bölünmesinde ölü bağlantıyı işletim sistemi varsayılanı (2 sa) yerine ~10 sn'de fark et.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
  // Boştaki bağlantı koparsa (failover, ağ) pg havuzu 'error' yayar; dinleyici yoksa süreç çöker.
  // Havuz bağlantıyı atar, sonraki istek yenisini açar; istek sırasında kopan bağlantı zaten 503 olur.
  let last = 0;
  const lost = (e: unknown) => {
    if (Date.now() - last > 10_000) poolLog.warn(`Postgres bağlantısı koptu: ${safeError(e)}`);
    last = Date.now();
  };
  pool.on('error', lost);
  pool.on('connect', (client) => {
    // Havuz kendi dinleyicisini yalnız boştaki istemciye takar. Kullanımdaki istemcinin soketi kapanırsa (aşağıdaki
    // zaman aşımı, Postgres yeniden başlatma) istemci 'error' yayar; dinleyici yoksa süreç çöker. Sorgu zaten hata
    // alır; release'te havuz sorgulanamaz istemciyi atar.
    client.on('error', lost);
  });
  // Okuma zaman aşımı (pg yalnız sorguyu bırakır, soket açık kalır): bağlantıyı kapat ki havuz onu atsın.
  pool.on('connect', (client) => {
    const c = client as unknown as {
      query: (...a: unknown[]) => unknown;
      connection?: { stream?: { destroy(): void } };
    };
    const query = c.query.bind(client);
    c.query = (...args: unknown[]) => {
      const r = query(...args);
      if (r && typeof (r as Promise<unknown>).then === 'function')
        (r as Promise<unknown>).catch((e: unknown) => {
          if ((e as Error)?.message === 'Query read timeout') {
            poolLog.warn('Postgres sorgusu zaman aşımı: bağlantı kapatıldı');
            c.connection?.stream?.destroy();
          }
        });
      return r;
    };
  });
  return pool;
}

export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema }) as unknown as Db;
}

export function pgExecutor(client: PoolClient): SqlExecutor {
  return {
    exec: async (text) => {
      await client.query(longQuery(text));
    },
    query: async <T>(text: string, params: unknown[] = []) => (await client.query(longQuery(text, params))).rows as T[],
  };
}
