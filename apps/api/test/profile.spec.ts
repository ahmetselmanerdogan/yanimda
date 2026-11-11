import { randomBytes } from 'node:crypto';

import type { ExecutionContext } from '@nestjs/common';
import type { KafkaEnvelope, Signal } from '@yanimda/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '../src/common/bus';
import { FieldCipher } from '../src/common/field-cipher';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { ChainService } from '../src/modules/chain/chain.service';
import { loadProcedures } from '../src/modules/chain/procedures';
import { EnrollmentService } from '../src/modules/device/enrollment.service';
import { ProtectionService } from '../src/modules/event/protection.service';
import { loadRulePack, staticRules } from '../src/modules/event/rules.loader';
import { oidcConfigFromEnv, OidcVerifier } from '../src/modules/identity/oidc-verifier';
import type { Actor } from '../src/modules/profile/contacts';
import type { Geocoder } from '../src/modules/profile/geocoder';
import { ProfileGuard } from '../src/modules/profile/profile.controller';
import { ProfileService } from '../src/modules/profile/profile.service';
import { type FakeOidc, startFakeOidc } from './support/fake-oidc';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * T-040 profil (C-02, C-03, C-04). Kabul:
 *  - şifreli alanlar (kapı notu, tıbbi özet) DB'de düz metin değil
 *  - başka ailenin kişisi 404
 *  - davet kodu 15 dk sonra geçersiz
 * Ek: tıbbi özet rıza zamanı olmadan reddedilir, aileye geri okunmaz, yalnız olayı yürüten operatöre çözülür (audit).
 */
const key = () => randomBytes(32).toString('base64');
const KEYS = `k1:${key()}`;
const ALICE: Actor = { kind: 'FAMILY', id: 'fam-alice' };
const BOB: Actor = { kind: 'FAMILY', id: 'fam-bob' };
const ADMIN: Actor = { kind: 'ADMIN' };
const SECRET = 'test-device-secret-0123456789abcdef';

let h: Harness;
let profile: ProfileService;
let enrollment: EnrollmentService;
let geocoded: string[];
let geocoder: Geocoder;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  geocoded = [];
  geocoder = {
    geocode: async (address) => {
      geocoded.push(address);
      return { lat: 41.04, lng: 29.0 };
    },
  };
  enrollment = new EnrollmentService(
    h.db,
    h.redis as never,
    new ProtectionService(h.db, h.outbox),
    staticRules(loadRulePack()),
    SECRET,
  );
  profile = new ProfileService(h.db, new FieldCipher(KEYS), enrollment, geocoder);
});
afterAll(async () => {
  await h.close();
});

const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as { status?: number; message?: string }).status ?? (e as Error).message;
  }
};
const DOOR = 'Anahtar paspasın altında, kod 4512';
const MED = {
  consentAt: new Date(Date.now() - 60_000).toISOString(),
  conditions: ['Hipertansiyon', 'Tip 2 diyabet'],
  medications: ['Metformin 1000 mg'],
  allergies: ['Penisilin'],
  bloodType: 'A+',
  notes: 'Kalp pili var',
};
const create = (actor: Actor = ALICE, extra: Record<string, unknown> = {}) =>
  profile.create(actor, {
    displayName: 'Ayşe Y.',
    birthYear: 1945,
    relation: 'Kızı',
    address: { line: 'Bağdat Cd. No:1 D:3', district: 'Kadıköy', city: 'İstanbul' },
    doorAccessNote: DOOR,
    ...extra,
  });

