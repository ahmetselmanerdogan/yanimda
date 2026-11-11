import type { CoverageLevel, Signal, SignalSource } from '@yanimda/contracts';
import { describe, expect, it } from 'vitest';

import {
  applySignal,
  awakeMinutes,
  computeCoverage,
  DEFAULT_CAPS,
  type DeviceFact,
  deviceOnline,
  emptyFacts,
  estimatedHoursLeft,
  type Facts,
  isQuiet,
  noneReason,
  planCheck,
  toProtectionState,
} from '../src/modules/event/coverage';
import { DEFAULT_COVERAGE } from '../src/modules/event/rules.loader';

/**
 * T-085 / T-086 (docs/07 S1, S3, S4) kapsama saf kuralları. Kabul (S10.1 "1. Kapsama ve şarj"): tüm kapsama durumları
 * — takılı / şarjda / çevrimdışı × 1–3 cihaz × gece — tablo testinde; iki giyilebilir cihaz birbirini ezmiyor.
 */
const NOW = new Date('2026-11-09T11:00:00Z'); // 14:00 İstanbul
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const ctx = (night = false) => ({ params: DEFAULT_COVERAGE, deadPct: 5, night });

type State = 'worn' | 'charging' | 'offline' | 'off' | 'dead';
const dev = (id: string, category: DeviceFact['category'], state: State, extra: Partial<DeviceFact> = {}) =>
  ({
    id,
    category,
    tier: category === 'RING' ? 'C' : category === 'EARBUD' ? 'B' : 'A',
    caps: DEFAULT_CAPS[category],
    batteryLifeH: 40,
    seenAt: state === 'offline' || state === 'dead' ? ago(20) : ago(1),
    onBody: state === 'worn' ? true : state === 'charging' || state === 'off' ? false : true,
    charging: state === 'charging',
    chargingSince: state === 'charging' ? ago(10) : null,
    chargeEndedAt: null,
    batteryPct: state === 'dead' ? 3 : 60,
    bridged: false,
    ...extra,
  }) satisfies DeviceFact;
const phone = (state: 'online' | 'offline') =>
  dev('phone', 'PHONE', state === 'online' ? 'off' : 'offline', { onBody: null });
const facts = (...d: DeviceFact[]): Facts => ({
  devices: Object.fromEntries(d.map((x) => [x.id, x])),
  bridgeSeenAt: null,
});

