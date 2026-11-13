import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FieldCipher } from '../src/common/field-cipher';
import { ENCRYPTED_FIELDS, fieldKeyUsage, reencryptFields } from '../src/common/field-reencrypt';
import type { SqlExecutor } from '../src/db/client';
import { createHarness, type Harness } from './support/harness';

/**
 * T-081 (G-7; ASVS 1.6.1, 1.6.3): FIELD_ENC_KEYS döndürmesinden sonra eski `kid` ile yazılmış alanların toplu yeniden
 * şifrelenmesi (sirlar.md §4.1 adım 4). Kabul: tüm FieldCipher alanları kapsanır, toplu, idempotent, eşzamanlı yazımı
 * ezmez, çözülemeyeni atlar ve sayar, düz metin sonuçta yok.
 */
const k = () => randomBytes(32).toString('base64');
const K1 = `k1:${k()}`;
const K2 = `k2:${k()}`;
const old = new FieldCipher(K1);
const rotated = new FieldCipher(`${K2},${K1}`);
const onlyNew = new FieldCipher(K2);
const stranger = new FieldCipher(`k9:${k()}`);

const P = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const DEV = '00000000-0000-4000-8000-0000000000d1';
const LINK = '00000000-0000-4000-8000-0000000000e1';
const MED = (n: number) => JSON.stringify({ conditions: [`gizli-tani-${n}`] });
const DOOR = (n: number) => `kapi-kodu-${n}`;

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.reset();
  const q = (sql: string, params: unknown[]) => h.pg.query(sql, params);
  for (const n of [1, 2, 3, 4]) {
    // p1, p2 eski anahtar; p3 zaten güncel; p4 bilinmeyen anahtar (çözülemez)
    const c = n === 3 ? rotated : n === 4 ? stranger : old;
    await q('INSERT INTO profile.protected_person (id, display_name, door_access_note_enc) VALUES ($1, $2, $3)', [
      P(n),
      `K${n}`,
      c.encrypt(DOOR(n), `door:${P(n)}`),
    ]);
    if (n !== 4)
      await q(
        `INSERT INTO health.medical_summary (protected_person_id, ciphertext, consent_at, consent_by)
         VALUES ($1, $2, now(), 'test')`,
        [P(n), c.encrypt(MED(n), `medical:${P(n)}`)],
      );
  }
  await q(`INSERT INTO device.device (id, protected_person_id, kind) VALUES ($1, $2, 'WEAROS_WATCH')`, [DEV, P(1)]);
  await q(
    `INSERT INTO device.vendor_link (id, partner, vendor_device_id, vendor_account_enc, device_id, protected_person_id,
       model_id, data_region, consent_basis) VALUES ($1, 'FAKE_PENDANT', 'v-1', $2, $3, $4, 'WEAROS_WATCH', 'TR', 'NOT_REQUIRED')`,
    [LINK, old.encrypt('acct-42', `vendor-link:${LINK}`), DEV, P(1)],
  );
});

const byName = (rs: Awaited<ReturnType<typeof reencryptFields>>) => Object.fromEntries(rs.map((r) => [r.name, r]));
const all = async () => ({
  door: await h.rows<{ id: string; v: string }>(
    'SELECT id::text, door_access_note_enc AS v FROM profile.protected_person ORDER BY id',
  ),
  med: await h.rows<{ id: string; v: string }>(
    'SELECT protected_person_id::text AS id, ciphertext AS v FROM health.medical_summary ORDER BY 1',
  ),
  link: await h.rows<{ id: string; v: string }>('SELECT id::text, vendor_account_enc AS v FROM device.vendor_link'),
});