describe('FieldCipher (AES-256-GCM)', () => {
  it('çözülür; bağlam (kişi/alan) değişirse çözülmez; her şifreleme farklı', () => {
    const c = new FieldCipher(KEYS);
    const a = c.encrypt('gizli', 'door:1');
    expect(a).toMatch(/^v1:k1:/);
    expect(a).not.toContain('gizli');
    expect(c.decrypt(a, 'door:1')).toBe('gizli');
    expect(c.encrypt('gizli', 'door:1')).not.toBe(a);
    expect(() => c.decrypt(a, 'door:2')).toThrow();
    const tampered = a.slice(0, -4) + (a.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => c.decrypt(tampered, 'door:1')).toThrow();
  });
  it('anahtar döndürme: yeni anahtar yazar, eski okunur; bilinmeyen anahtar reddedilir', () => {
    const old = new FieldCipher(KEYS);
    const v = old.encrypt('x', 'c');
    const rotated = new FieldCipher(`k2:${key()},${KEYS}`);
    expect(rotated.decrypt(v, 'c')).toBe('x');
    expect(rotated.isStale(v)).toBe(true);
    expect(rotated.encrypt('x', 'c')).toMatch(/^v1:k2:/);
    expect(() => new FieldCipher(`k9:${key()}`).decrypt(v, 'c')).toThrow();
  });
  it('biçim hatası reddedilir; üretimde anahtar zorunlu', () => {
    expect(() => new FieldCipher('k1:kisa')).toThrow();
    expect(() => new FieldCipher('')).toThrow();
    expect(() => FieldCipher.fromEnv({ NODE_ENV: 'production' })).toThrow(/zorunlu/);
    expect(FieldCipher.fromEnv({ NODE_ENV: 'test' })).toBeInstanceOf(FieldCipher);
  });
});

describe('kişi (C-02)', () => {
  it('aile oluşturur: sahibi olur, deneme aboneliği açılır, adres konumlanır, kapı notu şifreli', async () => {
    const p = await create();
    expect(p).toMatchObject({
      displayName: 'Ayşe Y.',
      birthYear: 1945,
      myRole: 'OWNER',
      doorAccessNote: DOOR,
      address: { line: 'Bağdat Cd. No:1 D:3', district: 'Kadıköy', city: 'İstanbul', lat: 41.04, lng: 29.0 },
      medical: { present: false },
    });
    expect(geocoded).toEqual(['Bağdat Cd. No:1 D:3, Kadıköy, İstanbul']);
    const [row] = await h.rows<{ door_access_note_enc: string }>(
      'SELECT door_access_note_enc FROM profile.protected_person WHERE id = $1',
      [p.id],
    );
    expect(row.door_access_note_enc).toMatch(/^v1:/);
    expect(row.door_access_note_enc).not.toContain('paspas');
    expect(
      await h.rows('SELECT role, subject FROM profile.family_member WHERE protected_person_id = $1', [p.id]),
    ).toEqual([{ role: 'OWNER', subject: 'fam-alice' }]);
    expect(
      await h.rows('SELECT plan, status FROM profile.subscription WHERE protected_person_id = $1', [p.id]),
    ).toEqual([{ plan: 'STANDARD', status: 'TRIAL' }]);
  });

  it('yönetici/kurum eklediği kişiye abonelik açılmaz; durum ACTIVE (inceleme bulgusu 4)', async () => {
    const p = await create(ADMIN);
    expect(await h.rows('SELECT 1 FROM profile.subscription WHERE protected_person_id = $1', [p.id])).toEqual([]);
    expect(await h.rows('SELECT status FROM profile.protected_person WHERE id = $1', [p.id])).toEqual([
      { status: 'ACTIVE' },
    ]);
  });

  it('başka ailenin kişisi 404 (okuma, güncelleme, tıbbi, rehber, davet); liste yalnız kendi kişileri', async () => {
    const a = await create(ALICE);
    await create(BOB, { displayName: 'Mehmet B.' });
    for (const p of [
      profile.get(BOB, a.id),
      profile.update(BOB, a.id, { displayName: 'x' }),
      profile.setMedical(BOB, a.id, MED),
      profile.deleteMedical(BOB, a.id),
      profile.setContacts(BOB, a.id, []),
      profile.contacts(BOB, a.id),
      profile.invite(BOB, a.id),
    ])
      expect(await status(p)).toBe(404);
    expect(await status(profile.get(ALICE, '00000000-0000-0000-0000-000000000000'))).toBe(404);
    expect(await status(profile.get(ALICE, 'pp_demo'))).toBe(404);
    expect((await profile.list(ALICE)).items.map((x) => x.displayName)).toEqual(['Ayşe Y.']);
    expect((await profile.list(ADMIN)).total).toBe(2);
    expect((await profile.get(ADMIN, a.id)).myRole).toBeNull();
  });

  it('güncelleme: adres değişince yeniden konumlanır; harita iğnesi verilirse geocoder çağrılmaz; not silinir', async () => {
    const p = await create();
    geocoded = [];
    const u = await profile.update(ALICE, p.id, {
      address: { line: 'Moda Cd. 5', city: 'İstanbul', lat: 40.98, lng: 29.03 },
      doorAccessNote: null,
    });
    expect(geocoded).toEqual([]);
    expect(u.address).toMatchObject({ line: 'Moda Cd. 5', district: null, lat: 40.98, lng: 29.03 });
    expect(u.doorAccessNote).toBeNull();
    const u2 = await profile.update(ALICE, p.id, { timezone: 'Europe/Berlin', birthYear: 1950 });
    expect(u2).toMatchObject({ timezone: 'Europe/Berlin', birthYear: 1950 });
  });

  it('geocoder hatası kaydı engellemez (konum boş kalır)', async () => {
    profile = new ProfileService(h.db, new FieldCipher(KEYS), enrollment, {
      geocode: async () => {
        throw new Error('ağ');
      },
    });
    const p = await create();
    expect(p.address).toMatchObject({ lat: null, lng: null });
  });

  it.each([
    [{ displayName: '' }],
    [{ displayName: 'x'.repeat(101) }],
    [{ displayName: 'A', birthYear: 1800 }],
    [{ displayName: 'A', timezone: 'Mars/Olympus' }],
    [{ displayName: 'A', language: 'xx' }],
    [{ displayName: 'A', address: { line: 'x' } }],
    [{ displayName: 'A', address: { line: 'x', city: 'y', lat: 100, lng: 0 } }],
    [{ displayName: 'A', doorAccessNote: 'x'.repeat(501) }],
  ])('geçersiz giriş 400: %j', async (body) => {
    expect(await status(profile.create(ALICE, body))).toBe(400);
  });
});

