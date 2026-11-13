import type { ExecutionContext } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { CompanionService } from '../src/modules/device/companion.service';
import {
  CoverageAccess,
  CoverageAccessGuard,
  type CoverageActor,
  CoverageController,
  DeviceManageController,
} from '../src/modules/device/coverage.controller';
import { DEVICE_LIMITS } from '../src/modules/device/device-limits';
import { EnrollmentService } from '../src/modules/device/enrollment.service';
import { ProtectionService } from '../src/modules/event/protection.service';
import { loadRulePack, staticRules } from '../src/modules/event/rules.loader';
import { oidcConfigFromEnv, OidcVerifier } from '../src/modules/identity/oidc-verifier';
import { type FakeOidc, startFakeOidc } from './support/fake-oidc';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * T-085 / T-086 API sözleşmesi (docs/07 S8.3): GET coverage / devices, PATCH / DELETE device (kayıp/çalıntı:
 * token iptal + kapsama hemen yeniden hesaplanır), GET|PUT charging-plan (gece şarjı onayı), POST charging-intent,
 * GET supervisor/coverage, kişi başına cihaz sınırları (F-DEVICE-LIMIT) ve yetki (cihaz token'ı, aile, operasyon).
 */
const SECRET = 'test-secret-0123456789abcdef0123456789';
const PERSON = '00000000-0000-0000-0000-0000000000c1';
const OTHER = '00000000-0000-0000-0000-0000000000c2';
const WATCH = '00000000-0000-0000-0000-00000000c0a1';
const PHONE = '00000000-0000-0000-0000-00000000c0f1';

let h: Harness;
let idp: FakeOidc;
let verifier: OidcVerifier;
let protection: ProtectionService;
let enrollment: EnrollmentService;
let access: CoverageAccess;
let persons: CoverageController;
let devices: DeviceManageController;
beforeAll(async () => {
  h = await createHarness();
  idp = await startFakeOidc();
  verifier = new OidcVerifier(oidcConfigFromEnv({ ...idp.env, NODE_ENV: 'test' }));
});
beforeEach(async () => {
  await h.reset();
  await h.pg.exec(`
    INSERT INTO profile.protected_person (id, display_name) VALUES ('${PERSON}', 'A'), ('${OTHER}', 'B');
    INSERT INTO profile.family_member (id, protected_person_id, subject, role) VALUES
      ('00000000-0000-0000-0000-00000000fa01', '${PERSON}', 'fam-alice', 'OWNER'),
      ('00000000-0000-0000-0000-00000000fa02', '${PERSON}', 'fam-carol', 'MEMBER');
    INSERT INTO device.device (id, protected_person_id, kind, enrolled_at) VALUES
      ('${WATCH}', '${PERSON}', 'WEAROS_WATCH', '2026-01-01T00:00:00Z'),
      ('${PHONE}', '${PERSON}', 'ANDROID_PHONE', '2026-01-01T00:00:00Z');`);
  protection = new ProtectionService(h.db, h.outbox);
  enrollment = new EnrollmentService(h.db, h.redis as never, protection, staticRules(loadRulePack()), SECRET, h.outbox);
  h.events(new InMemoryTimers()); // olay motoru sinyallere abone (kapsama)
  access = new CoverageAccess(h.db, protection);
  persons = new CoverageController(protection, access);
  devices = new DeviceManageController(h.db, enrollment, protection, access);
});
afterAll(async () => {
  await idp.close();
  await h.close();
});

const req = (a: CoverageActor) => ({ headers: {}, coverageActor: a }) as never;
const ALICE: CoverageActor = { kind: 'FAMILY', sub: 'fam-alice' };
const CAROL: CoverageActor = { kind: 'FAMILY', sub: 'fam-carol' };
const BOB: CoverageActor = { kind: 'FAMILY', sub: 'fam-bob' };
const OP: CoverageActor = { kind: 'OPS', sub: 'op-1', supervisor: false };
const SUP: CoverageActor = { kind: 'OPS', sub: 'sup-1', supervisor: true };
const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as { status?: number }).status ?? (e as Error).message;
  }
};
const problemCode = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    const r = (e as { getResponse?: () => { code?: string } }).getResponse?.();
    return `${(e as { status?: number }).status}:${r?.code}`;
  }
};
/** Sinyal alımı (cihaz tablosu) + outbox teslimi (olay motoru, kapsama). */
const ingest = async (...batch: ReturnType<typeof sig>[]) => {
  await h.signals.accept(batch);
  await h.worker().drain();
};
const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

