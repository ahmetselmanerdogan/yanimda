import { TOPICS } from '@yanimda/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CompanionService } from '../src/modules/device/companion.service';
import { verifyDeviceToken } from '../src/modules/device/device-token';
import { type DevicePrincipal, EnrollmentService, operatorInfo } from '../src/modules/device/enrollment.service';
import { ProtectionService } from '../src/modules/event/protection.service';
import { loadRulePack, staticRules } from '../src/modules/event/rules.loader';
import { createHarness, type Harness } from './support/harness';

/**
 * T-042/T-043 eşlikçi telefon (yanimda-android):
 *  - telefon saati aynı kişiye kaydeder (saatte kod yok), saat token'ı geçerli
 *  - köprü: telefon token'ı aynı kişinin etkin saatinin sinyallerini iletebilir; başka kişi / iptal / telefon değil → 403
 *  - kurulum durumu saklanır; eksik izinle bittiyse aileye F-PERM (gün + eksik kümesi başına bir kez)
 *  - config: operatör numaraları ve aile kısayolu
 */
const SECRET = 'test-secret-0123456789abcdef0123456789';
const PERSON = '00000000-0000-0000-0000-0000000000b1';
const OTHER = '00000000-0000-0000-0000-0000000000b2';
const PHONE = '8c1e3f4a-2b5d-4e6f-8a9b-0c1d2e3f4a01';
const WATCH = '8c1e3f4a-2b5d-4e6f-8a9b-0c1d2e3f4a02';
const OTHER_WATCH = '8c1e3f4a-2b5d-4e6f-8a9b-0c1d2e3f4a03';
const T0 = new Date('2026-11-10T09:00:00Z');

let h: Harness;
let enrollment: EnrollmentService;
let svc: CompanionService;
const phone: DevicePrincipal = { deviceId: PHONE, protectedPersonId: PERSON, kind: 'ANDROID_PHONE' };

const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as { status?: number }).status;
  }
};

beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  await h.pg.exec(
    `INSERT INTO profile.protected_person (id, display_name) VALUES ('${PERSON}', 'A'), ('${OTHER}', 'B')`,
  );
  await h.pg.exec(`INSERT INTO device.device (id, protected_person_id, kind, enrolled_at) VALUES
    ('${PHONE}', '${PERSON}', 'ANDROID_PHONE', now()),
    ('${OTHER_WATCH}', '${OTHER}', 'WEAROS_WATCH', now())`);
  const rules = staticRules(loadRulePack());
  enrollment = new EnrollmentService(h.db, h.redis as never, new ProtectionService(h.db, h.outbox), rules, SECRET);
  svc = new CompanionService(h.db, h.redis as never, h.outbox, enrollment, rules);
});
afterAll(async () => {
  await h.close();
});

describe('saat kaydı (telefon üzerinden)', () => {
  it('yeni saat 201 + saat token’ı; aynı istek yeniden 200; token doğrulanır', async () => {
    const first = await svc.enrollCompanion(phone, { deviceId: WATCH, model: 'Galaxy Watch7' }, T0);
    expect(first.created).toBe(true);
    expect(first.body).toMatchObject({ deviceId: WATCH, protectedPersonId: PERSON });
    expect(verifyDeviceToken(first.body.token, SECRET, T0)).toMatchObject({
      sub: WATCH,
      pp: PERSON,
      kind: 'WEAROS_WATCH',
    });
    const p = await enrollment.authenticate(`Bearer ${first.body.token}`, T0);
    expect(p.kind).toBe('WEAROS_WATCH');
    const again = await svc.enrollCompanion(phone, { deviceId: WATCH }, T0);
    expect(again.created).toBe(false);
    const rows = await h.rows<{ kind: string; protected_person_id: string }>(
      `SELECT kind, protected_person_id FROM device.device WHERE id = '${WATCH}'`,
    );
    expect(rows).toEqual([{ kind: 'WEAROS_WATCH', protected_person_id: PERSON }]);
  });

  it('başka kişinin saati 409; telefon olmayan token 403; bozuk gövde 400', async () => {
    expect(await status(svc.enrollCompanion(phone, { deviceId: OTHER_WATCH }, T0))).toBe(409);
    const watch: DevicePrincipal = { deviceId: OTHER_WATCH, protectedPersonId: OTHER, kind: 'WEAROS_WATCH' };
    expect(await status(svc.enrollCompanion(watch, { deviceId: WATCH }, T0))).toBe(403);
    expect(await status(svc.enrollCompanion(phone, { deviceId: 'x' }, T0))).toBe(400);
    expect(await status(svc.enrollCompanion(phone, { deviceId: WATCH, kind: 'IOS_PHONE' }, T0))).toBe(400);
    expect(await status(svc.enrollCompanion(phone, { deviceId: PHONE }, T0))).toBe(400);
  });

  it('kaldırılmış saat yeniden eşleşir; eski token geçersiz', async () => {
    const first = await svc.enrollCompanion(phone, { deviceId: WATCH }, T0);
    await enrollment.revoke(WATCH, new Date(T0.getTime() + 1000));
    const later = new Date(T0.getTime() + 5000);
    const again = await svc.enrollCompanion(phone, { deviceId: WATCH }, later);
    expect(again.created).toBe(true);
    expect(await status(enrollment.authenticate(`Bearer ${first.body.token}`, later))).toBe(401);
    expect((await enrollment.authenticate(`Bearer ${again.body.token}`, later)).deviceId).toBe(WATCH);
  });
});