describe('Kapsama seviyesi tablosu (takılı/şarjda/çevrimdışı × 1–3 cihaz × gece)', () => {
  const W = (s: State) => dev('watch', 'WATCH', s);
  const N = (s: State) => dev('pendant', 'PENDANT', s);
  const table: [string, DeviceFact[], boolean, CoverageLevel][] = [
    // 1 cihaz: yalnız saat
    ['saat takılı', [W('worn')], false, 'FULL'],
    ['saat şarjda', [W('charging')], false, 'NONE'],
    ['saat çevrimdışı', [W('offline')], false, 'NONE'],
    ['saat çıkarıldı', [W('off')], false, 'NONE'],
    ['saat pili bitti (görülüyor)', [W('dead')], false, 'NONE'],
    ['gece: saat takılı (TAM kalır)', [W('worn')], true, 'FULL'],
    ['gece: saat şarjda', [W('charging')], true, 'NIGHT'],
    ['gece: saat çevrimdışı', [W('offline')], true, 'NIGHT'],
    // 2 cihaz: saat + telefon
    ['saat takılı + telefon', [W('worn'), phone('online')], false, 'FULL'],
    ['saat şarjda + telefon', [W('charging'), phone('online')], false, 'PHONE_ONLY'],
    ['saat çevrimdışı + telefon', [W('offline'), phone('online')], false, 'PHONE_ONLY'],
    ['saat çıkarıldı + telefon', [W('off'), phone('online')], false, 'PHONE_ONLY'],
    ['saat takılı + telefon çevrimdışı', [W('worn'), phone('offline')], false, 'FULL'],
    ['saat şarjda + telefon çevrimdışı', [W('charging'), phone('offline')], false, 'NONE'],
    ['gece: saat şarjda + telefon', [W('charging'), phone('online')], true, 'NIGHT'],
    ['gece: saat takılı + telefon', [W('worn'), phone('online')], true, 'FULL'],
    // 3 cihaz: saat + kolye + telefon
    ['saat şarjda + kolye takılı + telefon (kabul: TAM)', [W('charging'), N('worn'), phone('online')], false, 'FULL'],
    ['saat takılı + kolye şarjda + telefon', [W('worn'), N('charging'), phone('online')], false, 'FULL'],
    ['ikisi şarjda + telefon', [W('charging'), N('charging'), phone('online')], false, 'PHONE_ONLY'],
    ['saat çevrimdışı + kolye takılı + telefon yok', [W('offline'), N('worn'), phone('offline')], false, 'FULL'],
    ['ikisi çevrimdışı + telefon yok', [W('offline'), N('offline'), phone('offline')], false, 'NONE'],
    ['saat çıkarıldı + kolye çıkarıldı + telefon', [W('off'), N('off'), phone('online')], false, 'PHONE_ONLY'],
    ['gece: saat şarjda + kolye takılı (gece kolye TAM tutar)', [W('charging'), N('worn')], true, 'FULL'],
    ['gece: ikisi şarjda + telefon', [W('charging'), N('charging'), phone('online')], true, 'NIGHT'],
    ['gece: ikisi çevrimdışı + telefon yok', [W('offline'), N('offline'), phone('offline')], true, 'NIGHT'],
  ];
  it.each(table)('%s → %s', (_n, devices, night, level) => {
    const r = computeCoverage(facts(...devices), NOW, ctx(night));
    expect(r.level).toBe(level);
    expect(toProtectionState(r.level)).toBe(
      {
        FULL: 'PROTECTED_WATCH',
        BASIC: 'PROTECTED_WATCH',
        PHONE_ONLY: 'PROTECTED_PHONE',
        NIGHT: 'NIGHT',
        NONE: 'UNPROTECTED',
      }[level],
    );
  });

  it('TEMEL: takılı SOS düğmesi ve ses var, düşme algılama yok', () => {
    const pendant = dev('p', 'PENDANT', 'worn', { caps: { ...DEFAULT_CAPS.PENDANT, fall: false } });
    const r = computeCoverage(facts(pendant), NOW, ctx());
    expect(r).toMatchObject({ level: 'BASIC', capabilities: { sos: true, fall: false, voice: true } });
  });

  it('yetenekler ve nedenler: saat şarjda, telefon koruyor', () => {
    const r = computeCoverage(facts(W('charging'), phone('online')), NOW, ctx());
    expect(r.capabilities).toEqual({ sos: true, fall: false, voice: true, location: true });
    expect(r.reasons).toEqual(['WATCH_CHARGING']);
    expect(r.charging).toEqual(['watch']);
  });

  it('nedenler: alarm cihazı çevrimdışı ve telefon yok; gece penceresi', () => {
    expect(computeCoverage(facts(W('offline')), NOW, ctx()).reasons).toEqual(['ALARM_DEVICE_OFFLINE', 'PHONE_OFFLINE']);
    expect(computeCoverage(facts(phone('online')), NOW, ctx()).reasons).toEqual(['NO_ALARM_DEVICE_WORN']);
    expect(computeCoverage(facts(W('off'), phone('online')), NOW, ctx()).reasons).toEqual(['NO_ALARM_DEVICE_WORN']);
    expect(computeCoverage(facts(W('charging')), NOW, ctx(true)).reasons).toContain('NIGHT_WINDOW');
    expect(computeCoverage(facts(W('worn')), NOW, ctx()).reasons).toEqual([]);
  });

  it('pil ölü eşiğinde (≤%5) cihaz yetenek sayılmaz; C sınıfı (yüzük) hiç sayılmaz', () => {
    expect(computeCoverage(facts(dev('w', 'WATCH', 'worn', { batteryPct: 5 })), NOW, ctx()).level).toBe('NONE');
    expect(computeCoverage(facts(dev('w', 'WATCH', 'worn', { batteryPct: 6 })), NOW, ctx()).level).toBe('FULL');
    const ring = dev('r', 'RING', 'worn');
    expect(deviceOnline(ring, facts(ring), NOW, DEFAULT_COVERAGE)).toBe(false);
    expect(computeCoverage(facts(ring, phone('online')), NOW, ctx()).level).toBe('PHONE_ONLY');
  });
});

