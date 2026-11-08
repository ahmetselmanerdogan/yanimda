import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SqlExecutor } from './client';

/**
 * Basit, geri alınabilir migration çalıştırıcı (X-05). Her migration: drizzle/migrations/<NNNN_ad>/{up,down}.sql.
 * Uygulananlar public.schema_migrations'ta tutulur. Birden çok API örneği aynı anda açılırsa advisory lock sıraya sokar.
 */
export const MIGRATIONS_DIR = join(__dirname, '../../drizzle/migrations');
const LOCK_KEY = 4_200_101; // sabit, uygulamaya özgü advisory lock anahtarı
const NAME = /^\d{4}_[a-z0-9_]+$/;

interface Migration {
  name: string;
  up: string;
  down: string;
}

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((n) => NAME.test(n))
    .sort()
    .map((name) => {
      const read = (f: string) => {
        const p = join(dir, name, f);
        if (!existsSync(p)) throw new Error(`Migration ${name}: ${f} eksik (her migration geri alınabilir olmalı)`);
        return readFileSync(p, 'utf8');
      };
      return { name, up: read('up.sql'), down: read('down.sql') };
    });
}

async function runTx(db: SqlExecutor, body: string): Promise<void> {
  try {
    await db.exec(`BEGIN;\n${body}\nCOMMIT;`);
  } catch (e) {
    await db.exec('ROLLBACK').catch(() => undefined); // bağlantı "aborted transaction" durumunda kalmasın
    throw e;
  }
}

async function withLock<T>(db: SqlExecutor, fn: () => Promise<T>): Promise<T> {
  await db.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  try {
    await db.exec(
      'CREATE TABLE IF NOT EXISTS public.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    return await fn();
  } finally {
    await db.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
  }
}

const applied = async (db: SqlExecutor) =>
  new Set((await db.query<{ name: string }>('SELECT name FROM public.schema_migrations')).map((r) => r.name));

/** Uygulanmamış migration'ları sırayla, her biri kendi transaction'ında uygular. Uygulanan adları döner. */
export async function migrate(db: SqlExecutor, dir = MIGRATIONS_DIR): Promise<string[]> {
  return withLock(db, async () => {
    const done = await applied(db);
    const ran: string[] = [];
    for (const m of loadMigrations(dir)) {
      if (done.has(m.name)) continue;
      await runTx(db, `${m.up}\n;INSERT INTO public.schema_migrations (name) VALUES ('${m.name}');`);
      ran.push(m.name);
    }
    return ran;
  });
}

/** Son `steps` migration'ı geri alır. Geri alınan adları döner. */
export async function down(db: SqlExecutor, steps = 1, dir = MIGRATIONS_DIR): Promise<string[]> {
  return withLock(db, async () => {
    const done = await applied(db);
    const targets = loadMigrations(dir)
      .filter((m) => done.has(m.name))
      .reverse()
      .slice(0, steps);
    for (const m of targets)
      await runTx(db, `${m.down}\n;DELETE FROM public.schema_migrations WHERE name = '${m.name}';`);
    return targets.map((m) => m.name);
  });
}
