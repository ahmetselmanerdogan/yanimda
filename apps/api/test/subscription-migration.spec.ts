import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { down, migrate } from '../src/db/migrate';
import { createHarness, type Harness } from './support/harness';

/**
 * İnceleme bulgusu 4 · 0021: 0009–0015'in her kişiye açtığı TRIAL aboneliği 0016 sonrası taramada PAST_DUE → askıya
 * düşürüyordu. Kayıt akışından gelmeyen (sağlayıcı ve KVKK rızası yok) eski abonelik: kurum kişisinde silinir, aile
 * kişisinde temiz 30 günlük denemeye alınır. Kayıt akışından gelen abonelik dokunulmaz.
 */
let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

const PERSON = {
  kurum: '01960000-0000-7000-8000-00000000000a',
  aile: '01960000-0000-7000-8000-00000000000b',
  kayit: '01960000-0000-7000-8000-00000000000c',
};
const SUB = {
  kurum: '01960000-0000-7000-8000-0000000000a1',
  aile: '01960000-0000-7000-8000-0000000000b1',
  kayit: '01960000-0000-7000-8000-0000000000c1',
};

describe('0021 eski abonelik düzeltmesi', () => {
  it('kurum kişisi abonelik dışı + ACTIVE; aile kişisi temiz deneme; kayıt aboneliği aynen', async () => {
    // 0021 ve sonrasını geri al (yeni göçler eklendikçe sayı değişir).
    const [{ n }] = await h.rows<{ n: number }>(
      "SELECT count(*)::int AS n FROM public.schema_migrations WHERE name >= '0021'",
    );
    await down(h.exec, n);
    const old = new Date(Date.now() - 90 * 86_400_000);
    for (const [k, id] of Object.entries(PERSON))
      await h.pg.query(
        `INSERT INTO profile.protected_person (id, display_name, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4)`,
        [id, k, k === 'kurum' ? 'PAST_DUE' : 'PAST_DUE', old],
      );
    for (const id of [PERSON.aile, PERSON.kayit])
      await h.pg.query(
        `INSERT INTO profile.family_member (id, protected_person_id, subject, role) VALUES (gen_random_uuid(), $1, $2, 'OWNER')`,
        [id, `fam-${id.slice(-1)}`],
      );
    const sub = (id: string, person: string, extra = '') =>
      h.pg.query(
        `INSERT INTO profile.subscription (id, protected_person_id, plan, status, started_at, trial_ends_at, past_due_since,
           grace_until, suspended_at ${extra ? ', provider, kvkk_notice_version' : ''})
         VALUES ($1, $2, 'STANDARD', 'PAST_DUE', $3, $3::timestamptz + interval '30 days',
           $3::timestamptz + interval '30 days', $3::timestamptz + interval '37 days', $3::timestamptz + interval '37 days'
           ${extra})`,
        [id, person, old],
      );
    await sub(SUB.kurum, PERSON.kurum);
    await sub(SUB.aile, PERSON.aile);
    await sub(SUB.kayit, PERSON.kayit, ", 'FAKE', 'v1'");

    await migrate(h.exec);

    const subs = await h.rows<{ id: string; status: string; trial_ends_at: Date | null; suspended_at: Date | null }>(
      'SELECT id, status, trial_ends_at, suspended_at FROM profile.subscription ORDER BY id',
    );
    expect(subs.map((s) => s.id)).toEqual([SUB.aile, SUB.kayit]);
    const aile = subs.find((s) => s.id === SUB.aile)!;
    expect(aile).toMatchObject({ status: 'TRIAL', suspended_at: null });
    expect(new Date(aile.trial_ends_at!).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(subs.find((s) => s.id === SUB.kayit)).toMatchObject({ status: 'PAST_DUE' });
    expect(subs.find((s) => s.id === SUB.kayit)!.suspended_at).not.toBeNull();

    const people = await h.rows<{ id: string; status: string }>(
      'SELECT id, status FROM profile.protected_person ORDER BY id',
    );
    expect(Object.fromEntries(people.map((p) => [p.id, p.status]))).toEqual({
      [PERSON.kurum]: 'ACTIVE',
      [PERSON.aile]: 'TRIAL',
      [PERSON.kayit]: 'PAST_DUE',
    });
  });
});