describe('GET devices / coverage', () => {
  it('katalogdan kategori, sınıf, pil ömrü; şarj durumu sinyal alımında yazılır; sesli arama sırası', async () => {
    // Gerçek saatle çalışır: boş gece penceresi (başlangıç = bitiş) sonucu gün içi saatten bağımsız yapar (22:00
    // sonrası NIGHT seviyesi görülüyordu).
    await h.pg.query(
      `INSERT INTO event.threshold (protected_person_id, sleep_start, sleep_end) VALUES ($1, '00:00', '00:00')`,
      [PERSON],
    );
    await ingest(
      sig('HEARTBEAT', {
        deviceId: PHONE,
        protectedPersonId: PERSON,
        occurredAt: at(-2),
        device: { batteryPct: 70, connectivity: 'WIFI' },
      }),
      sig('ON_BODY', {
        deviceId: WATCH,
        protectedPersonId: PERSON,
        occurredAt: at(-1),
        device: { batteryPct: 50, onWrist: true, connectivity: 'BLE' },
      }),
    );
    const list = await persons.devices(PERSON, req(ALICE));
    expect(list).toEqual([
      {
        id: WATCH,
        kind: 'WEAROS_WATCH',
        category: 'WATCH',
        tier: 'A',
        bodyLocation: null,
        nickname: null,
        online: true,
        lastSeenAt: expect.any(String),
        batteryPct: 50,
        charging: false,
        chargingSince: null,
        onBody: true,
        estimatedHoursLeft: 20,
        voiceOrder: 1,
        voiceOrderManual: false,
        voiceNumberLast2: null,
        bridged: true,
      },
      expect.objectContaining({
        id: PHONE,
        kind: 'ANDROID_PHONE',
        category: 'PHONE',
        onBody: null,
        estimatedHoursLeft: 21,
        voiceOrder: 2,
      }),
    ]);
    const cov = await persons.coverage(PERSON, req(ALICE));
    expect(cov).toMatchObject({
      level: 'FULL',
      reasons: [],
      capabilities: { sos: true, fall: true, voice: true, location: true },
    });
    expect(cov.devices).toHaveLength(2);

    // Şarja girdi: kayıt ve kapsama
    const chargeAt = at(0);
    await ingest(sig('CHARGE_START', { deviceId: WATCH, protectedPersonId: PERSON, occurredAt: chargeAt }));
    const [w] = await persons.devices(PERSON, req(ALICE));
    expect(w).toMatchObject({ charging: true, chargingSince: chargeAt, onBody: false, estimatedHoursLeft: null });
    expect(await persons.coverage(PERSON, req(OP))).toMatchObject({
      level: 'PHONE_ONLY',
      reasons: ['WATCH_CHARGING'],
      capabilities: { sos: true, fall: false },
    });
  });

  it('yetki: aile üyesi (OWNER / MEMBER) ve operasyon okur; başka aile ve başka kişinin cihazı 404', async () => {
    expect(await status(persons.coverage(PERSON, req(CAROL)))).toBe('ok');
    expect(await status(persons.coverage(PERSON, req(BOB)))).toBe(404);
    expect(await status(persons.devices(PERSON, req({ kind: 'DEVICE', personId: PERSON, deviceId: PHONE })))).toBe(
      'ok',
    );
    expect(await status(persons.devices(OTHER, req({ kind: 'DEVICE', personId: PERSON, deviceId: PHONE })))).toBe(404);
    expect(await status(persons.coverage('00000000-0000-0000-0000-0000000000ff', req(OP)))).toBe(404);
  });
});