describe('Çevrimiçi kuralı (S3.2) ve telefon köprüsü (S4.8)', () => {
  it('A sınıfı 15 dk, B sınıfı 30 dk', () => {
    const a = dev('a', 'WATCH', 'worn', { seenAt: ago(14) });
    const a2 = dev('a', 'WATCH', 'worn', { seenAt: ago(15) });
    const b = dev('b', 'EARBUD', 'worn', { seenAt: ago(29) });
    const b2 = dev('b', 'EARBUD', 'worn', { seenAt: ago(30) });
    for (const [d, on] of [
      [a, true],
      [a2, false],
      [b, true],
      [b2, false],
    ] as const)
      expect(deviceOnline(d, facts(d), NOW, DEFAULT_COVERAGE)).toBe(on);
  });

  it('köprülü cihaz telefonla birlikte düşer; telefon görülüyorsa B sınıfı 30 dk sayılır', () => {
    const ear = dev('e', 'EARBUD', 'worn', { seenAt: ago(20), bridged: true });
    expect(deviceOnline(ear, { ...facts(ear), bridgeSeenAt: ago(20) }, NOW, DEFAULT_COVERAGE)).toBe(false);
    const p = dev('phone', 'PHONE', 'off', { seenAt: ago(5) });
    expect(deviceOnline(ear, facts(ear, p), NOW, DEFAULT_COVERAGE)).toBe(true);
  });

  it('saat BLE ile geliyorsa telefon da görülmüş sayılır (eski köprü davranışı)', () => {
    const s = { kind: 'HEARTBEAT', deviceId: 'w', occurredAt: ago(1), device: { connectivity: 'BLE', onWrist: false } };
    const f = applySignal(emptyFacts(), s as unknown as Signal, new Date(ago(1)));
    expect(f.bridgeSeenAt).toBe(ago(1));
    expect(computeCoverage(f, NOW, ctx()).level).toBe('PHONE_ONLY');
  });
});

describe('Sinyal → olgular: iki giyilebilir cihaz birbirini ezmez (S1.1)', () => {
  const src = (category: SignalSource['category']): SignalSource => ({ kind: 'SIMULATOR', role: 'WATCH', category });
  const sigOf = (deviceId: string, kind: string, min: number, extra: Record<string, unknown> = {}) =>
    ({ deviceId, kind, occurredAt: ago(min), ...extra }) as unknown as Signal;
  const apply = (f: Facts, s: Signal) => applySignal(f, s, new Date(s.occurredAt));

  it('saat ve kolye ayrı izlenir; saat çıkarılınca kolye korumaya devam eder', () => {
    let f = emptyFacts();
    f = apply(f, sigOf('watch', 'ON_BODY', 5, { source: src('WATCH') }));
    f = apply(f, sigOf('pendant', 'ON_BODY', 4, { source: src('PENDANT') }));
    f = apply(f, sigOf('watch', 'OFF_BODY', 3, { source: src('WATCH') }));
    expect(f.devices.watch).toMatchObject({ onBody: false, category: 'WATCH' });
    expect(f.devices.pendant).toMatchObject({ onBody: true, category: 'PENDANT' });
    const r = computeCoverage(f, NOW, ctx());
    expect(r).toMatchObject({ level: 'FULL', worn: ['pendant'], offBody: false });
  });

  it('şarj başladı / bitti; takılınca şarj kapanır; geç gelen eski sinyal durumu ezmez', () => {
    let f = emptyFacts();
    f = apply(f, sigOf('w', 'CHARGE_START', 30, { device: { batteryPct: 40 } }));
    expect(f.devices.w).toMatchObject({ charging: true, chargingSince: ago(30), onBody: false, batteryPct: 40 });
    f = apply(f, sigOf('w', 'HEARTBEAT', 40, { device: { charging: false } })); // eski
    expect(f.devices.w!.charging).toBe(true);
    f = apply(f, sigOf('w', 'CHARGE_END', 10));
    expect(f.devices.w).toMatchObject({ charging: false, chargeEndedAt: ago(10) });
    expect(computeCoverage(f, NOW, ctx()).pendingWear).toEqual(['w']);
    f = apply(f, sigOf('w', 'HEARTBEAT', 5, { device: { onWrist: true } }));
    expect(f.devices.w).toMatchObject({ onBody: true, chargeEndedAt: null });
    f = apply(f, sigOf('w', 'HEARTBEAT', 4, { device: { charging: true } }));
    expect(f.devices.w).toMatchObject({ charging: true, chargingSince: ago(4), onBody: false });
  });
});