describe('tıbbi özet (C-03)', () => {
  it('rıza zamanı zorunlu; şifreli saklanır; aileye içerik geri okunmaz; audit içeriksiz', async () => {
    const p = await create();
    expect(await status(profile.setMedical(ALICE, p.id, { ...MED, consentAt: undefined }))).toBe(400);
    expect(await status(profile.setMedical(ALICE, p.id, { ...MED, consentAt: 'dün' }))).toBe(400);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect(await status(profile.setMedical(ALICE, p.id, { ...MED, consentAt: future }))).toBe(400);
    expect(await status(profile.setMedical(ALICE, p.id, { ...MED, bloodType: 'C+' }))).toBe(400);

    const r = await profile.setMedical(ALICE, p.id, MED);
    expect(r).toMatchObject({ present: true, consentAt: MED.consentAt });
    const [row] = await h.rows<{ ciphertext: string; consent_by: string }>(
      'SELECT ciphertext, consent_by FROM health.medical_summary WHERE protected_person_id = $1',
      [p.id],
    );
    expect(row.ciphertext).toMatch(/^v1:/);
    for (const plain of ['Hipertansiyon', 'Metformin', 'Penisilin', 'Kalp pili'])
      expect(row.ciphertext).not.toContain(plain);
    expect(row.consent_by).toBe('fam-alice');
    const view = await profile.get(ALICE, p.id);
    expect(view.medical).toMatchObject({ present: true, consentAt: MED.consentAt });
    expect(JSON.stringify(view)).not.toContain('Penisilin');
    const audit = await h.rows<{ data: unknown }>(
      "SELECT data FROM audit.log WHERE entity_id = $1 AND action = 'health.medical_set'",
      [p.id],
    );
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toMatch(/Hipertansiyon|Metformin|Penisilin|Kalp/);
  });

  it('rıza geri alınınca silinir', async () => {
    const p = await create();
    await profile.setMedical(ALICE, p.id, MED);
    await profile.deleteMedical(ALICE, p.id);
    expect((await profile.get(ALICE, p.id)).medical.present).toBe(false);
  });
});

