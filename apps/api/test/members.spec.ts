import { randomBytes } from 'node:crypto';

import { HttpException } from '@nestjs/common';
import { catalogs } from '@yanimda/messages';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FieldCipher } from '../src/common/field-cipher';
import type { Actor } from '../src/modules/profile/contacts';
import { MAX_ACTIVE_MEMBER_INVITES, MAX_FAMILY_MEMBERS, MEMBER_INVITE_TTL_MS } from '../src/modules/profile/members';
import { ProfileService } from '../src/modules/profile/profile.service';
import { createHarness, type Harness } from './support/harness';

/**
 * T-040 aile üyesi (MEMBER) daveti (C-02, C-04). Kabul:
 *  - yalnız hesap sahibi (OWNER) davet kodu üretir; MEMBER 403, erişimi olmayan 404
 *  - kod 72 saat geçerli, tek kullanımlık; düz kod saklanmaz, audit'e yazılmaz
 *  - kabul: geçersiz/süresi dolmuş/kullanılmış → 400 + katalog kodu; zaten üye → 409; üye sınırı
 *  - liste: OWNER ve MEMBER görür; başka üyenin kimliği (subject) dönmez
 *  - çıkarma: yalnız OWNER (MEMBER yalnız kendini); son hesap sahibi çıkarılamaz
 */
const KEYS = `k1:${randomBytes(32).toString('base64')}`;
const ALICE: Actor = { kind: 'FAMILY', id: 'fam-alice' };
const BOB: Actor = { kind: 'FAMILY', id: 'fam-bob' };
const CAROL: Actor = { kind: 'FAMILY', id: 'fam-carol' };
const ADMIN: Actor = { kind: 'ADMIN', id: 'adm-1' };
const H72 = 72 * 3_600_000;

let h: Harness;
let profile: ProfileService;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  profile = new ProfileService(h.db, new FieldCipher(KEYS));
});
afterAll(async () => {
  await h.close();
});

/** HTTP durumu (+ varsa katalog kodu) — "400 F-MEMBER-CODE-USED" gibi. */
const outcome = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (!(e instanceof HttpException)) throw e;
    const body = e.getResponse() as { code?: string };
    return body && typeof body === 'object' && body.code ? `${e.getStatus()} ${body.code}` : e.getStatus();
  }
};
const person = () => profile.create(ALICE, { displayName: 'Ayşe Y.', relation: 'Kızı' });

describe('davet kodu (OWNER)', () => {
  it('10 karakter, 72 saat; yalnız özeti saklanır; audit kodsuz', async () => {
    const p = await person();
    const t0 = new Date();
    const inv = await profile.createMemberInvite(ALICE, p.id, { relation: 'Oğlu' }, t0);
    expect(inv.code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    expect(inv.code).not.toMatch(/[ILOU]/); // Crockford: karışan harf yok
    expect(new Date(inv.expiresAt).getTime() - t0.getTime()).toBe(MEMBER_INVITE_TTL_MS);
    expect(MEMBER_INVITE_TTL_MS).toBe(H72);
    const rows = await h.rows<Record<string, unknown>>('SELECT * FROM profile.member_invite');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ protected_person_id: p.id, created_by: 'fam-alice', relation: 'Oğlu' });
    const raw = JSON.stringify(rows);
    expect(raw).not.toContain(inv.code);
    expect(raw).not.toContain(inv.code.replace('-', ''));
    const audit = await h.rows<{ actor_id: string; data: unknown }>(
      "SELECT actor_id, data FROM audit.log WHERE entity_id = $1 AND action = 'profile.member_invite_created'",
      [p.id],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_id).toBe('fam-alice');
    expect(JSON.stringify(audit)).not.toContain(inv.code.replace('-', ''));
    expect(JSON.stringify(audit)).not.toContain('Oğlu');
  });

  it('erişimi olmayan 404; MEMBER 403; yönetici üretebilir', async () => {
    const p = await person();
    expect(await outcome(profile.createMemberInvite(BOB, p.id, {}))).toBe(404);
    expect(await outcome(profile.createMemberInvite(BOB, 'olmayan-id', {}))).toBe(404);
    const inv = await profile.createMemberInvite(ALICE, p.id, {});
    await profile.acceptMemberInvite(BOB, { code: inv.code });
    expect(await outcome(profile.createMemberInvite(BOB, p.id, {}))).toBe('403 F-MEMBER-OWNER-ONLY');
    expect(await outcome(profile.createMemberInvite(ADMIN, p.id, {}))).toBe('ok');
  });

  it(`açık davet en çok ${MAX_ACTIVE_MEMBER_INVITES}; süresi dolan sayılmaz`, async () => {
    const p = await person();
    const t0 = new Date();
    for (let i = 0; i < MAX_ACTIVE_MEMBER_INVITES; i++) await profile.createMemberInvite(ALICE, p.id, {}, t0);
    expect(await outcome(profile.createMemberInvite(ALICE, p.id, {}, t0))).toBe('409 F-MEMBER-INVITE-LIMIT');
    expect(await outcome(profile.createMemberInvite(ALICE, p.id, {}, new Date(t0.getTime() + H72 + 1000)))).toBe('ok');
  });

  it('relation 50 karakteri aşarsa 400', async () => {
    const p = await person();
    expect(await outcome(profile.createMemberInvite(ALICE, p.id, { relation: 'x'.repeat(51) }))).toBe(400);
  });
});

