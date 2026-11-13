import { randomBytes } from 'node:crypto';

import type { DataExport } from '@yanimda/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FieldCipher } from '../src/common/field-cipher';
import { DataExportController } from '../src/modules/privacy/data-export.controller';
import { DataExportService } from '../src/modules/privacy/data-export.service';
import type { Actor } from '../src/modules/profile/contacts';
import { ProfileService } from '../src/modules/profile/profile.service';
import { createHarness, type Harness } from './support/harness';
import { scanPii } from './support/pii-scan';

/**
 * T-081 ASVS 8.3.2 / KVKK m.11 erişim hakkı: aile hesabı kendi verisini ve üyesi olduğu korunan kişilerin verisini
 * JSON olarak indirir. Kabul:
 *  - yalnız hesabın üye olduğu kişiler (başka ailenin kişisi yok); MEMBER de kendi erişimi kadarını alır
 *  - mevcut aile uçlarının gösterdiğinden fazlası yok: tıbbi özet içeriği, tam rehber numarası, push token'ı,
 *    cihaz numarası, olay konumu / operatör notu dışa aktarılmaz (CLAUDE.md: sağlık verisi yalnız olay anında çözülür)
 *  - yönetici (ADMIN) çağıramaz (403); hesabın kişisi yoksa boş liste
 *  - her indirme audit.log'a yazılır: yalnız kimlikler ve sayılar (PII yok)
 */
const KEYS = `k1:${randomBytes(32).toString('base64')}`;
const ALICE: Actor = { kind: 'FAMILY', id: 'fam-alice' };
const BOB: Actor = { kind: 'FAMILY', id: 'fam-bob' };
const CAROL: Actor = { kind: 'FAMILY', id: 'fam-carol' };
const ADMIN: Actor = { kind: 'ADMIN', id: 'adm-1' };
const DOOR = 'Anahtar paspasın altında, kod 4512';
const PHONE = '+905559876543';
const MED = {
  consentAt: new Date(Date.now() - 60_000).toISOString(),
  conditions: ['Hipertansiyon'],
  medications: ['Metformin 1000 mg'],
  allergies: ['Penisilin'],
  bloodType: 'A+',
  notes: 'Kalp pili var',
};

let h: Harness;
let profile: ProfileService;
let svc: DataExportService;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  await h.exec.exec('TRUNCATE device.vendor_link');
  profile = new ProfileService(h.db, new FieldCipher(KEYS));
  svc = new DataExportService(h.db, profile);
});
afterAll(async () => {
  await h.close();
});

async function seedAlice() {
  const p = await profile.create(ALICE, {
    displayName: 'Ayşe Y.',
    birthYear: 1945,
    relation: 'Kızı',
    address: { line: 'Bağdat Cd. No:1 D:3', district: 'Kadıköy', city: 'İstanbul', lat: 40.98731, lng: 29.02912 },
    doorAccessNote: DOOR,
  });
  await profile.setMedical(ALICE, p.id, MED);
  await profile.setContacts(ALICE, p.id, [{ role: 'CONTACT', displayName: 'Mehmet', phone: PHONE }]);
  await h.rows(
    `INSERT INTO device.device (id, protected_person_id, kind, push_token, voice_number, enrolled_at)
     VALUES ('0190c1d2-0000-7000-8000-00000000d001', $1, 'WEAR_OS', 'push-token-secret-abcdefghijklmnop', '+905550000005', now())`,
    [p.id],
  );
  await h.rows(
    `INSERT INTO event.event (id, protected_person_id, type, priority, state, location, close_reason, closed_at,
       operator_id, confirmed_outcome)
     VALUES ('0190c1d2-0000-7000-8000-00000000e001', $1, 'FALL', 1, 'CLOSED', '{"lat": 40.98731, "lng": 29.02912}',
       'Kızı Mehmet aradı, kapı kodu 4512', now(), 'op-sub-1', 'FALSE_ALARM')`,
    [p.id],
  );
  await h.rows(
    `INSERT INTO signal.daily_summary (protected_person_id, day, steps, hr_avg) VALUES ($1, '2026-11-10', 3200, 71)`,
    [p.id],
  );
  await h.rows(
    `INSERT INTO notify.push_target (id, subject, platform, token) VALUES ('0190c1d2-0000-7000-8000-00000000f001', $1, 'FCM', 'fcm-token-secret-0123456789')`,
    [ALICE.id],
  );
  await h.rows(
    `INSERT INTO notify.notification (id, dedupe_key, code, audience, urgency, protected_person_id, event_id, channel,
       recipient_kind, recipient_id, vars, status)
     VALUES (gen_random_uuid(), 'd1', 'F-EVENT-CLOSED', 'FAMILY', 'URGENT', $1, '0190c1d2-0000-7000-8000-00000000e001',
       'PUSH', 'PUSH_TARGET', '0190c1d2-0000-7000-8000-00000000f001', '{"name": "Ayşe Y."}', 'delivered'),
            (gen_random_uuid(), 'd2', 'F-DAILY', 'FAMILY', 'INFO', $1, NULL, 'PUSH', 'PUSH_TARGET', 'someone-else', NULL, 'sent')`,
    [p.id],
  );
  await h.rows(
    `INSERT INTO event.family_feedback (event_id, subject, real) VALUES ('0190c1d2-0000-7000-8000-00000000e001', $1, false)`,
    [ALICE.id],
  );
  return p;
}