describe('alan yeniden şifreleme (FIELD_ENC_KEYS döndürme)', () => {
  it('tüm şifreli sütunlar kapsamda (yeni şifreli alan eklenirse liste güncellenmeli)', async () => {
    const cols = await h.rows<{ name: string }>(
      `SELECT table_schema || '.' || table_name || '.' || column_name AS name FROM information_schema.columns
        WHERE (column_name LIKE '%\\_enc' OR column_name = 'ciphertext') AND table_schema NOT IN ('pg_catalog')
        ORDER BY 1`,
    );
    // token_enc: T-085 bulut ortakları için ayrılmış, bugün hiçbir kod yazmıyor (yalnız iptalde NULL'lanır).
    const notYetWritten = ['device.vendor_link.token_enc'];
    expect(cols.map((c) => c.name).filter((n) => !notYetWritten.includes(n))).toEqual(
      ENCRYPTED_FIELDS.map((f) => f.name).sort(),
    );
  });

  it('deneme (dry-run): sayar, yazmaz', async () => {
    const before = await all();
    const r = byName(await reencryptFields(h.exec, rotated, { dryRun: true }));
    expect(r['health.medical_summary.ciphertext']).toMatchObject({ stale: 2, updated: 0, failed: 0 });
    expect(r['profile.protected_person.door_access_note_enc']).toMatchObject({ stale: 3, updated: 0, failed: 1 });
    expect(r['device.vendor_link.vendor_account_enc']).toMatchObject({ stale: 1, updated: 0 });
    expect(await all()).toEqual(before);
  });

  it('toplu (batch=1) yeniden yazar; AAD aynı; yeni anahtar tek başına okur; ikinci çalıştırma 0 (idempotent)', async () => {
    const r = byName(await reencryptFields(h.exec, rotated, { batch: 1 }));
    expect(r['health.medical_summary.ciphertext']).toMatchObject({ stale: 2, updated: 2, skipped: 0, failed: 0 });
    expect(r['profile.protected_person.door_access_note_enc']).toMatchObject({
      stale: 3,
      updated: 2,
      failed: 1,
      failedIds: [P(4)],
    });
    expect(r['device.vendor_link.vendor_account_enc']).toMatchObject({ stale: 1, updated: 1 });

    const { door, med, link } = await all();
    for (const row of med) {
      expect(row.v).toMatch(/^v1:k2:/);
      const n = Number(row.id.slice(-1));
      expect(onlyNew.decrypt(row.v, `medical:${row.id}`)).toBe(MED(n));
      // AAD korunur: başka kişinin bağlamıyla çözülmez
      expect(() => onlyNew.decrypt(row.v, `medical:${P(9)}`)).toThrow();
    }
    for (const row of door.filter((d) => d.id !== P(4)))
      expect(onlyNew.decrypt(row.v, `door:${row.id}`)).toBe(DOOR(Number(row.id.slice(-1))));
    expect(door.find((d) => d.id === P(4))!.v).toMatch(/^v1:k9:/); // çözülemeyen dokunulmadan kalır
    expect(onlyNew.decrypt(link[0]!.v, `vendor-link:${LINK}`)).toBe('acct-42');

    const again = await reencryptFields(h.exec, rotated);
    expect(again.reduce((s, x) => s + x.updated, 0)).toBe(0);
    expect(again.reduce((s, x) => s + x.stale, 0)).toBe(1); // yalnız çözülemeyen p4
    expect(await fieldKeyUsage(h.exec)).toEqual([
      { name: 'health.medical_summary.ciphertext', kid: 'k2', count: 3 },
      { name: 'profile.protected_person.door_access_note_enc', kid: 'k2', count: 3 },
      { name: 'profile.protected_person.door_access_note_enc', kid: 'k9', count: 1 },
      { name: 'device.vendor_link.vendor_account_enc', kid: 'k2', count: 1 },
    ]);
  });

  it('arada uygulama yazarsa satır ezilmez (atlanır), sonuçta düz metin yok', async () => {
    const fresh = rotated.encrypt(MED(7), `medical:${P(1)}`);
    let raced = false;
    const racing: SqlExecutor = {
      exec: (t) => h.exec.exec(t),
      query: async (text, params) => {
        if (!raced && text.startsWith('UPDATE health.medical_summary')) {
          raced = true;
          await h.pg.query('UPDATE health.medical_summary SET ciphertext = $1 WHERE protected_person_id = $2', [
            fresh,
            P(1),
          ]);
        }
        return h.exec.query(text, params);
      },
    };
    const rs = await reencryptFields(racing, rotated, { fields: [ENCRYPTED_FIELDS[0]!] });
    expect(rs[0]).toMatchObject({ stale: 2, updated: 1, skipped: 1 });
    const [row] = await h.rows<{ v: string }>(
      `SELECT ciphertext AS v FROM health.medical_summary WHERE protected_person_id = '${P(1)}'`,
    );
    expect(row!.v).toBe(fresh);
    const out = JSON.stringify(rs);
    for (const plain of ['gizli-tani', 'kapi-kodu', 'acct-42']) expect(out).not.toContain(plain);
  });
});
