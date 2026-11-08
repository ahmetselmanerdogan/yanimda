import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { Pool, type PoolClient } from 'pg';

import * as schema from './schema';

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

export function createPool(url = process.env.DATABASE_URL): Pool {
  if (!url) throw new Error('DATABASE_URL tanımlı değil (.env.example)');
  return new Pool({ connectionString: url, max: Number(process.env.DATABASE_POOL_MAX ?? 10) });
}

export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema }) as unknown as Db;
}

export function pgExecutor(client: PoolClient): SqlExecutor {
  return {
    exec: async (text) => {
      await client.query(text);
    },
    query: async <T>(text: string, params: unknown[] = []) => (await client.query(text, params)).rows as T[],
  };
}