describe('PATCH / DELETE device', () => {
  it('vücut konumu, takma ad, sesli arama sırası; geçersiz alan 400; operasyon düzenler, cihaz düzenleyemez', async () => {
    const s = await devices.patch(PHONE, { bodyLocation: 'POCKET', nickname: ' Cep ', voiceOrder: 1 }, req(ALICE));
    expect(s).toMatchObject({
      id: PHONE,
      bodyLocation: 'POCKET',
      nickname: 'Cep',
      voiceOrder: 1,
      voiceOrderManual: true,
    });
    expect((await persons.devices(PERSON, req(ALICE))).find((d) => d.id === WATCH)).toMatchObject({
      voiceOrder: 2,
      voiceOrderManual: false,
    });
    expect((await devices.patch(PHONE, { voiceOrder: null }, req(ALICE))).voiceOrderManual).toBe(false);
    expect(await status(devices.patch(PHONE, { bodyLocation: 'KNEE' }, req(ALICE)))).toBe(400);
    expect(await status(devices.patch(PHONE, { voiceOrder: 9 }, req(ALICE)))).toBe(400);
    expect(await status(devices.patch(PHONE, { color: 'red' }, req(ALICE)))).toBe(400);
    expect(await status(devices.patch(PHONE, {}, req(ALICE)))).toBe(400);
    expect(await status(devices.patch(PHONE, { nickname: null }, req(OP)))).toBe('ok');
    expect(await status(devices.patch(PHONE, { nickname: 'x' }, req(BOB)))).toBe(404);
    expect(
      await status(devices.patch(PHONE, { nickname: 'x' }, req({ kind: 'DEVICE', personId: PERSON, deviceId: PHONE }))),
    ).toBe(403);
  });

  it('T-087 (S5.2) cihaza özel sesli arama numarası: yalnız operasyon, E.164; kartta ve denetimde numara yok', async () => {
    const s = await devices.patch(WATCH, { voiceNumber: '+905550001234' }, req(OP));
    expect(s.voiceNumberLast2).toBe('34');
    expect(JSON.stringify(s)).not.toContain('5550001234');
    const [row] = await h.rows<{ voice_number: string }>('SELECT voice_number FROM device.device WHERE id = $1', [
      WATCH,
    ]);
    expect(row!.voice_number).toBe('+905550001234');
    const audits = await h.rows<{ data: unknown }>(
      "SELECT data FROM audit.log WHERE action = 'device.updated' AND entity_id = $1",
      [WATCH],
    );
    expect(audits.at(-1)!.data).toEqual({ fields: ['voiceNumber'] });
    expect(JSON.stringify(audits)).not.toContain('5550001234');
    expect(await status(devices.patch(WATCH, { voiceNumber: '+905550001234' }, req(ALICE)))).toBe(403);
    expect(await status(devices.patch(WATCH, { voiceNumber: '05550001234' }, req(OP)))).toBe(400);
    expect((await devices.patch(WATCH, { voiceNumber: null }, req(SUP))).voiceNumberLast2).toBeNull();
  });

  it('kayıp/çalıntı: token iptal (401), cihaz emekli, kapsama hemen yeniden hesaplanır', async () => {
    await ingest(
      sig('ON_BODY', {
        deviceId: WATCH,
        protectedPersonId: PERSON,
        occurredAt: at(-1),
        device: { onWrist: true, connectivity: 'LTE' },
      }),
    );
    expect((await persons.coverage(PERSON, req(ALICE))).level).toBe('FULL');
    const token = enrollment.issueToken(
      { deviceId: WATCH, protectedPersonId: PERSON, kind: 'WEAROS_WATCH' },
      new Date(),
    ).token;
    expect(await status(enrollment.authenticate(`Bearer ${token}`))).toBe('ok');
    expect(await status(devices.remove(WATCH, req(OP)))).toBe(403); // operatör kaldıramaz; amir kaldırır
    await devices.remove(WATCH, req(ALICE));
    expect(await status(enrollment.authenticate(`Bearer ${token}`))).toBe(401);
    const [row] = await h.rows<{ level: string; devices: Record<string, unknown> }>(
      'SELECT level, devices FROM event.coverage_state WHERE protected_person_id = $1',
      [PERSON],
    );
    expect(row!.devices[WATCH]).toBeUndefined();
    expect(row!.devices[PHONE]).toBeUndefined(); // telefondan henüz sinyal yok
    expect(['NONE', 'NIGHT']).toContain(row!.level);
    expect((await persons.devices(PERSON, req(ALICE))).map((d) => d.id)).toEqual([PHONE]);
    const [d] = await h.rows<{ retired_at: Date | null }>('SELECT retired_at FROM device.device WHERE id = $1', [
      WATCH,
    ]);
    expect(d!.retired_at).not.toBeNull();
    expect(await status(devices.remove(PHONE, req(SUP)))).toBe('ok');
  });
});

