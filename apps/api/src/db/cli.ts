import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FieldCipher } from '../common/field-cipher';
import { fieldKeyUsage, reencryptFields } from '../common/field-reencrypt';
import { createPool, pgExecutor } from './client';
import { down, migrate } from './migrate';

const USAGE =
  'kullanım: cli.ts migrate | rollback [adım] | seed | field-keys | reencrypt [--dry-run] [--batch N] [--show-failed]';

/**
 * pnpm db:migrate | db:rollback | db:seed | db:field-keys | db:reencrypt — DATABASE_URL'e karşı çalışır.
 * `reencrypt` / `field-keys` FIELD_ENC_KEYS ister (sirlar.md §4.1); çıktı yalnız sayılar (düz metin yok).
 */
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = rest[0];
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
    } else if (cmd === 'field-keys') {
      for (const u of await fieldKeyUsage(db)) console.log(`${u.name}\tkid=${u.kid}\t${u.count}`);
    } else if (cmd === 'reencrypt') {
      if (!process.env.FIELD_ENC_KEYS) throw new Error('FIELD_ENC_KEYS gerekli (yazar anahtar ilk sırada)');
      const cipher = new FieldCipher(process.env.FIELD_ENC_KEYS);
      const i = rest.indexOf('--batch');
      const batch = i >= 0 ? Number(rest[i + 1]) : undefined;
      if (batch !== undefined && !(Number.isInteger(batch) && batch > 0)) throw new Error(USAGE);
      const dryRun = rest.includes('--dry-run');
      const results = await reencryptFields(db, cipher, { batch, dryRun });
      let failed = 0;
      for (const r of results) {
        failed += r.failed;
        console.log(
          `${r.name}\tyazar=${cipher.activeKid}\teski=${r.stale}\tyeniden_yazılan=${r.updated}` +
            `\tatlanan=${r.skipped}\tçözülemeyen=${r.failed}${dryRun ? '\t(deneme)' : ''}`,
        );
        // Birincil anahtarlar (uuid) yalnız istenirse; içerik asla yazılmaz.
        if (rest.includes('--show-failed') && r.failedIds.length)
          console.log(`  çözülemeyen: ${r.failedIds.join(',')}`);
      }
      if (failed) process.exitCode = 2;
    } else throw new Error(USAGE);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
