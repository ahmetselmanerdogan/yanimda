import type { DeviceTier, Signal } from '@yanimda/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { ALL_SIGNAL_KINDS } from '../src/modules/device/device.types';
import { computeCoverage, DEFAULT_CAPS, type DeviceFact, type Facts } from '../src/modules/event/coverage';
import { decide, type Decision, tierGate } from '../src/modules/event/decide';
import { DEFAULT_COVERAGE, loadRulePack, ruleFor } from '../src/modules/event/rules.loader';
import {
  assertProfileClass,
  InvalidPartnerProfileError,
  type PartnerModelProfile,
} from '../src/modules/partner/partner.types';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * T-085 OEM sınıf kapısı (docs/07 S2.1, S2.5, S3.5; S10.1 aşama 4 "Hiçbir C sınıfı sinyal kapsamayı değiştirmiyor").
 * Yalnız A sınıfı P1 (SOS, düşme) açar; B sınıfı SOS / düşme açamaz (P2/P3 yalnız kurallarla); C sınıfı hiçbir olay
 * açmaz ve kapsamayı değiştirmez. Kapı iki katmanda: ortak adaptörü profili (kayıtta) ve olay motoru (sınıfa göre).
 */
const pack = loadRulePack('TR');

describe('decide × sınıf tablosu (her sinyal türü)', () => {
  const ctx = { pack, night: false };
  it.each(ALL_SIGNAL_KINDS)('%s: A değişmez, B P1 açamaz, C hiçbir olay açamaz', (kind) => {
    const a = decide({ kind }, { ...ctx, tier: 'A' });
    const b = decide({ kind }, { ...ctx, tier: 'B' });
    const c = decide({ kind }, { ...ctx, tier: 'C' });
    expect(decide({ kind }, ctx)).toEqual(a); // sınıf verilmezse A (eski kayıtlar)
    if (a.action === 'create') {
      const p1 = ruleFor(pack, a.type)?.priority === 1;
      expect(b).toEqual(p1 ? { action: 'ignore', reason: 'TIER_B_P1' } : a);
      expect(c).toEqual({ action: 'ignore', reason: 'TIER_C' });
    } else {
      expect(b).toEqual(a);
      expect(c).toEqual(a);
    }
    for (const x of [b, c]) expect(x.action === 'create' && ruleFor(pack, x.type)?.priority === 1).toBe(false);
  });

  it('A sınıfı SOS / düşme P1 açar; B sınıfında P2/P3 kural olayı (hareketsizlik) açılır', () => {
    expect(decide({ kind: 'SOS' }, { ...ctx, tier: 'A' })).toEqual({ action: 'create', type: 'SOS' });
    expect(decide({ kind: 'FALL' }, { ...ctx, tier: 'A' })).toEqual({ action: 'create', type: 'FALL' });
    expect(decide({ kind: 'INACTIVITY' }, { ...ctx, tier: 'B' })).toEqual({ action: 'create', type: 'INACTIVITY' });
    const gap: Decision = { action: 'create', type: 'COVERAGE_GAP', note: 'NOT_WORN' };
    expect(tierGate(gap, { pack, tier: 'B' })).toEqual(gap);
    expect(tierGate(gap, { pack, tier: 'C' })).toEqual({ action: 'ignore', reason: 'TIER_C' });
  });
});