describe('Cihaz sınırları (S1.7) → 409 F-DEVICE-LIMIT + aileye bildirim', () => {
  const ID = (n: number) => `00000000-0000-0000-0000-00000000d${String(n).padStart(3, '0')}`;
  const limitNotices = () =>
    h.rows<{ n: number }>(
      "SELECT count(*)::int AS n FROM event.outbox WHERE topic = 'notify.requested' AND envelope->'payload'->>'code' = 'F-DEVICE-LIMIT'",
    );

  it('ikinci yaşlı telefonu reddedilir', async () => {
    const { code } = await enrollment.createInvite(PERSON);
    expect(await problemCode(enrollment.enroll({ inviteCode: code, deviceId: ID(1), kind: 'IOS_PHONE' }))).toBe(
      '409:F-DEVICE-LIMIT',
    );
    expect((await limitNotices())[0]!.n).toBe(1);
    // Kod tüketilmedi: telefon kaldırılınca aynı kodla eklenebilir.
    await devices.remove(PHONE, req(ALICE));
    expect((await enrollment.enroll({ inviteCode: code, deviceId: ID(1), kind: 'IOS_PHONE' })).created).toBe(true);
  });

  it('en çok 3 A sınıfı giyilebilir; telefonun saat kaydı da sınıra takılır', async () => {
    await h.pg.exec(`INSERT INTO device.device (id, protected_person_id, kind) VALUES
      ('${ID(2)}', '${PERSON}', 'WEAROS_WATCH'), ('${ID(3)}', '${PERSON}', 'WEAROS_WATCH')`);
    expect(DEVICE_LIMITS.alarmWearables).toBe(3);
    const { code } = await enrollment.createInvite(PERSON);
    expect(await problemCode(enrollment.enroll({ inviteCode: code, deviceId: ID(4), kind: 'WEAROS_WATCH' }))).toBe(
      '409:F-DEVICE-LIMIT',
    );
    const companion = new CompanionService(h.db, h.redis as never, h.outbox, enrollment);
    const phone = { deviceId: PHONE, protectedPersonId: PERSON, kind: 'ANDROID_PHONE' };
    expect(await problemCode(companion.enrollCompanion(phone, { deviceId: ID(5) }))).toBe('409:F-DEVICE-LIMIT');
    expect((await limitNotices())[0]!.n).toBe(2);
    // Aynı saatin yeniden kaydı (mevcut cihaz) sınıra takılmaz.
    expect((await companion.enrollCompanion(phone, { deviceId: WATCH })).created).toBe(false);
  });

  it('en çok 6 etkin cihaz (kaldırılan / emekli sayılmaz)', async () => {
    await h.pg.exec(`
      INSERT INTO device.device (id, protected_person_id, kind, category, tier) VALUES
        ('${ID(6)}', '${PERSON}', 'SIMULATOR', 'RING', 'C'),
        ('${ID(7)}', '${PERSON}', 'SIMULATOR', 'EARBUD', 'B'),
        ('${ID(8)}', '${PERSON}', 'SIMULATOR', 'EARRING', 'C');
      INSERT INTO device.device (id, protected_person_id, kind, revoked_at) VALUES
        ('${ID(9)}', '${PERSON}', 'WEAROS_WATCH', now());`);
    const { code } = await enrollment.createInvite(PERSON);
    expect((await enrollment.enroll({ inviteCode: code, deviceId: ID(10), kind: 'WEAROS_WATCH' })).created).toBe(true);
    const next = await enrollment.createInvite(PERSON);
    expect(
      await problemCode(enrollment.enroll({ inviteCode: next.code, deviceId: ID(11), kind: 'WEAROS_WATCH' })),
    ).toBe('409:F-DEVICE-LIMIT');
  });
});

