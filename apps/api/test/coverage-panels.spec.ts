import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FieldCipher } from '../src/common/field-cipher';
import { coverageMetrics } from '../src/modules/admin/coverage-metrics';
import { deviceSummaries } from '../src/modules/event/coverage.service';
import { loadRulePack } from '../src/modules/event/rules.loader';
import { CoverageBoardService } from '../src/modules/metrics/coverage-board.service';
import { normalizeAddress } from '../src/modules/profile/address';
import { ProfileService } from '../src/modules/profile/profile.service';
import { createHarness, type Harness } from './support/harness';

/**
 * docs/07 S7.1–S7.3 paneller:
 *  - olay ekranı: "telefon üzerinden" (köprülü cihaz), "aynı adreste ikinci kişi" (normalleştirilmiş adres; yalnız ad,
 *    kimlik, açık olay — sağlık verisi yok, S7.7)
 *  - amir kapsama panosu (S7.2): uyanıkken 20 dk+ YOK, kronik boşluk (<%80), çevrimdışı köprüler, merdiven adımı
 *    başına ulaşılamama, üstlenilmeyen P1, hareketsizlik / yerinde kontrol 112 bildirimleri
 *  - yönetim ölçüleri (S7.3): yalnız toplamlar, kişisel veri yok
 * Saat enjekte edilir.
 */
const NOW = new Date('2026-11-10T09:00:00Z'); // 12:00 İstanbul
const min = (m: number) => new Date(NOW.getTime() + m * 60_000);
const day = (d: number) => new Date(NOW.getTime() + d * 86_400_000);
const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const KEYS = `k1:${randomBytes(32).toString('base64')}`;

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
});
afterAll(async () => {
  await h.close();
});