describe('Uyanık süre (gece penceresinde durur, uyanış + 30 dk devam)', () => {
  const w = { timezone: 'Europe/Istanbul', start: '22:00', end: '08:00', resumeAfterWakeMin: 30 };
  it('21:30 → ertesi 09:00 = 30 + 30 uyanık dk', () => {
    expect(awakeMinutes(new Date('2026-11-09T18:30:00Z'), new Date('2026-11-10T06:00:00Z'), w)).toBe(60);
  });
  it('gece ve uyanış + 30 sessiz; gündüz değil', () => {
    expect(isQuiet(new Date('2026-11-09T20:00:00Z'), w)).toBe(true); // 23:00
    expect(isQuiet(new Date('2026-11-10T05:15:00Z'), w)).toBe(true); // 08:15
    expect(isQuiet(new Date('2026-11-10T05:30:00Z'), w)).toBe(false); // 08:30
    expect(awakeMinutes(new Date('2026-11-09T11:00:00Z'), new Date('2026-11-09T13:00:00Z'), w)).toBe(120);
  });
  it('günlerce süren boşluk: gün başına uyanık dk', () => {
    const from = new Date('2026-11-09T05:30:00Z'); // 08:30
    expect(awakeMinutes(from, new Date(from.getTime() + 3 * 1440 * 60_000), w)).toBe(3 * (1440 - 630));
  });
});

describe('Kapsama yoksa boşluğun nedeni; tahmini kalan süre', () => {
  it('şarj > pil bitti > saat çıkarıldı > bağlantı yok', () => {
    const c = (...d: DeviceFact[]) => noneReason(computeCoverage(facts(...d), NOW, ctx()));
    expect(c(dev('w', 'WATCH', 'charging'))).toBe('CHARGING');
    expect(c(dev('w', 'WATCH', 'dead'))).toBe('BATTERY_DEAD');
    expect(c(dev('w', 'WATCH', 'off'))).toBe('WATCH_OFF');
    expect(c(dev('w', 'WATCH', 'offline'))).toBe('CONNECTION_LOST');
  });
  it('pil % × katalog pil ömrü; şarjda null', () => {
    expect(estimatedHoursLeft({ batteryPct: 50, batteryLifeH: 40, charging: false })).toBe(20);
    expect(estimatedHoursLeft({ batteryPct: 50, batteryLifeH: 40, charging: true })).toBeNull();
    expect(estimatedHoursLeft({ batteryPct: 50, batteryLifeH: null, charging: false })).toBeNull();
  });
});

describe('18:00 planlı şarj kontrolü (S4.6)', () => {
  const at1805 = new Date('2026-11-09T15:05:00Z');
  const base = {
    personId: 'pp',
    now: at1805,
    timezone: 'Europe/Istanbul',
    planHour: '18:00',
    planPct: 30,
    familyPct: 15,
    windowStart: '19:00',
    params: DEFAULT_COVERAGE,
  };
  const watch = (pct: number, lifeH = 40) =>
    dev('w', 'WATCH', 'worn', {
      batteryPct: pct,
      batteryLifeH: lifeH,
      seenAt: new Date(at1805.getTime() - 60_000).toISOString(),
    });
  const codes = (r: ReturnType<typeof planCheck>) => r?.actions.map((a) => (a.kind === 'notify' ? a.code : a.kind));

  it('%30 altı → kişiye P-CHARGE-NOW + W-BAT-PLAN; %15 altı → aileye de; günde bir', () => {
    expect(codes(planCheck(facts(watch(25)), null, base))).toEqual(['P-CHARGE-NOW', 'W-BAT-PLAN']);
    expect(codes(planCheck(facts(watch(12)), null, base))).toEqual(['P-CHARGE-NOW', 'W-BAT-PLAN', 'F-BAT-PLAN']);
    expect(planCheck(facts(watch(12)), '2026-11-09', base)).toBeNull();
    expect(planCheck(facts(watch(80)), null, base)).toEqual({ checkedOn: '2026-11-09', actions: [] });
  });
  it('tahmini kalan süre bir sonraki şarj penceresine yetmiyorsa uyarır; saat dışında çalışmaz', () => {
    // %40 × 2 sa = 0,8 sa < 19:00'a 55 dk
    expect(codes(planCheck(facts(watch(40, 2)), null, base))).toEqual(['P-CHARGE-NOW', 'W-BAT-PLAN']);
    expect(planCheck(facts(watch(10)), null, { ...base, now: new Date('2026-11-09T14:00:00Z') })).toBeNull();
  });
});