describe('Şarj penceresi (S4.3) ve "şarj ediyorum" (S4.5)', () => {
  it('varsayılan 19:00–21:00; aile (OWNER ve MEMBER) değiştirir; operasyon ve cihaz 403', async () => {
    expect(await persons.plan(PERSON, req(OP))).toEqual({
      window: '19:00-21:00',
      source: 'DEFAULT',
      nightChargeAllowed: false,
    });
    expect(await persons.setPlan(PERSON, { window: '18:30-20:00' }, req(CAROL))).toEqual({
      window: '18:30-20:00',
      source: 'FAMILY',
      nightChargeAllowed: false,
    });
    expect(await status(persons.setPlan(PERSON, { window: '18:00-20:00' }, req(OP)))).toBe(403);
    expect(
      await status(
        persons.setPlan(PERSON, { window: '18:00-20:00' }, req({ kind: 'DEVICE', personId: PERSON, deviceId: PHONE })),
      ),
    ).toBe(403);
    expect(await status(persons.setPlan(PERSON, { window: '18:00-20:00' }, req(BOB)))).toBe(404);
    expect(await status(persons.setPlan(PERSON, { window: '25:00-20:00' }, req(ALICE)))).toBe(400);
  });

  it('gece şarjı yalnız "gece düşme koruması yok" onayıyla; kapalıyken pencere gece penceresine taşamaz', async () => {
    expect(await problemCode(persons.setPlan(PERSON, { nightChargeAllowed: true }, req(ALICE)))).toBe(
      '400:F-UI-NIGHT-CHARGE-WARN',
    );
    expect(await problemCode(persons.setPlan(PERSON, { window: '23:00-01:00' }, req(ALICE)))).toBe(
      '400:F-UI-NIGHT-CHARGE-WARN',
    );
    expect(
      await persons.setPlan(
        PERSON,
        { window: '23:00-01:00', nightChargeAllowed: true, acknowledgeNoNightFall: true },
        req(ALICE),
      ),
    ).toEqual({ window: '23:00-01:00', source: 'FAMILY', nightChargeAllowed: true });
    const [p] = await h.rows<{ night_ack_by: string }>(
      'SELECT night_ack_by FROM event.charging_plan WHERE protected_person_id = $1',
      [PERSON],
    );
    expect(p!.night_ack_by).toBe('fam-alice');
  });

  it('charging-intent: kişinin kendi cihazı veya aile (202 { until }); başka kişinin cihazı 404, operatör 403', async () => {
    const r = await devices.chargingIntent(
      WATCH,
      { minutes: 60 },
      req({ kind: 'DEVICE', personId: PERSON, deviceId: PHONE }),
    );
    expect(Date.parse(r.until) - Date.now()).toBeGreaterThan(59 * 60_000);
    expect(await status(devices.chargingIntent(WATCH, {}, req(ALICE)))).toBe('ok');
    expect(
      await status(devices.chargingIntent(WATCH, {}, req({ kind: 'DEVICE', personId: OTHER, deviceId: 'x' }))),
    ).toBe(404);
    expect(await status(devices.chargingIntent(WATCH, {}, req(OP)))).toBe(403);
    expect(await status(devices.chargingIntent(WATCH, { minutes: 0 }, req(ALICE)))).toBe(400);
    expect(await status(devices.chargingIntent(WATCH, { minutes: '5' }, req(ALICE)))).toBe(400);
  });
});