async function person(id: string, name: string, extra: Record<string, unknown> = {}) {
  const cols = ['id', 'display_name', ...Object.keys(extra)];
  const vals = [id, name, ...Object.values(extra)];
  await h.pg.query(
    `INSERT INTO profile.protected_person (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    vals,
  );
}
async function state(
  id: string,
  o: { level?: string; noneSince?: Date; devices?: unknown; bridge?: Date; chronic?: Date },
) {
  await h.pg.query(
    `INSERT INTO event.coverage_state (protected_person_id, level, raw_level, since, capabilities, devices, reasons,
       none_since, bridge_seen_at, chronic_gap_since)
     VALUES ($1, $2, $2, $3, '{}', $4, $5, $6, $7, $8)`,
    [
      id,
      o.level ?? 'FULL',
      day(-30).toISOString(),
      JSON.stringify(o.devices ?? {}),
      o.level === 'NONE' ? ['PHONE_OFFLINE'] : [],
      o.noneSince?.toISOString() ?? null,
      o.bridge?.toISOString() ?? null,
      o.chronic?.toISOString() ?? null,
    ],
  );
}
const history = (id: string, level: string, at: Date) =>
  h.pg.query('INSERT INTO event.coverage_history (protected_person_id, level, at) VALUES ($1, $2, $3)', [
    id,
    level,
    at.toISOString(),
  ]);
const fact = (category: string, o: Record<string, unknown> = {}) => ({
  id: category.toLowerCase(),
  category,
  tier: category === 'RING' ? 'B' : 'A',
  caps: { sos: category === 'PHONE', fall: false, voice: category === 'PHONE', location: false },
  batteryLifeH: null,
  seenAt: null,
  onBody: null,
  charging: false,
  chargingSince: null,
  chargeEndedAt: null,
  batteryPct: null,
  bridged: false,
  ...o,
});

describe('S7.1 olay ekranı: telefon üzerinden, aynı adreste ikinci kişi', () => {
  it('BLE köprüsüyle gelen cihaz "telefon üzerinden"; telefonun kendisi değil', async () => {
    await state('pp-1', {
      devices: {
        ring: fact('RING', { id: 'ring', bridged: true, seenAt: min(-1).toISOString() }),
        phone: fact('PHONE', { id: 'phone', seenAt: min(-1).toISOString() }),
      },
      bridge: min(-1),
    });
    const list = await deviceSummaries(h.db, loadRulePack(), 'pp-1', NOW);
    expect(list.map((d) => [d.category, d.bridged])).toEqual([
      ['RING', true],
      ['PHONE', false],
    ]);
  });

  it('adres normalleştirme: kısaltma, büyük/küçük harf, Türkçe karakter, "No"', () => {
    const a = normalizeAddress(['Atatürk Mah. Gül Sok. No:5 D:3', 'Kadıköy', 'İstanbul']);
    expect(a).toBe('ataturk mahallesi gul sokak 5 daire 3 kadikoy istanbul');
    expect(normalizeAddress(['ATATÜRK MAHALLESİ GÜL SOKAK 5 DAİRE 3', 'KADIKÖY', 'istanbul'])).toBe(a);
    expect(normalizeAddress(['Atatürk Mh. Gül Sk. No 7', 'Kadıköy', 'İstanbul'])).not.toBe(a);
  });

  it('kişi kartında aynı adresteki etkin diğer kişi: ad + açık olay; onun sağlık verisi yok', async () => {
    const [A, B, C, D] = [uuid(1), uuid(2), uuid(3), uuid(4)];
    const addr = (line: string, district: string, city: string) => ({ address_line: line, district, city });
    await person(A, 'Ayşe', addr('Atatürk Mah. Gül Sok. No:5 D:3', 'Kadıköy', 'İstanbul'));
    await person(B, 'Mehmet', addr('ataturk mahallesi gul sokak 5 daire 3', 'KADIKÖY', 'istanbul'));
    await person(C, 'Fatma', addr('Atatürk Mah. Gül Sok. No:7', 'Kadıköy', 'İstanbul'));
    await person(D, 'Eski', { ...addr('Atatürk Mah. Gül Sok. No:5 D:3', 'Kadıköy', 'İstanbul'), status: 'CANCELED' });
    const cipher = new FieldCipher(KEYS);
    const profile = new ProfileService(h.db, cipher);
    await profile.setMedical({ kind: 'ADMIN' }, B, {
      consentAt: NOW.toISOString(),
      conditions: ['kalp yetmezliği'],
      medications: [],
      allergies: [],
    });
    await h.pg.query(
      "INSERT INTO event.event (id, protected_person_id, type, priority, state) VALUES ($1, $2, 'FALL', 1, 'OPERATOR_QUEUE')",
      [uuid(90), B],
    );
    const card = await h.db.transaction((tx) =>
      profile.eventCard(tx, A, { eventId: uuid(91), operatorId: 'op-1', purpose: 'event_card' }, NOW),
    );
    expect(card!.sameAddress).toEqual([{ protectedPersonId: B, displayName: 'Mehmet', openEventId: uuid(90) }]);
    expect(JSON.stringify(card)).not.toContain('kalp');
  });
});

describe('S7.2 amir kapsama panosu', () => {
  beforeEach(async () => {
    const [A, B, C, D, E, F, G] = [1, 2, 3, 4, 5, 6, 7].map(uuid);
    for (const [id, name] of [
      [A, 'Ali'],
      [B, 'Banu'],
      [C, 'Cem'],
      [E, 'Ece'],
      [F, 'Fuat'],
      [G, 'Gül'],
    ] as const)
      await person(id, name);
    await person(D, 'Deniz', { hold_mode: 'HOSPITAL', hold_until: day(3).toISOString() });
    await state(A, { level: 'NONE', noneSince: min(-60) });
    await state(B, { level: 'NONE', noneSince: min(-10) });
    await state(C, { level: 'NONE', noneSince: min(-120) });
    await state(D, { level: 'NONE', noneSince: min(-180) });
    const bridged = (phoneSeen: Date) => ({
      ring: fact('RING', { id: 'ring', bridged: true, seenAt: phoneSeen.toISOString() }),
      phone: fact('PHONE', { id: 'phone', seenAt: phoneSeen.toISOString() }),
    });
    await state(E, { level: 'PHONE_ONLY', devices: bridged(min(-60)), bridge: min(-60) });
    await state(F, { level: 'PHONE_ONLY', devices: bridged(min(-5)), bridge: min(-5) });
    await state(G, { chronic: day(-1) });
    // Kronik: C son 7 günün çoğunda YOK; A, B, E, F, G hep FULL.
    for (const id of [A, B, E, F, G]) await history(id, 'FULL', day(-10));
    await history(C, 'FULL', day(-10));
    await history(C, 'NONE', day(-6));
    await history(C, 'FULL', min(-200));
    await history(C, 'NONE', min(-120));
  });

  it('uyanıkken 20 dk+ YOK (en uzun önce; hold yok), kronik boşluk, çevrimdışı köprü', async () => {
    const b = await new CoverageBoardService(h.db).board(NOW);
    expect(b.noneAwake.map((x) => [x.name, x.awakeMin, x.reasons])).toEqual([
      ['Cem', 120, ['PHONE_OFFLINE']],
      ['Ali', 60, ['PHONE_OFFLINE']],
    ]);
    expect(b.chronic.map((x) => [x.name, x.chronicSince])).toEqual([
      ['Cem', null],
      ['Gül', day(-1).toISOString()],
    ]);
    expect(b.chronic[0]!.protectedPct).toBeLessThan(20);
    expect(b.offlineBridges).toEqual([
      { protectedPersonId: uuid(5), name: 'Ece', phoneSeenAt: min(-60).toISOString(), bridgedDevices: 1 },
    ]);
  });

  it('merdiven adımı başına ulaşılamama (P1/P2, 7 / 30 gün), üstlenilmeyen P1, 112 bildirimleri', async () => {
    const ev = async (n: number, type: string, priority: number, at: Date, isTest = false) => {
      await h.pg.query(
        `INSERT INTO event.event (id, protected_person_id, type, priority, state, created_at, is_test)
         VALUES ($1, $2, $3, $4, 'CLOSED', $5, $6)`,
        [uuid(100 + n), uuid(1), type, priority, at.toISOString(), isTest],
      );
      await h.pg.query(
        `INSERT INTO chain.chain_run (id, event_id, procedure_country, procedure_version, rules_version, created_at)
         VALUES ($1, $2, 'TR', 1, 6, $3)`,
        [uuid(200 + n), uuid(100 + n), at.toISOString()],
      );
      return uuid(200 + n);
    };
    const step = (run: string, n: number, kind: string, result: string, contactIndex: number | null = null) =>
      h.pg.query(
        `INSERT INTO chain.chain_step (run_id, n, kind, target, contact_index, label_code, timeout_sec, required, result)
         VALUES ($1, $2, $3, 'WATCH', $4, 'O-STEP', 20, true, $5)`,
        [run, n, kind, contactIndex, result],
      );
    const r1 = await ev(1, 'SOS', 1, day(-2));
    await step(r1, 1, 'CALL_WATCH', 'NO_ANSWER');
    await step(r1, 2, 'CALL_PHONE', 'OFFLINE_SKIPPED');
    await step(r1, 3, 'CALL_CONTACT', 'NO_ANSWER', 1);
    const r2 = await ev(2, 'FALL', 1, day(-1));
    await step(r2, 1, 'CALL_WATCH', 'REACHED');
    const r3 = await ev(3, 'COVERAGE_GAP', 3, day(-1)); // P3: sayılmaz
    await step(r3, 1, 'CALL_PHONE', 'NO_ANSWER');
    const r4 = await ev(4, 'SOS', 1, day(-20)); // yalnız 30 günde
    await step(r4, 1, 'CALL_WATCH', 'NO_ANSWER');
    const r5 = await ev(5, 'SOS', 1, day(-1), true); // test: sayılmaz
    await step(r5, 1, 'CALL_WATCH', 'NO_ANSWER');
    await h.pg.query(
      `INSERT INTO event.supervisor_alert (id, dedupe_key, code, event_id, event_type, at) VALUES
        ($1, 'k1', 'O-P1-UNCLAIMED', $4, 'SOS', $5), ($2, 'k2', 'O-QUEUE-UNCLAIMED', $4, 'SOS', $5),
        ($3, 'k3', 'O-P1-UNCLAIMED', $4, 'SOS', $6)`,
      [uuid(301), uuid(302), uuid(303), uuid(101), day(-1).toISOString(), day(-8).toISOString()],
    );
    await h.pg.query(
      "INSERT INTO event.event (id, protected_person_id, type, priority, state) VALUES ($1, $2, 'INACTIVITY', 1, 'DISPATCH')",
      [uuid(110), uuid(3)],
    );
    await h.pg.query(
      `INSERT INTO event.dispatch (event_id, protected_person_id, notified_at) VALUES ($1, $2, $3), ($4, $5, $3)`,
      [uuid(110), uuid(3), day(-1).toISOString(), uuid(101), uuid(1)],
    );

    const b = await new CoverageBoardService(h.db).board(NOW);
    expect(b.unreachable.days7).toEqual([
      {
        step: 'CALL_WATCH',
        attempted: 2,
        reached: 1,
        unreached: 1,
        offlineSkipped: 0,
        unreachableRate: 0.5,
        stalledHere: 0,
      },
      {
        step: 'CALL_PHONE',
        attempted: 1,
        reached: 0,
        unreached: 0,
        offlineSkipped: 1,
        unreachableRate: 1,
        stalledHere: 0,
      },
      {
        step: 'CALL_CONTACT:1',
        attempted: 1,
        reached: 0,
        unreached: 1,
        offlineSkipped: 0,
        unreachableRate: 1,
        stalledHere: 1,
      },
    ]);
    expect(b.unreachable.days30.find((x) => x.step === 'CALL_WATCH')).toMatchObject({ attempted: 3, stalledHere: 1 });
    expect(b.unclaimedP1).toEqual([{ eventId: uuid(101), eventType: 'SOS', at: day(-1).toISOString(), acked: false }]);
    expect(b.dispatch112).toEqual([
      {
        eventId: uuid(110),
        eventType: 'INACTIVITY',
        notifiedAt: day(-1).toISOString(),
        status: 'NOTIFIED',
        name: 'Cem',
      },
    ]);
  });
});

describe('S7.3 yönetim ölçüleri (yalnız toplamlar)', () => {
  it('kişi-gün kapsama, model/sürüm yanlış alarm, gecikme p95, şarj uyumu, 100 kişi-gün olay, pil sağlığı', async () => {
    const A = uuid(1);
    await person(A, 'Ayşe Yılmaz');
    await state(A, {});
    await history(A, 'FULL', day(-30));
    const DEV = uuid(500);
    await h.pg.query(
      "INSERT INTO device.device (id, protected_person_id, kind, app_version) VALUES ($1, $2, 'WEAROS_WATCH', '1.4.0')",
      [DEV, A],
    );
    const ev = (n: number, outcome: string, type = 'SOS') =>
      h.pg.query(
        `INSERT INTO event.event (id, protected_person_id, type, priority, state, created_at, confirmed_outcome,
           source_device_ids) VALUES ($1, $2, $3, 1, 'CLOSED', $4, $5, $6)`,
        [uuid(600 + n), A, type, day(-1).toISOString(), outcome, [DEV]],
      );
    await ev(1, 'FALSE_ALARM');
    await ev(2, 'OK');
    await ev(3, 'EMERGENCY', 'FALL');
    await h.pg.query(
      "INSERT INTO event.false_alarm (id, event_id, protected_person_id, event_type, cause) VALUES ($1, $2, $3, 'SOS', 'USER_CANCEL')",
      [uuid(700), uuid(602), A],
    );
    let k = 0;
    const signal = (kind: string, at: Date, lagSec: number, payload: Record<string, unknown> = {}) =>
      h.pg.query(
        `INSERT INTO signal.signal (time, device_id, protected_person_id, kind, payload, idempotency_key, received_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          at.toISOString(),
          DEV,
          A,
          kind,
          JSON.stringify({ source: { kind: 'WEAROS_WATCH', role: 'WATCH', category: 'WATCH', tier: 'A' }, ...payload }),
          `m-${k++}`,
          new Date(at.getTime() + lagSec * 1000).toISOString(),
        ],
      );
    const t0 = day(-2);
    const at = (m: number) => new Date(t0.getTime() + m * 60_000);
    await signal('HEARTBEAT', at(0), 2, { device: { batteryPct: 90 } });
    await signal('HEARTBEAT', at(60), 4, { device: { batteryPct: 80 } });
    await signal('HEARTBEAT', at(120), 10, { device: { batteryPct: 70 } });
    await signal('CHARGE_END', at(180), 2, { device: { batteryPct: 95 } });
    await signal('ON_BODY', at(190), 2);
    await signal('CHARGE_END', at(300), 2);
    await signal('HEARTBEAT', at(320), 2, { device: { onWrist: true, batteryPct: 85 } });

    const m = await coverageMetrics(h.db, loadRulePack(), 7, NOW);
    expect(m.coverage).toMatchObject({ avgProtectedPct: 100, medianProtectedPct: 100, belowTargetShare: 0 });
    expect(m.coverage.personDays).toBeGreaterThanOrEqual(7);
    expect(m.coverage.buckets.reduce((a, b) => a + b.n, 0)).toBe(m.coverage.personDays);
    expect(m.falseAlarms).toEqual([
      { model: 'WEAROS_WATCH', appVersion: '1.4.0', events: 3, falseAlarms: 2, rate: 0.667 },
    ]);
    expect(m.latency).toEqual([{ tier: 'A', adapter: 'WEAROS_WATCH', signals: 7, p50Sec: 2, p95Sec: 8.2 }]);
    expect(m.charging).toEqual({
      sessions: 2,
      worn: 2,
      medianToWearMin: 15,
      p90ToWearMin: 19,
      beforeReminderShare: 0.5,
    });
    expect(m.eventsPer100PersonDays.SOS).toBeCloseTo((2 / m.coverage.personDays) * 100, 0);
    expect(m.battery).toEqual([{ model: 'WEAROS_WATCH', devices: 1, deviceDays: 1, medianDailyDrainPct: 30 }]);
    expect(JSON.stringify(m)).not.toMatch(/Ayşe|00000000-0000-0000-0000-000000000001/);
  });
});
