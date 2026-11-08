import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createPool, pgExecutor } from './client';
import { down, migrate } from './migrate';

/** pnpm db:migrate | db:rollback | db:seed — DATABASE_URL'e karşı çalışır. */
async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const pool = createPool();
  const client = await pool.connect();
  const db = pgExecutor(client);
  try {
    if (cmd === 'migrate') console.log('uygulandı:', (await migrate(db)).join(', ') || '(yok)');
    else if (cmd === 'rollback') console.log('geri alındı:', (await down(db, Number(arg ?? 1))).join(', ') || '(yok)');
    else if (cmd === 'seed') {
      await migrate(db);
      await db.exec(readFileSync(join(__dirname, '../../drizzle/seed-dev.sql'), 'utf8'));
      console.log('demo verisi yüklendi');
    } else throw new Error('kullanım: cli.ts migrate | rollback [adım] | seed');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