describe('Kapsama: C sınıfı cihaz hiçbir durumda seviyeyi / nedenleri değiştirmez', () => {
  const NOW = new Date('2026-11-09T11:00:00Z');
  const ago = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
  const fact = (id: string, category: DeviceFact['category'], tier: DeviceTier, x: Partial<DeviceFact> = {}) =>
    ({
      id,
      category,
      tier,
      caps: DEFAULT_CAPS[category],
      batteryLifeH: 40,
      seenAt: ago(1),
      onBody: true,
      charging: false,
      chargingSince: null,
      chargeEndedAt: null,
      batteryPct: 60,
      bridged: false,
      ...x,
    }) satisfies DeviceFact;
  const facts = (...d: DeviceFact[]): Facts => ({
    devices: Object.fromEntries(d.map((x) => [x.id, x])),
    bridgeSeenAt: null,
  });
  const ctx = { params: DEFAULT_COVERAGE, deadPct: 5, night: false, weakKinds: new Set(['X']) };
  // C sınıfı aday: SOS/düşme yetenekli gibi görünen, hattı düşmüş, ortağı bozuk "kolye" bile sayılmaz.
  const cDevices = [
    fact('ring', 'RING', 'C'),
    fact('cloud', 'CLOUD', 'C', { caps: { sos: true, fall: true, voice: true, location: true } }),
    fact('cpendant', 'PENDANT', 'C', { caps: DEFAULT_CAPS.PENDANT, kind: 'X', lineDown: true }),
    fact('chome', 'HOME_UNIT', 'C', { powerLoss: true, lineDown: true }),
  ];
  const bases: [string, DeviceFact[]][] = [
    ['hiç cihaz', []],
    ['saat takılı', [fact('w', 'WATCH', 'A')]],
    [
      'saat şarjda + telefon',
      [fact('w', 'WATCH', 'A', { charging: true, onBody: false }), fact('p', 'PHONE', 'A', { onBody: null })],
    ],
    ['saat çevrimdışı', [fact('w', 'WATCH', 'A', { seenAt: ago(30) })]],
  ];
  it.each(bases)('%s + her C cihazı', (_n, base) => {
    const without = computeCoverage(facts(...base), NOW, ctx);
    for (const c of cDevices) {
      const withC = computeCoverage(facts(...base, c), NOW, ctx);
      expect({ level: withC.level, reasons: withC.reasons, caps: withC.capabilities, worn: withC.worn }).toEqual({
        level: without.level,
        reasons: without.reasons,
        caps: without.capabilities,
        worn: without.worn,
      });
    }
  });
});

describe('Ortak profili sınıf denetimi (kayıtta)', () => {
  const base: PartnerModelProfile = {
    modelId: 'X',
    category: 'RING',
    tier: 'C',
    connectionPath: 'VENDOR_CLOUD',
    signals: ['HEART_RATE', 'STEPS'],
    voice: false,
    location: false,
    fallDetection: false,
    wornEvidence: true,
    latencyTargetP95Sec: 86_400,
    latencyClass: 'DAILY',
    quality: 'Q3',
    commands: [],
  };
  it('C sınıfı düşme / SOS / iptal / konum içeremez; B sınıfı SOS / düşme / iptal içeremez', () => {
    expect(() => assertProfileClass(base)).not.toThrow();
    for (const k of ['FALL', 'SOS', 'CANCEL', 'OK', 'INACTIVITY', 'LOCATION', 'TEST'] as const)
      expect(() => assertProfileClass({ ...base, signals: [...base.signals, k], fallDetection: k === 'FALL' })).toThrow(
        InvalidPartnerProfileError,
      );
    const b = { ...base, tier: 'B' as const, category: 'EARBUD' as const };
    expect(() => assertProfileClass({ ...b, signals: ['HEART_RATE', 'INACTIVITY'] })).not.toThrow();
    for (const k of ['SOS', 'FALL', 'CANCEL'] as const)
      expect(() => assertProfileClass({ ...b, signals: [k], fallDetection: k === 'FALL' })).toThrow(
        InvalidPartnerProfileError,
      );
    expect(() => assertProfileClass({ ...base, tier: 'A', signals: ['SOS'], fallDetection: true })).toThrow(
      InvalidPartnerProfileError,
    ); // düşme yeteneği FALL sinyalsiz
  });
});