describe('rehber (C-03, zincir numaraları)', () => {
  it('CONTACT sıralı 1–5 (sıra verilmezse liste sırası); tam numara geri verilmez; audit numarasız', async () => {
    const p = await create();
    await profile.setContacts(ALICE, p.id, [
      { role: 'CONTACT', displayName: 'Kızı', phone: '+905550000021' },
      { role: 'CONTACT', displayName: 'Oğlu', phone: '+905550000022' },
      { role: 'ELDER', phone: '+905550000011' },
      { role: 'NEIGHBOR', displayName: 'Komşu', phone: '+905550000039' },
    ]);
    const list = await profile.contacts(ALICE, p.id);
    expect(list.map((c) => [c.role, c.priority, c.displayName, c.phoneLast2])).toEqual([
      ['ELDER', 1, null, '11'],
      ['CONTACT', 1, 'Kızı', '21'],
      ['CONTACT', 2, 'Oğlu', '22'],
      ['NEIGHBOR', 1, 'Komşu', '39'],
    ]);
    expect(JSON.stringify(list)).not.toContain('+90555');
    const audit = await h.rows("SELECT data FROM audit.log WHERE entity_id = $1 AND action = 'profile.contacts_set'", [
      p.id,
    ]);
    expect(JSON.stringify(audit)).not.toContain('+90555');
  });

  it('aranacak kişileri yalnız sahip (veya yönetici) değiştirir; MEMBER 403 (bulgu 10)', async () => {
    const p = await create();
    await h.pg.query(
      "INSERT INTO profile.family_member (id, protected_person_id, subject, role) VALUES (gen_random_uuid(), $1, 'fam-member', 'MEMBER')",
      [p.id],
    );
    const body = [{ role: 'CONTACT', priority: 1, phone: '+905550000001', name: 'Ali' }];
    expect(await status(profile.setContacts({ kind: 'FAMILY', id: 'fam-member' }, p.id, body))).toBe(403);
    expect(await status(profile.contacts({ kind: 'FAMILY', id: 'fam-member' }, p.id))).toBe('ok');
    expect(await status(profile.setContacts(ALICE, p.id, body))).toBe('ok');
  });

  it("112'ye okunan kişi bilgisi ve tıbbi özet yalnız sahip (veya yönetici) değiştirir; MEMBER 403 katalog kodlu", async () => {
    const p = await create();
    await profile.setMedical(ALICE, p.id, MED);
    await h.pg.query(
      "INSERT INTO profile.family_member (id, protected_person_id, subject, role) VALUES (gen_random_uuid(), $1, 'fam-member', 'MEMBER')",
      [p.id],
    );
    const member: Actor = { kind: 'FAMILY', id: 'fam-member' };
    const forbidden = async (pr: Promise<unknown>) =>
      pr.then(
        () => 'ok',
        (e: { status?: number; response?: { code?: string } }) => `${e.status} ${e.response?.code ?? ''}`.trim(),
      );
    const attempts = [
      () => profile.update(member, p.id, { displayName: 'Başka Ad' }),
      () => profile.update(member, p.id, { address: { line: 'Sahte Sk. 1', city: 'İzmir' } }),
      () => profile.update(member, p.id, { doorAccessNote: 'anahtar paspasın altında' }),
      () => profile.update(member, p.id, { locationSharing: false }),
      () => profile.setMedical(member, p.id, { ...MED, allergies: [] }),
      () => profile.deleteMedical(member, p.id),
      () => profile.setContacts(member, p.id, []),
    ];
    for (const a of attempts) expect(await forbidden(a())).toBe('403 F-MEMBER-OWNER-ONLY');
    // Hiçbir şey değişmedi; MEMBER okumaya devam eder.
    const v = await profile.get(member, p.id);
    expect(v).toMatchObject({ displayName: p.displayName, myRole: 'MEMBER', medical: { present: true } });
    expect(v.doorAccessNote).toBe(p.doorAccessNote);
    // Sahip ve yönetici değiştirebilir.
    expect((await profile.update(ALICE, p.id, { displayName: 'Yeni Ad' })).displayName).toBe('Yeni Ad');
    expect((await profile.update(ADMIN, p.id, { birthYear: 1950 })).birthYear).toBe(1950);
    await profile.deleteMedical(ADMIN, p.id);
    expect(await forbidden(profile.setMedical(ALICE, p.id, MED))).toBe('ok');
    // Erişimi olmayan aile hesabı 404 (kişinin varlığı sızmaz).
    expect(await status(profile.update(BOB, p.id, { displayName: 'x' }))).toBe(404);
  });

  it.each([
    ['6 yakın', Array.from({ length: 6 }, (_, i) => ({ role: 'CONTACT', phone: `+90555000003${i}` }))],
    [
      'iki komşu',
      [
        { role: 'NEIGHBOR', phone: '+905550000001' },
        { role: 'NEIGHBOR', phone: '+905550000002' },
      ],
    ],
    [
      'aynı öncelik',
      [
        { role: 'CONTACT', priority: 1, phone: '+905550000001' },
        { role: 'CONTACT', priority: 1, phone: '+905550000002' },
      ],
    ],
    ['öncelik 6', [{ role: 'CONTACT', priority: 6, phone: '+905550000001' }]],
    ['E.164 değil', [{ role: 'CONTACT', phone: '05550000001' }]],
    ['rol yok', [{ role: 'BOSS', phone: '+905550000001' }]],
    ['liste değil', { role: 'CONTACT' }],
  ])('400: %s', async (_name, body) => {
    const p = await create();
    expect(await status(profile.setContacts(ALICE, p.id, body))).toBe(400);
  });

  it('yönetici simülatör kişisine (uuid değil) yazabilir', async () => {
    expect(await profile.setContacts(ADMIN, 'pp_demo', [{ role: 'WATCH', phone: '+905550000005' }])).toEqual({
      count: 1,
    });
  });
});