describe('daveti kabul (FAMILY)', () => {
  it('MEMBER olarak eklenir; ilişki davetten gelir; kişi listesinde MEMBER; güvenlik ayarı 403', async () => {
    const p = await person();
    const inv = await profile.createMemberInvite(ALICE, p.id, { relation: 'Oğlu' });
    const r = await profile.acceptMemberInvite(BOB, { code: inv.code.toLowerCase().replace('-', ' ') });
    expect(r).toMatchObject({ protectedPersonId: p.id, role: 'MEMBER' });
    const list = await profile.list(BOB);
    expect(list.items.map((x) => [x.id, x.myRole])).toEqual([[p.id, 'MEMBER']]);
    const [fm] = await h.rows<{ role: string; relation: string }>(
      'SELECT role, relation FROM profile.family_member WHERE subject = $1',
      ['fam-bob'],
    );
    expect(fm).toEqual({ role: 'MEMBER', relation: 'Oğlu' });
    expect(await outcome(profile.setContacts(BOB, p.id, []))).toBe(403);
    const [inv2] = await h.rows<{ used_at: Date | null; used_by: string }>(
      'SELECT used_at, used_by FROM profile.member_invite',
    );
    expect(inv2.used_at).not.toBeNull();
    expect(inv2.used_by).toBe('fam-bob');
    const audit = await h.rows<{ actor_id: string; data: Record<string, unknown> }>(
      "SELECT actor_id, data FROM audit.log WHERE entity_id = $1 AND action = 'profile.member_added'",
      [p.id],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_id: 'fam-bob', data: { memberId: r.memberId, role: 'MEMBER' } });
    expect(JSON.stringify(audit)).not.toContain('Oğlu');
  });

  it('geçersiz kod 400; biçimsiz gövde 400', async () => {
    await person();
    expect(await outcome(profile.acceptMemberInvite(BOB, { code: 'ABCDE-FGHJK' }))).toBe('400 F-MEMBER-CODE-INVALID');
    expect(await outcome(profile.acceptMemberInvite(BOB, { code: '12' }))).toBe('400 F-MEMBER-CODE-INVALID');
    expect(await outcome(profile.acceptMemberInvite(BOB, {}))).toBe('400 F-MEMBER-CODE-INVALID');
    expect(await outcome(profile.acceptMemberInvite(BOB, null))).toBe(400);
  });

  it('72 saat sonra süresi dolmuş (400); tekrar kullanılamaz (400); aynı kişi tekrar → 409', async () => {
    const p = await person();
    const t0 = new Date();
    const old = await profile.createMemberInvite(ALICE, p.id, {}, t0);
    expect(
      await outcome(profile.acceptMemberInvite(BOB, { code: old.code }, new Date(t0.getTime() + H72 + 1000))),
    ).toBe('400 F-MEMBER-CODE-EXPIRED');
    const inv = await profile.createMemberInvite(ALICE, p.id, {});
    expect(await outcome(profile.acceptMemberInvite(BOB, { code: inv.code }))).toBe('ok');
    expect(await outcome(profile.acceptMemberInvite(CAROL, { code: inv.code }))).toBe('400 F-MEMBER-CODE-USED');
    expect(await outcome(profile.acceptMemberInvite(BOB, { code: inv.code }))).toBe('409 F-MEMBER-ALREADY');
    const n = await h.rows('SELECT 1 FROM profile.family_member WHERE protected_person_id = $1', [p.id]);
    expect(n).toHaveLength(2);
  });

  it('zaten üye (sahip kendi kodunu) → 409 ve kod harcanmaz', async () => {
    const p = await person();
    const inv = await profile.createMemberInvite(ALICE, p.id, {});
    expect(await outcome(profile.acceptMemberInvite(ALICE, { code: inv.code }))).toBe('409 F-MEMBER-ALREADY');
    expect(await outcome(profile.acceptMemberInvite(BOB, { code: inv.code }))).toBe('ok');
  });

  it('yalnız aile hesabı kabul eder (yönetici 403)', async () => {
    const p = await person();
    const inv = await profile.createMemberInvite(ALICE, p.id, {});
    expect(await outcome(profile.acceptMemberInvite(ADMIN, { code: inv.code }))).toBe(403);
  });

  it(`aile üyesi en çok ${MAX_FAMILY_MEMBERS}: dolunca davet de kabul de 409`, async () => {
    const p = await person();
    const pending = await profile.createMemberInvite(ALICE, p.id, {});
    for (let i = 1; i < MAX_FAMILY_MEMBERS; i++)
      await h.pg.query(
        "INSERT INTO profile.family_member (id, protected_person_id, subject, role) VALUES (gen_random_uuid(), $1, $2, 'MEMBER')",
        [p.id, `fam-x${i}`],
      );
    expect(await outcome(profile.createMemberInvite(ALICE, p.id, {}))).toBe('409 F-MEMBER-LIMIT');
    expect(await outcome(profile.acceptMemberInvite(BOB, { code: pending.code }))).toBe('409 F-MEMBER-LIMIT');
  });
});