describe('GET /supervisor/coverage (S4.11)', () => {
  it('seviye başına kişi; plan penceresinde başlayan şarj boşluğu "planlı şarj"', async () => {
    await h.pg.exec(`
      INSERT INTO event.coverage_state (protected_person_id, level, raw_level, since, capabilities, gap_cause, gap_off_plan)
      VALUES ('a', 'FULL', 'FULL', now(), '{}', NULL, false),
             ('b', 'PHONE_ONLY', 'PHONE_ONLY', now(), '{}', 'CHARGING', false),
             ('c', 'PHONE_ONLY', 'PHONE_ONLY', now(), '{}', 'CHARGING', true),
             ('d', 'NONE', 'NONE', now(), '{}', NULL, false)`);
    const s = await protection.coverage.supervisorSummary(new Date('2026-11-09T16:00:00Z'));
    expect(s).toEqual({
      counts: { FULL: 1, BASIC: 0, PHONE_ONLY: 2, NIGHT: 0, NONE: 1 },
      plannedCharging: 1,
      total: 4,
      at: '2026-11-09T16:00:00.000Z',
    });
  });
});

describe('CoverageAccessGuard', () => {
  const ctx = (headers: Record<string, string>) => {
    const r: { headers: Record<string, string>; coverageActor?: CoverageActor } = { headers };
    return { r, c: { switchToHttp: () => ({ getRequest: () => r }) } as unknown as ExecutionContext };
  };
  const guard = () => new CoverageAccessGuard(enrollment, verifier);

  it('cihaz token → DEVICE; aile → FAMILY; operasyon → OPS; ADMIN; yanlış token 401; tüketici başka rol 403', async () => {
    const token = enrollment.issueToken(
      { deviceId: PHONE, protectedPersonId: PERSON, kind: 'ANDROID_PHONE' },
      new Date(),
    ).token;
    let x = ctx({ authorization: `Bearer ${token}` });
    await guard().canActivate(x.c);
    expect(x.r.coverageActor).toEqual({ kind: 'DEVICE', personId: PERSON, deviceId: PHONE });
    x = ctx({ authorization: `Bearer ${idp.token({ realm: 'consumers', roles: ['FAMILY'], sub: 'fam-alice' })}` });
    await guard().canActivate(x.c);
    expect(x.r.coverageActor).toEqual({ kind: 'FAMILY', sub: 'fam-alice' });
    x = ctx({ authorization: `Bearer ${idp.token({ sub: 'sup-1', roles: ['SUPERVISOR'] })}` });
    await guard().canActivate(x.c);
    expect(x.r.coverageActor).toEqual({ kind: 'OPS', sub: 'sup-1', supervisor: true });
    x = ctx({ authorization: `Bearer ${idp.token({ sub: 'adm', roles: ['ADMIN'] })}` });
    await guard().canActivate(x.c);
    expect(x.r.coverageActor).toEqual({ kind: 'ADMIN', sub: 'adm' });
    expect(await status(guard().canActivate(ctx({ authorization: 'Bearer nope' }).c))).toBe(401);
    expect(await status(guard().canActivate(ctx({}).c))).toBe(401);
    expect(
      await status(
        guard().canActivate(ctx({ authorization: `Bearer ${idp.token({ realm: 'consumers', roles: ['ELDER'] })}` }).c),
      ),
    ).toBe(403);
  });

  it('x-admin-token: geliştirmede ADMIN; T-081 G-4 üretimde yok sayılır (401)', async () => {
    const prev = { token: process.env.ADMIN_TOKEN, env: process.env.NODE_ENV };
    process.env.ADMIN_TOKEN = 'dogru-token-123';
    try {
      const x = ctx({ 'x-admin-token': 'dogru-token-123' });
      await guard().canActivate(x.c);
      expect(x.r.coverageActor).toEqual({ kind: 'ADMIN' });
      process.env.NODE_ENV = 'production';
      expect(await status(guard().canActivate(ctx({ 'x-admin-token': 'dogru-token-123' }).c))).toBe(401);
    } finally {
      process.env.NODE_ENV = prev.env;
      if (prev.token === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = prev.token;
    }
  });
});