describe('köprü yetkisi (POST /signals)', () => {
  const s = (deviceId: string, protectedPersonId = PERSON) => ({ deviceId, protectedPersonId });

  it('telefon kendi ve aynı kişinin etkin saatinin sinyallerini iletebilir', async () => {
    await svc.enrollCompanion(phone, { deviceId: WATCH }, T0);
    await expect(svc.assertBatchAllowed(phone, [s(PHONE), s(WATCH), s(WATCH)])).resolves.toBeUndefined();
  });

  it('kayıtsız / başka kişinin / iptal edilmiş saat, başka kişi adına sinyal → 403', async () => {
    expect(await status(svc.assertBatchAllowed(phone, [s(WATCH)]))).toBe(403); // kayıtsız
    expect(await status(svc.assertBatchAllowed(phone, [s(OTHER_WATCH)]))).toBe(403);
    expect(await status(svc.assertBatchAllowed(phone, [s(OTHER_WATCH, OTHER)]))).toBe(403);
    expect(await status(svc.assertBatchAllowed(phone, [s(PHONE), s(PHONE, OTHER)]))).toBe(403);
    await svc.enrollCompanion(phone, { deviceId: WATCH }, T0);
    await enrollment.revoke(WATCH);
    expect(await status(svc.assertBatchAllowed(phone, [s(WATCH)]))).toBe(403);
  });

  it('saat token’ı başka cihazı köprüleyemez; büyük harfli kimlik geçmez; token’sız (simülatör) dokunulmaz', async () => {
    await svc.enrollCompanion(phone, { deviceId: WATCH }, T0);
    const watch: DevicePrincipal = { deviceId: WATCH, protectedPersonId: PERSON, kind: 'WEAROS_WATCH' };
    expect(await status(svc.assertBatchAllowed(watch, [s(PHONE)]))).toBe(403);
    await expect(svc.assertBatchAllowed(watch, [s(WATCH)])).resolves.toBeUndefined();
    expect(await status(svc.assertBatchAllowed(phone, [s(WATCH.toUpperCase())]))).toBe(403);
    await expect(svc.assertBatchAllowed(undefined, [s('sim-1')])).resolves.toBeUndefined();
  });

  it('köprülenen saat sinyali saatin adaptörüyle kaydedilir', async () => {
    await svc.enrollCompanion(phone, { deviceId: WATCH }, T0);
    const sig = {
      schemaVersion: 1,
      idempotencyKey: `${WATCH}:1:FALL:abcd`,
      deviceId: WATCH,
      protectedPersonId: PERSON,
      kind: 'FALL',
      occurredAt: T0.toISOString(),
      device: { onWrist: true, connectivity: 'BLE' },
    };
    await svc.assertBatchAllowed(phone, [sig]);
    const r = await h.signals.accept([sig]);
    expect(r).toMatchObject({ accepted: 1, duplicates: 0 });
    const [row] = await h.rows<{ source: { kind?: string; role?: string } | null }>(
      `SELECT payload->'source' AS source FROM signal.signal WHERE idempotency_key = '${sig.idempotencyKey}'`,
    );
    expect(row?.source).toMatchObject({ kind: 'WEAROS_WATCH' });
  });
});