describe('davet (C-02)', () => {
  it('6 haneli kod, SMS metni katalogdan, 15 dk sonra geçersiz', async () => {
    const p = await create();
    const t0 = new Date();
    const inv = await profile.invite(ALICE, p.id, t0);
    expect(inv.code).toMatch(/^\d{6}$/);
    expect(new Date(inv.expiresAt).getTime() - t0.getTime()).toBe(15 * 60_000);
    expect(inv.smsText).toContain(inv.code);
    expect(inv.smsText).toMatch(/^Yanımda davet kodunuz/);
    const body = { inviteCode: inv.code, deviceId: '0190a000-0000-7000-8000-000000000001', kind: 'IOS_PHONE' };
    const late = new Date(t0.getTime() + 15 * 60_000 + 1000);
    expect(await status(enrollment.enroll(body, 'ip-1', late))).toBe(400);
    const audit = await h.rows(
      "SELECT data FROM audit.log WHERE entity_id = $1 AND action = 'profile.invite_created'",
      [p.id],
    );
    expect(JSON.stringify(audit)).not.toContain(inv.code);
  });
});

describe('olay anında kişi kartı (E-03, E-06)', () => {
  let chain: ChainService;
  beforeEach(() => {
    chain = new ChainService(h.db, h.events(new InMemoryTimers()), loadProcedures(), undefined, profile);
  });
  async function claimed(person: string, kind = 'SOS') {
    await bus.deliver<Signal>('signal.received', {
      payload: sig(kind, { protectedPersonId: person, location: { lat: 41.01, lng: 29.02, accuracyM: 10 } }),
    } as unknown as KafkaEnvelope<Signal>);
    const [{ id }] = await h.rows<{ id: string }>('SELECT id FROM event.event WHERE protected_person_id = $1', [
      person,
    ]);
    await chain.claim(id, 'op-1');
    return id;
  }

  it('yalnız olayı yürüten operatöre çözülür; her çözüm audit’e (içeriksiz)', async () => {
    const p = await create();
    await profile.setMedical(ALICE, p.id, MED);
    const id = await claimed(p.id);
    expect(await status(chain.personCard(id, 'op-2'))).toBe(409);
    const card = await chain.personCard(id, 'op-1');
    expect(card).toMatchObject({
      displayName: 'Ayşe Y.',
      age: new Date().getUTCFullYear() - 1945,
      address: 'Bağdat Cd. No:1 D:3, Kadıköy, İstanbul',
      doorAccessNote: DOOR,
      medical: { conditions: MED.conditions, medications: MED.medications, allergies: MED.allergies, bloodType: 'A+' },
    });
    const audit = await h.rows<{ actor_id: string; data: unknown }>(
      "SELECT actor_id, data FROM audit.log WHERE entity_id = $1 AND action = 'health.medical_viewed'",
      [id],
    );
    expect(audit).toEqual([{ actor_id: 'op-1', data: { purpose: 'event_card', medical: true, doorNote: true } }]);
  });

  it('112 şablonu tıbbi alanlar, adres ve kapı notuyla dolar', async () => {
    const p = await create();
    await profile.setMedical(ALICE, p.id, MED);
    const id = await claimed(p.id);
    const s = await chain.dispatchScript(id, 'op-1', 'dispatch112');
    expect(s.fields).toMatchObject({
      name: 'Ayşe Y.',
      address: 'Bağdat Cd. No:1 D:3, Kadıköy, İstanbul (41.01000, 29.02000)',
      conditions: 'Hipertansiyon, Tip 2 diyabet',
      medications: 'Metformin 1000 mg',
      allergies: 'Penisilin',
      doorNote: DOOR,
    });
    expect(s.text).toContain('Alerjiler: Penisilin');
  });

  it('profil yoksa (simülatör kimliği) kart null, şablon "bilinmiyor"', async () => {
    const id = await claimed('pp_sim_1');
    expect(await chain.personCard(id, 'op-1')).toBeNull();
    expect((await chain.dispatchScript(id, 'op-1', 'dispatch112')).fields.conditions).toBe('bilinmiyor');
  });

  it('anahtar değişmişse operatör "kayıtlı değil" görür, olay akışı durmaz', async () => {
    const p = await create();
    await profile.setMedical(ALICE, p.id, MED);
    profile = new ProfileService(h.db, new FieldCipher(`k1:${key()}`), enrollment, geocoder);
    chain = new ChainService(h.db, h.events(new InMemoryTimers()), loadProcedures(), undefined, profile);
    const id = await claimed(p.id);
    expect(await chain.personCard(id, 'op-1')).toMatchObject({ medical: null, doorAccessNote: null });
  });
});