describe('kişisel veri dışa aktarma (8.3.2)', () => {
  it('OWNER: profil, rehber, cihaz, olay, özet, abonelik, rızalar ve hesap verisi', async () => {
    const p = await seedAlice();
    const x: DataExport = await svc.export(ALICE);
    expect(x.format).toBe('yanimda.data-export.v1');
    expect(x.account.subject).toBe(ALICE.id);
    expect(x.account.memberships).toEqual([
      { protectedPersonId: p.id, role: 'OWNER', relation: 'Kızı', since: expect.any(String) },
    ]);
    expect(x.account.pushTargets).toEqual([{ platform: 'FCM', updatedAt: expect.any(String) }]);
    expect(x.account.feedback).toEqual([
      { eventId: '0190c1d2-0000-7000-8000-00000000e001', real: false, at: expect.any(String) },
    ]);
    expect(x.account.notifications).toEqual([
      expect.objectContaining({
        code: 'F-EVENT-CLOSED',
        channel: 'PUSH',
        status: 'delivered',
        protectedPersonId: p.id,
      }),
    ]);
    expect(x.persons).toHaveLength(1);
    const [person] = x.persons;
    expect(person!.profile).toMatchObject({ id: p.id, displayName: 'Ayşe Y.', doorAccessNote: DOOR, myRole: 'OWNER' });
    expect(person!.profile.medical).toMatchObject({ present: true, consentAt: MED.consentAt });
    expect(person!.contacts).toEqual([expect.objectContaining({ displayName: 'Mehmet', phoneLast2: '43' })]);
    expect(person!.devices).toEqual([
      expect.objectContaining({ id: '0190c1d2-0000-7000-8000-00000000d001', kind: 'WEAR_OS' }),
    ]);
    expect(person!.events).toEqual([
      expect.objectContaining({ id: '0190c1d2-0000-7000-8000-00000000e001', type: 'FALL', outcome: 'FALSE_ALARM' }),
    ]);
    expect(person!.dailySummaries).toEqual([
      { day: '2026-11-10', steps: 3200, hrMin: null, hrAvg: 71, hrMax: null, wristMinutes: 0 },
    ]);
    expect(person!.subscriptions).toEqual([expect.objectContaining({ plan: 'STANDARD', status: 'TRIAL' })]);
    expect(person!.consents.medicalConsentAt).toBe(MED.consentAt);
    expect(person!.members).toEqual([expect.objectContaining({ role: 'OWNER', isMe: true })]);
    expect(x.withheld).toEqual(expect.arrayContaining(['MEDICAL_CONTENT', 'CONTACT_PHONE_FULL', 'HEALTH_VITALS']));
  });

  it('aile uçlarının göstermediği veri yok (tıbbi içerik, tam numara, token, cihaz numarası, olay konumu/notu)', async () => {
    await seedAlice();
    const json = JSON.stringify(await svc.export(ALICE));
    for (const secret of [
      'Metformin',
      'Penisilin',
      'Kalp pili',
      'Hipertansiyon',
      PHONE,
      '5559876543',
      'push-token-secret',
      'fcm-token-secret',
      '+905550000005',
      'Mehmet aradı',
      'op-sub-1',
      'someone-else',
      'ciphertext',
      'v1:k1:',
    ])
      expect(json, secret).not.toContain(secret);
    // olay konumu verilmez (profil adresinin koordinatı ayrı alan: address.lat/lng)
    expect(json.match(/40\.98731/g)?.length).toBe(1);
  });

  it('MEMBER erişimi kadar; başka ailenin kişisi yok', async () => {
    const p = await seedAlice();
    const carol = await profile.create(CAROL, { displayName: 'Carol K.' });
    await h.rows(
      `INSERT INTO profile.family_member (id, protected_person_id, subject, role) VALUES (gen_random_uuid(), $1, $2, 'MEMBER')`,
      [p.id, BOB.id],
    );
    const x = await svc.export(BOB);
    expect(x.persons.map((q) => q.profile.id)).toEqual([p.id]);
    expect(x.persons[0]!.profile.myRole).toBe('MEMBER');
    expect(x.account.memberships).toEqual([expect.objectContaining({ protectedPersonId: p.id, role: 'MEMBER' })]);
    // başkasına giden bildirim, başkasının push hedefi ve geri bildirimi yok
    expect(x.account.notifications).toEqual([]);
    expect(x.account.pushTargets).toEqual([]);
    expect(x.account.feedback).toEqual([]);
    expect(JSON.stringify(x)).not.toContain(carol.id);
  });

  it('kişisi olmayan hesap: boş liste; yönetici 403', async () => {
    const x = await svc.export(CAROL);
    expect(x.persons).toEqual([]);
    await expect(svc.export(ADMIN)).rejects.toMatchObject({ status: 403 });
    const ctl = new DataExportController(svc);
    await expect(ctl.export({ actor: ADMIN } as never)).rejects.toMatchObject({ status: 403 });
  });

  it('indirme denetime yazılır: yalnız kimlik ve sayılar (PII yok)', async () => {
    const p = await seedAlice();
    await svc.export(ALICE);
    const rows = await h.rows<{
      actor_kind: string;
      actor_id: string;
      entity_type: string;
      entity_id: string;
      data: unknown;
    }>(
      `SELECT actor_kind, actor_id, entity_type, entity_id, data FROM audit.log WHERE action = 'privacy.data_exported' AND data->'persons'->>0 = $1`,
      [p.id],
    );
    expect(rows).toEqual([
      {
        actor_kind: 'FAMILY',
        actor_id: ALICE.id,
        entity_type: 'family_account',
        entity_id: ALICE.id,
        data: { persons: [p.id], counts: expect.objectContaining({ events: 1, devices: 1, contacts: 1 }) },
      },
    ]);
    expect(scanPii(JSON.stringify(rows), ['Ayşe Y.', 'Mehmet', DOOR])).toEqual([]);
  });
});