describe('kurulum durumu', () => {
  const outboxCodes = async () =>
    (
      await h.rows<{ envelope: { payload: { code: string } } }>(
        `SELECT envelope FROM event.outbox WHERE topic = '${TOPICS.notifyRequested}'`,
      )
    ).map((r) => r.envelope.payload.code);

  it('saklanır ve aile listesinde görünür; eksik yokken bildirim yok', async () => {
    await svc.setSetupState(phone, { step: 'WATCH', completed: false, missing: ['BATTERY'] }, T0);
    await svc.setSetupState(phone, { step: 'DONE', completed: true, missing: [], watchPaired: true }, T0);
    const list = await svc.setupStates(PERSON);
    expect(list).toEqual([
      expect.objectContaining({ deviceId: PHONE, step: 'DONE', completed: true, missing: [], watchPaired: true }),
    ]);
    expect(await outboxCodes()).toEqual([]);
  });

  it('eksik izinle biten kurulum aileye F-PERM; aynı gün aynı küme tek anahtar', async () => {
    await svc.setSetupState(phone, { step: 'DONE', completed: true, missing: ['LOCATION_BACKGROUND', 'BATTERY'] }, T0);
    await svc.setSetupState(phone, { step: 'DONE', completed: true, missing: ['BATTERY', 'LOCATION_BACKGROUND'] }, T0);
    const rows = await h.rows<{ envelope: { payload: { code: string; dedupeKey: string; audience: string } } }>(
      `SELECT envelope FROM event.outbox WHERE topic = '${TOPICS.notifyRequested}'`,
    );
    expect(rows.map((r) => r.envelope.payload.code)).toEqual(['F-PERM', 'F-PERM']);
    expect(new Set(rows.map((r) => r.envelope.payload.dedupeKey)).size).toBe(1); // notify.plan tekrarı ayıklar
    expect(rows[0]!.envelope.payload.audience).toBe('FAMILY');
    expect(JSON.stringify(rows)).not.toContain('display_name');
  });

  it('geçersiz gövde 400', async () => {
    expect(await status(svc.setSetupState(phone, { step: 'done', completed: true }, T0))).toBe(400);
    expect(await status(svc.setSetupState(phone, { step: 'DONE' }, T0))).toBe(400);
    expect(await status(svc.setSetupState(phone, { step: 'DONE', completed: true, missing: ['X'] }, T0))).toBe(400);
  });
});

describe('telefon yapılandırması', () => {
  it('operatör numaraları ortamdan; aile kısayolu ilk yakın; saate aile numarası gitmez', async () => {
    expect(
      operatorInfo({ OPERATOR_CALLER_IDS: '+90 212 000 00 00, bozuk, +902160000000', OPERATOR_DISPLAY_NAME: 'Ayşe' }),
    ).toEqual({
      name: 'Ayşe',
      callerIds: ['+90 212 000 00 00', '+902160000000'],
    });
    expect(operatorInfo({ TWILIO_FROM_NUMBER: '+15005550006' }).callerIds).toEqual(['+15005550006']);
    await h.pg
      .exec(`INSERT INTO profile.contact (id, protected_person_id, role, priority, display_name, phone_e164) VALUES
      ('00000000-0000-0000-0000-00000000c001', '${PERSON}', 'CONTACT', 2, 'İkinci', '+905550000002'),
      ('00000000-0000-0000-0000-00000000c002', '${PERSON}', 'CONTACT', 1, 'Kızı', '+905550000001'),
      ('00000000-0000-0000-0000-00000000c003', '${PERSON}', 'NEIGHBOR', 1, 'Komşu', '+905550000009')`);
    const { body } = await enrollment.config(phone);
    expect(body.familyContact).toEqual({ displayName: 'Kızı', phone: '+905550000001' });
    expect(body.messages['P-SETUP-WELCOME']).toBeDefined();
    const w = await enrollment.config({ deviceId: WATCH, protectedPersonId: PERSON, kind: 'WEAROS_WATCH' });
    expect(w.body.familyContact).toBeNull();
  });
});