describe('ProfileGuard', () => {
  let idp: FakeOidc;
  let verifier: OidcVerifier;
  const prev = process.env.ADMIN_TOKEN;
  beforeAll(async () => {
    idp = await startFakeOidc();
    verifier = new OidcVerifier(oidcConfigFromEnv({ ...idp.env, NODE_ENV: 'test' }));
  });
  afterAll(async () => {
    await idp.close();
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = prev;
  });
  const run = async (headers: Record<string, string>) => {
    const req: { headers: Record<string, string>; actor?: Actor } = { headers };
    const c = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
    const r = await status(new ProfileGuard(verifier).canActivate(c));
    return r === 'ok' ? req.actor : r;
  };
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

  it('aile (consumers FAMILY) → kendi kimliğiyle; yönetici → ADMIN; operatör → 403; giriş yok → 401', async () => {
    process.env.ADMIN_TOKEN = 'dogru-token-123';
    expect(await run(bearer(idp.token({ realm: 'consumers', sub: 'fam-1', roles: ['FAMILY'] })))).toEqual({
      kind: 'FAMILY',
      id: 'fam-1',
    });
    expect(await run(bearer(idp.token({ sub: 'adm-1', roles: ['ADMIN'] })))).toEqual({ kind: 'ADMIN', id: 'adm-1' });
    expect(await run(bearer(idp.token({ roles: ['OPERATOR'] })))).toBe(403);
    expect(await run(bearer(idp.token({ realm: 'consumers', roles: ['ELDER'] })))).toBe(403);
    expect(await run({})).toBe(401);
    expect(await run({ 'x-admin-token': 'yanlis-token-12' })).toBe(403);
    expect(await run({ 'x-admin-token': 'dogru-token-123' })).toEqual({ kind: 'ADMIN' });
    expect(await run(bearer('bozuk'))).toBe(401);
  });
});