describe('üye listesi', () => {
  it('OWNER ve MEMBER görür; isMe; başka üyenin kimliği dönmez; erişimi olmayan 404', async () => {
    const p = await person();
    const inv = await profile.createMemberInvite(ALICE, p.id, { relation: 'Oğlu' });
    await profile.acceptMemberInvite(BOB, { code: inv.code });
    const owner = await profile.members(ALICE, p.id);
    expect(owner.items.map((m) => [m.role, m.relation, m.isMe])).toEqual([
      ['OWNER', 'Kızı', true],
      ['MEMBER', 'Oğlu', false],
    ]);
    const member = await profile.members(BOB, p.id);
    expect(member.items.map((m) => [m.role, m.isMe])).toEqual([
      ['OWNER', false],
      ['MEMBER', true],
    ]);
    expect(Object.keys(member.items[0]).sort()).toEqual(['createdAt', 'id', 'isMe', 'relation', 'role']);
    expect(JSON.stringify(member)).not.toContain('fam-alice');
    expect(await outcome(profile.members(CAROL, p.id))).toBe(404);
    expect((await profile.members(ADMIN, p.id)).items).toHaveLength(2);
  });
});

describe('üye çıkarma', () => {
  const setup = async () => {
    const p = await person();
    const a = await profile.createMemberInvite(ALICE, p.id, {});
    const b = await profile.createMemberInvite(ALICE, p.id, {});
    const bob = await profile.acceptMemberInvite(BOB, { code: a.code });
    const carol = await profile.acceptMemberInvite(CAROL, { code: b.code });
    const ownerId = (await profile.members(ALICE, p.id)).items.find((m) => m.role === 'OWNER')!.id;
    return { p, bob: bob.memberId, carol: carol.memberId, ownerId };
  };

  it('OWNER üyeyi çıkarır: kişiye erişimi biter; audit yalnız kimlik', async () => {
    const { p, bob } = await setup();
    expect(await outcome(profile.removeMember(ALICE, p.id, bob))).toBe('ok');
    expect(await outcome(profile.get(BOB, p.id))).toBe(404);
    const audit = await h.rows<{ data: Record<string, unknown> }>(
      "SELECT data FROM audit.log WHERE entity_id = $1 AND action = 'profile.member_removed'",
      [p.id],
    );
    expect(audit.map((a) => a.data)).toEqual([{ memberId: bob, role: 'MEMBER', self: false }]);
  });

  it('MEMBER başka üyeyi çıkaramaz (403), kendini çıkarabilir', async () => {
    const { p, bob, carol, ownerId } = await setup();
    expect(await outcome(profile.removeMember(BOB, p.id, carol))).toBe('403 F-MEMBER-OWNER-ONLY');
    expect(await outcome(profile.removeMember(BOB, p.id, ownerId))).toBe('403 F-MEMBER-OWNER-ONLY');
    expect(await outcome(profile.removeMember(BOB, p.id, bob))).toBe('ok');
    expect(await outcome(profile.members(BOB, p.id))).toBe(404);
    expect((await profile.members(ALICE, p.id)).items).toHaveLength(2);
    const [a] = await h.rows<{ data: Record<string, unknown> }>(
      "SELECT data FROM audit.log WHERE entity_id = $1 AND action = 'profile.member_removed'",
      [p.id],
    );
    expect(a.data).toMatchObject({ memberId: bob, self: true });
  });

  it('son hesap sahibi çıkarılamaz (sahip kendisi de, yönetici de: 409)', async () => {
    const { p, ownerId } = await setup();
    expect(await outcome(profile.removeMember(ALICE, p.id, ownerId))).toBe('409 F-MEMBER-LAST-OWNER');
    expect(await outcome(profile.removeMember(ADMIN, p.id, ownerId))).toBe('409 F-MEMBER-LAST-OWNER');
    // İkinci sahip varsa biri ayrılabilir.
    await h.pg.query(
      "INSERT INTO profile.family_member (id, protected_person_id, subject, role) VALUES (gen_random_uuid(), $1, 'fam-dave', 'OWNER')",
      [p.id],
    );
    expect(await outcome(profile.removeMember(ALICE, p.id, ownerId))).toBe('ok');
  });

  it('erişimi olmayan 404; başka kişinin üyesi veya bilinmeyen kimlik 404', async () => {
    const { p, bob } = await setup();
    expect(await outcome(profile.removeMember({ kind: 'FAMILY', id: 'fam-x' }, p.id, bob))).toBe(404);
    const other = await profile.create(CAROL, { displayName: 'Başka' });
    expect(await outcome(profile.removeMember(CAROL, other.id, bob))).toBe(404);
    expect(await outcome(profile.removeMember(ALICE, p.id, '01960000-0000-7000-8000-000000000099'))).toBe(404);
    expect(await outcome(profile.removeMember(ALICE, p.id, 'bozuk'))).toBe(404);
  });
});

describe('katalog', () => {
  it('hata kodları katalogda', () => {
    for (const c of [
      'F-MEMBER-CODE-INVALID',
      'F-MEMBER-CODE-EXPIRED',
      'F-MEMBER-CODE-USED',
      'F-MEMBER-ALREADY',
      'F-MEMBER-LIMIT',
      'F-MEMBER-INVITE-LIMIT',
      'F-MEMBER-LAST-OWNER',
      'F-MEMBER-OWNER-ONLY',
    ])
      expect(catalogs.tr[c], c).toBeTruthy();
  });
});
