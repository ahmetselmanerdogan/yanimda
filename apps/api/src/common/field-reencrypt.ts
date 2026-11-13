import type { SqlExecutor } from '../db/client';
import type { FieldCipher } from './field-cipher';

/**
 * T-081 (G-7; ASVS 1.6.1, 1.6.3) alan yeniden şifreleme: `FIELD_ENC_KEYS` döndürüldükten sonra (sirlar.md §4.1 Faz 2)
 * eski `kid` ile yazılmış şifreli alanları güncel yazar anahtarıyla yeniden yazar; bitince eski anahtar kaldırılabilir.
 *
 * - Toplu ve sürdürülebilir: tablo başına birincil anahtar sırasıyla `batch` satır; yarıda kesilirse yeniden çalıştırmak
 *   kaldığı yerden devam eder (eski satırlar filtreyle seçilir).
 * - İdempotent: yalnız `kid` ≠ yazar olan satırlar; ikinci çalıştırma 0 satır günceller.
 * - Eşzamanlı yazıma karşı güvenli: `UPDATE … WHERE sütun = <eski değer>` (arada uygulama yazdıysa satır atlanır).
 * - AAD (bağlam) değişmez: değer aynı satıra/alana bağlı kalır.
 * - Düz metin hiçbir yere yazılmaz; sonuç yalnız sayılardan oluşur (çözülemeyen satırların kimlikleri dönüş değerinde,
 *   log'a yazılmaz).
 *
 * Çalıştırma: `pnpm --filter @yanimda/api db:reencrypt [-- --dry-run] [-- --batch 500]` veya imajda
 * `node dist/db/cli.js reencrypt` (aynı `DATABASE_URL` ve `FIELD_ENC_KEYS` ile).
 */
export interface EncryptedField {
  /** Rapor adı (şema.tablo.sütun). */
  name: string;
  table: string;
  /** Birincil anahtar sütunu (uuid). */
  id: string;
  column: string;
  /** Şifrelemede kullanılan AAD — yazan kodla birebir aynı olmalı. */
  context: (id: string) => string;
}

/** FieldCipher kullanan tüm alanlar (yeni bir şifreli alan eklenirse buraya da eklenir; test bunu denetler). */
export const ENCRYPTED_FIELDS: readonly EncryptedField[] = [
  {
    // profile.service.ts ctxMedical
    name: 'health.medical_summary.ciphertext',
    table: 'health.medical_summary',
    id: 'protected_person_id',
    column: 'ciphertext',
    context: (id) => `medical:${id}`,
  },
  {
    // profile.service.ts ctxDoor
    name: 'profile.protected_person.door_access_note_enc',
    table: 'profile.protected_person',
    id: 'id',
    column: 'door_access_note_enc',
    context: (id) => `door:${id}`,
  },
  {
    // vendor-link.service.ts (T-085)
    name: 'device.vendor_link.vendor_account_enc',
    table: 'device.vendor_link',
    id: 'id',
    column: 'vendor_account_enc',
    context: (id) => `vendor-link:${id}`,
  },
];

export interface FieldReencryptResult {
  name: string;
  /** Eski anahtarla bulunan satır. */
  stale: number;
  /** Yeniden yazılan (dryRun'da 0). */
  updated: number;
  /** Arada uygulama tarafından değiştirildiği için atlanan. */
  skipped: number;
  /** Çözülemeyen (anahtar listede yok veya bozuk) satır sayısı. */
  failed: number;
  /** Çözülemeyen satırların birincil anahtarları (log'a yazılmaz; operatör inceler). */
  failedIds: string[];
}

export interface ReencryptOptions {
  batch?: number;
  dryRun?: boolean;
  fields?: readonly EncryptedField[];
}

/** Tüm şifreli alanları güncel yazar anahtarına taşır. */
export async function reencryptFields(
  db: SqlExecutor,
  cipher: FieldCipher,
  opts: ReencryptOptions = {},
): Promise<FieldReencryptResult[]> {
  const batch = Math.max(1, Math.min(opts.batch ?? 500, 10_000));
  const out: FieldReencryptResult[] = [];
  for (const f of opts.fields ?? ENCRYPTED_FIELDS) out.push(await reencryptField(db, cipher, f, batch, !!opts.dryRun));
  return out;
}

async function reencryptField(
  db: SqlExecutor,
  cipher: FieldCipher,
  f: EncryptedField,
  batch: number,
  dryRun: boolean,
): Promise<FieldReencryptResult> {
  const r: FieldReencryptResult = { name: f.name, stale: 0, updated: 0, skipped: 0, failed: 0, failedIds: [] };
  // Tablo/sütun adları sabit listeden (kullanıcı girdisi değil); değerler parametreli.
  const select = `SELECT ${f.id}::text AS id, ${f.column} AS value FROM ${f.table}
    WHERE ${f.column} IS NOT NULL AND split_part(${f.column}, ':', 2) <> $1 AND ${f.id} > $2::uuid
    ORDER BY ${f.id} LIMIT $3`;
  const update = `UPDATE ${f.table} SET ${f.column} = $1 WHERE ${f.id} = $2::uuid AND ${f.column} = $3 RETURNING 1 AS ok`;
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const rows = await db.query<{ id: string; value: string }>(select, [cipher.activeKid, after, batch]);
    if (!rows.length) break;
    for (const row of rows) {
      after = row.id;
      r.stale++;
      let next: string;
      try {
        next = cipher.encrypt(cipher.decrypt(row.value, f.context(row.id)), f.context(row.id));
      } catch {
        r.failed++;
        r.failedIds.push(row.id);
        continue;
      }
      if (dryRun) continue;
      const done = await db.query(update, [next, row.id, row.value]);
      if (done.length) r.updated++;
      else r.skipped++;
    }
    if (rows.length < batch) break;
  }
  return r;
}

/** Alan başına `kid` dağılımı (rotasyon durumu; sirlar.md §4.1 adım 4–5). */
export async function fieldKeyUsage(
  db: SqlExecutor,
  fields: readonly EncryptedField[] = ENCRYPTED_FIELDS,
): Promise<{ name: string; kid: string; count: number }[]> {
  const out: { name: string; kid: string; count: number }[] = [];
  for (const f of fields) {
    const rows = await db.query<{ kid: string; n: string | number }>(
      `SELECT split_part(${f.column}, ':', 2) AS kid, count(*) AS n FROM ${f.table}
        WHERE ${f.column} IS NOT NULL GROUP BY 1 ORDER BY 1`,
    );
    for (const x of rows) out.push({ name: f.name, kid: x.kid, count: Number(x.n) });
  }
  return out;
}