describe('Olay motoru (uçtan uca): sınıf sinyalin kaynağından', () => {
  const PERSON = '00000000-0000-0000-0000-0000000000e1';
  const WATCH = '00000000-0000-0000-0000-00000000e0a1';
  const CDEV = '00000000-0000-0000-0000-00000000e0c1';
  const BDEV = '00000000-0000-0000-0000-00000000e0b1';
  let h: Harness;
  let auditMark = 0;
  beforeAll(async () => {
    h = await createHarness();
  });
  beforeEach(async () => {
    await h.reset();
    auditMark = Number((await h.rows<{ m: number }>(`SELECT coalesce(max(id), 0)::int AS m FROM audit.log`))[0]!.m);
    // Kayıttaki sınıf (S1.5: model × entegrasyon yolu) — Wear OS adaptörü tüm sinyalleri normalize eder, sınıf kapısı
    // yalnız olay motorunda sınanır.
    await h.pg.exec(`
      INSERT INTO profile.protected_person (id, display_name) VALUES ('${PERSON}', 'E');
      INSERT INTO event.threshold (protected_person_id, sleep_start, sleep_end) VALUES ('${PERSON}', '00:00', '00:00');
      INSERT INTO device.device (id, protected_person_id, kind, category, tier, enrolled_at) VALUES
        ('${WATCH}', '${PERSON}', 'WEAROS_WATCH', 'WATCH', 'A', now()),
        ('${CDEV}', '${PERSON}', 'WEAROS_WATCH', 'RING', 'C', now()),
        ('${BDEV}', '${PERSON}', 'WEAROS_WATCH', 'EARBUD', 'B', now());`);
    h.events(new InMemoryTimers());
  });
  afterAll(async () => {
    await h.close();
  });

  const ingest = async (...batch: ReturnType<typeof sig>[]) => {
    await h.signals.accept(batch);
    await h.worker().drain();
  };
  const coverageRow = async () =>
    (
      await h.rows<{ level: string; reasons: string[]; devices: unknown; none_since: unknown; gap_since: unknown }>(
        `SELECT level, reasons, devices, none_since, gap_since FROM event.coverage_state WHERE protected_person_id = $1`,
        [PERSON],
      )
    )[0] ?? null;
  const events = () => h.rows<{ type: string; priority: number }>(`SELECT type, priority FROM event.event`);
  const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
  const extra = (kind: Signal['kind']) =>
    kind === 'BATTERY' || kind === 'INACTIVITY' || kind === 'HEART_RATE' || kind === 'STEPS'
      ? { value: kind === 'BATTERY' ? 4 : 60 }
      : kind === 'LOCATION'
        ? { location: { lat: 41, lng: 29 } }
        : {};

  it('hiç kapsama yokken: C sınıfının hiçbir sinyali kapsama satırı açmaz, olay açmaz', async () => {
    await ingest(
      ...ALL_SIGNAL_KINDS.map((kind, i) =>
        sig(kind, {
          deviceId: CDEV,
          protectedPersonId: PERSON,
          occurredAt: at(-30 + i),
          device: { onWrist: true, batteryPct: 50, connectivity: 'BLE' },
          ...extra(kind),
        }),
      ),
    );
    expect(await coverageRow()).toBeNull();
    expect(await events()).toEqual([]);
    // Olay açacak türlerin yok sayılması denetimde (PII yok: tür + sabit kod).
    const audit = await h.rows<{ data: { kind: string; reason: string } }>(
      `SELECT data FROM audit.log WHERE id > ${auditMark} AND action = 'signal.ignored' AND data->>'reason' = 'TIER_C'`,
    );
    expect(audit.map((a) => a.data.kind).sort()).toEqual(
      expect.arrayContaining(['SOS', 'FALL', 'INACTIVITY', 'CALLBACK_REQUEST', 'TEST']),
    );
  });

  it('A sınıfı saat takılıyken: C sınıfının her sinyali kapsamayı aynen bırakır', async () => {
    await ingest(
      sig('ON_BODY', {
        deviceId: WATCH,
        protectedPersonId: PERSON,
        occurredAt: at(-40),
        device: { onWrist: true, batteryPct: 80 },
      }),
    );
    const before = await coverageRow();
    expect(before?.level).toBe('FULL');
    for (const [i, kind] of ALL_SIGNAL_KINDS.entries())
      await ingest(
        sig(kind, {
          deviceId: CDEV,
          protectedPersonId: PERSON,
          occurredAt: at(-30 + i),
          device: { onWrist: false, batteryPct: 3, connectivity: 'BLE' },
          ...extra(kind),
        }),
      );
    expect(await coverageRow()).toEqual(before);
    expect(await events()).toEqual([]);
  });

  it('B sınıfı SOS / düşme olay açmaz (denetimde); B sınıfı kapsamaya A gibi sayılmaz', async () => {
    await ingest(
      sig('SOS', { deviceId: BDEV, protectedPersonId: PERSON, occurredAt: at(-2), device: { onWrist: true } }),
      sig('FALL', { deviceId: BDEV, protectedPersonId: PERSON, occurredAt: at(-1), device: { onWrist: true } }),
    );
    expect(await events()).toEqual([]);
    const audit = await h.rows<{ data: { kind: string; reason: string } }>(
      `SELECT data FROM audit.log WHERE id > ${auditMark} AND action = 'signal.ignored' AND data->>'reason' = 'TIER_B_P1' ORDER BY id`,
    );
    expect(audit.map((a) => a.data.kind)).toEqual(['SOS', 'FALL']);
    expect((await coverageRow())?.level).toBe('NONE'); // takılı B cihazı SOS yolu değildir
  });

  it('yalnız A sınıfı P1 açar: aynı SOS A sınıfı cihazdan P1', async () => {
    await ingest(
      sig('SOS', { deviceId: WATCH, protectedPersonId: PERSON, occurredAt: at(-1), device: { onWrist: true } }),
    );
    expect(await events()).toEqual([{ type: 'SOS', priority: 1 }]);
  });
});
