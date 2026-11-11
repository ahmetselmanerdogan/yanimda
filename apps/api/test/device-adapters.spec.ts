import type { Signal } from '@yanimda/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AdapterRegistry } from '../src/modules/device/adapter.registry';
import { AndroidPhoneAdapter } from '../src/modules/device/adapters/android-phone.adapter';
import { IosPhoneAdapter } from '../src/modules/device/adapters/ios-phone.adapter';
import { SimulatorAdapter } from '../src/modules/device/adapters/simulator.adapter';
import { WearOsAdapter } from '../src/modules/device/adapters/wearos.adapter';
import { UnsupportedSignalError } from '../src/modules/device/device.types';
import { RecordingPush } from '../src/modules/device/push.port';
import { createHarness, type Harness, sig } from './support/harness';

/** T-015 Cihaz adaptörü arayüzü. Kabul: her adaptör için normalize/capabilities birim testi. */
const s = (kind: string, extra: Record<string, unknown> = {}) => sig(kind, extra) as unknown as Signal;
const ALL_KINDS: Signal['kind'][] = [
  'SOS',
  'FALL',
  'CANCEL',
  'OK',
  'HEART_RATE',
  'STEPS',
  'INACTIVITY',
  'OFF_BODY',
  'ON_BODY',
  'BATTERY',
  'LOCATION',
  'HEARTBEAT',
  'CALLBACK_REQUEST',
  'TEST',
  'CHARGE_START', // T-086
  'CHARGE_END',
];

describe('WearOsAdapter', () => {
  const push = new RecordingPush();
  const a = new WearOsAdapter(push);

  it('capabilities: saat rolü, tüm sinyaller, düşme/bilek/nabız algısı, soru, TTS, çaldırma', () => {
    expect(a.kind).toBe('WEAROS_WATCH');
    expect(a.capabilities()).toEqual({
      role: 'WATCH',
      category: 'WATCH', // T-085: katalog satırı yoksa geçerli kategori / sınıf
      tier: 'A',
      voice: true,
      location: true,
      signals: ALL_KINDS,
      fallDetection: true,
      offBodyDetection: true,
      heartRate: true,
      devicePrompt: true,
      tts: true,
      ring: true,
    });
  });

  it.each(ALL_KINDS)('normalize %s → değişmeden (no-op)', (kind) => {
    const raw = s(kind, { device: { batteryPct: 50, onWrist: true, connectivity: 'BLE' } });
    expect(a.normalize(raw)).toEqual(raw);
  });

  it('promptUser → FCM data mesajı (yüksek öncelik, görünür bildirim yok): olay, TTS kodu, telefon metni, pencere', async () => {
    push.sent.length = 0;
    await a.promptUser('dev-w', {
      eventId: 'ev-1',
      kind: 'FALL',
      tts: 'W-FALL-1',
      windowSec: 60,
      until: '2026-11-11T10:01:00.000Z',
      silent: false,
    });
    expect(push.sent).toEqual([
      {
        deviceId: 'dev-w',
        priority: 'high',
        data: {
          type: 'PROMPT',
          eventId: 'ev-1',
          kind: 'FALL',
          tts: 'W-FALL-1',
          phoneTts: 'P-FALL-PROMPT',
          windowSec: '60',
          until: '2026-11-11T10:01:00.000Z',
          silent: 'false',
        },
        ttlSec: 60,
      },
    ]);
  });

  it('ring → FCM yüksek öncelik', async () => {
    push.sent.length = 0;
    await a.ring('dev-w', { eventId: 'ev-1' });
    expect(push.sent).toEqual([
      { deviceId: 'dev-w', priority: 'high', data: { type: 'RING', eventId: 'ev-1' }, ttlSec: 30 },
    ]);
  });

  it('komutlar (T-089): LOCATE yüksek öncelik olayla, TEST normal öncelik', async () => {
    push.sent.length = 0;
    await a.command('dev-w', { type: 'LOCATE', eventId: 'ev-1' });
    await a.command('dev-w', { type: 'TEST' });
    expect(push.sent).toEqual([
      { deviceId: 'dev-w', priority: 'high', data: { type: 'LOCATE', eventId: 'ev-1' }, ttlSec: 60 },
      { deviceId: 'dev-w', priority: 'normal', data: { type: 'TEST' }, ttlSec: 3600 },
    ]);
  });
});

describe('AndroidPhoneAdapter', () => {
  const push = new RecordingPush();
  const a = new AndroidPhoneAdapter(push);

  it('capabilities: telefon rolü; düşme, bilek ve nabız algısı yok', () => {
    const c = a.capabilities();
    expect(a.kind).toBe('ANDROID_PHONE');
    expect(c).toMatchObject({ role: 'PHONE', fallDetection: false, offBodyDetection: false, heartRate: false });
    expect(c).toMatchObject({ devicePrompt: true, tts: true, ring: true });
    expect(c.signals).toEqual(
      expect.arrayContaining(['SOS', 'CANCEL', 'OK', 'INACTIVITY', 'BATTERY', 'LOCATION', 'HEARTBEAT', 'TEST']),
    );
    for (const k of ['FALL', 'OFF_BODY', 'ON_BODY', 'HEART_RATE'] as const) expect(c.signals).not.toContain(k);
  });

  it.each(['FALL', 'OFF_BODY', 'ON_BODY', 'HEART_RATE'])('normalize %s → desteklenmiyor', (kind) => {
    expect(() => a.normalize(s(kind))).toThrow(UnsupportedSignalError);
  });

  it('normalize: telefon bilek bilgisi taşıyamaz (onWrist atılır), konum kaynağı PHONE', () => {
    const out = a.normalize(
      s('HEARTBEAT', {
        device: { batteryPct: 80, onWrist: true, connectivity: 'WIFI' },
        location: { lat: 41, lng: 29 },
      }),
    );
    expect(out.device).toEqual({ batteryPct: 80, connectivity: 'WIFI' });
    expect(out.location).toEqual({ lat: 41, lng: 29, source: 'PHONE' });
  });

  it('normalize: cihazın verdiği konum kaynağı korunur, giriş nesnesi değişmez', () => {
    const raw = s('SOS', { location: { lat: 41, lng: 29, source: 'GPS' } });
    const copy = structuredClone(raw);
    expect(a.normalize(raw).location?.source).toBe('GPS');
    expect(raw).toEqual(copy);
  });

  it('promptUser → FCM data mesajı; ring → yüksek öncelik', async () => {
    await a.promptUser('dev-p', {
      eventId: 'ev-2',
      kind: 'INACTIVITY',
      tts: 'W-INACT-1',
      windowSec: 120,
      until: '2026-11-11T10:01:00.000Z',
      silent: true,
    });
    await a.ring('dev-p', { eventId: 'ev-2' });
    expect(push.sent.map((m) => [m.data.type, m.priority, m.data.phoneTts])).toEqual([
      ['PROMPT', 'high', 'P-INACT-1'],
      ['RING', 'high', undefined],
    ]);
  });
});

describe('IosPhoneAdapter', () => {
  const push = new RecordingPush();
  const a = new IosPhoneAdapter(push);

  it('capabilities: telefon rolü, Android telefonla aynı sinyal kümesi; düşme/bilek/nabız yok (T-073)', () => {
    const c = a.capabilities();
    expect(a.kind).toBe('IOS_PHONE');
    expect(c).toMatchObject({ role: 'PHONE', fallDetection: false, offBodyDetection: false, heartRate: false });
    expect(c).toMatchObject({ devicePrompt: true, ring: true });
    expect([...c.signals].sort()).toEqual([...new AndroidPhoneAdapter(push).capabilities().signals].sort());
  });

  it('TTS yok: iOS arka planda sesli okuma yapamaz, soru bildirimle gösterilir', () => {
    expect(a.capabilities().tts).toBe(false);
  });

  it.each(['FALL', 'OFF_BODY', 'ON_BODY', 'HEART_RATE'])('normalize %s → desteklenmiyor', (kind) => {
    expect(() => a.normalize(s(kind))).toThrow(UnsupportedSignalError);
  });

  it('normalize: onWrist atılır, konum kaynağı PHONE, giriş değişmez', () => {
    const raw = s('SOS', { device: { batteryPct: 50, onWrist: true }, location: { lat: 41, lng: 29 } });
    const copy = structuredClone(raw);
    const out = a.normalize(raw);
    expect(out.device).toEqual({ batteryPct: 50 });
    expect(out.location).toEqual({ lat: 41, lng: 29, source: 'PHONE' });
    expect(raw).toEqual(copy);
  });

  it('promptUser / ring push ile gider (T-053 APNs)', async () => {
    await a.promptUser('dev-i', {
      eventId: 'ev-3',
      kind: 'INACTIVITY',
      tts: 'W-INACT-1',
      windowSec: 120,
      until: '2026-11-11T10:01:00.000Z',
      silent: false,
    });
    await a.ring('dev-i', { eventId: 'ev-3' });
    expect(push.sent.map((m) => [m.deviceId, m.data.type, m.priority])).toEqual([
      ['dev-i', 'PROMPT', 'high'],
      ['dev-i', 'RING', 'high'],
    ]);
  });
});

describe('SimulatorAdapter', () => {
  it('capabilities: saat gibi davranır (tüm sinyaller)', () => {
    const a = new SimulatorAdapter({ enabled: true });
    expect(a.kind).toBe('SIMULATOR');
    expect(a.capabilities()).toMatchObject({ role: 'WATCH', signals: ALL_KINDS, fallDetection: true });
  });

  it('normalize: payload.simulated=true işaretler (raporlarda ayrılır), girişi değiştirmez', () => {
    const a = new SimulatorAdapter({ enabled: true });
    const raw = s('FALL', { payload: { steps: 3 } });
    expect(a.normalize(raw).payload).toEqual({ steps: 3, simulated: true });
    expect(raw.payload).toEqual({ steps: 3 });
  });

  it('kapalıysa (üretim) sinyal reddedilir', () => {
    const a = new SimulatorAdapter({ enabled: false });
    expect(() => a.normalize(s('SOS'))).toThrow(UnsupportedSignalError);
  });

  it('promptUser / ring push göndermez, yalnız kaydeder', async () => {
    const a = new SimulatorAdapter({ enabled: true });
    await a.promptUser('dev-s', {
      eventId: 'e',
      kind: 'FALL',
      tts: 'W-FALL-1',
      windowSec: 60,
      until: '2026-11-11T10:01:00.000Z',
      silent: false,
    });
    await a.ring('dev-s', { eventId: 'e' });
    await a.command('dev-s', { type: 'LOCATE', eventId: 'e' });
    expect(a.commands.map((c) => c.type)).toEqual(['PROMPT', 'RING', 'LOCATE']);
  });
});

describe('AdapterRegistry', () => {
  const push = new RecordingPush();
  const registry = (simulator = true) =>
    new AdapterRegistry([
      new WearOsAdapter(push),
      new AndroidPhoneAdapter(push),
      new IosPhoneAdapter(push),
      new SimulatorAdapter({ enabled: simulator }),
    ]);

  it('kayıtlı türe göre adaptör seçer', () => {
    const r = registry();
    expect(r.for('WEAROS_WATCH')).toBeInstanceOf(WearOsAdapter);
    expect(r.for('ANDROID_PHONE')).toBeInstanceOf(AndroidPhoneAdapter);
    expect(r.for('IOS_PHONE')).toBeInstanceOf(IosPhoneAdapter);
  });

  it('kayıtsız cihaz → simülatör (geliştirme); bilinmeyen tür → hata', () => {
    expect(registry().for(null)).toBeInstanceOf(SimulatorAdapter);
    expect(() => registry().for('NOKIA_3310')).toThrow(UnsupportedSignalError);
  });

  it('kayıtsız cihaz ve simülatör kapalı → reddedilir', () => {
    expect(() => registry(false).for(null).normalize(s('SOS'))).toThrow(UnsupportedSignalError);
  });

  it('aynı tür iki kez kaydedilemez', () => {
    expect(() => new AdapterRegistry([new WearOsAdapter(push), new WearOsAdapter(push)])).toThrow(/WEAROS_WATCH/);
  });
});

/** T-015 adım 3: POST /v1/signals cihaz türüne göre adaptör seçer. */
describe('Sinyal alımı adaptör üzerinden', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  beforeEach(async () => {
    await h.reset();
    await h.pg.exec(`
      INSERT INTO profile.protected_person (id, display_name) VALUES ('00000000-0000-0000-0000-000000000001', 'demo');
      INSERT INTO device.device (id, protected_person_id, kind) VALUES
        ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-000000000001', 'WEAROS_WATCH'),
        ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-000000000001', 'ANDROID_PHONE');`);
  });
  afterAll(async () => {
    await h.close();
  });
  const PHONE = '00000000-0000-0000-0000-00000000f001';
  const WATCH = '00000000-0000-0000-0000-00000000d001';
  const outboxPayloads = async () =>
    (
      await h.rows<{ envelope: { payload: Signal } }>(
        "SELECT envelope FROM event.outbox WHERE topic = 'signal.received' ORDER BY id",
      )
    ).map((r) => r.envelope.payload);

  it('sunucu kaynağı işaretler: source = { kind, role } + T-085 profil (kategori, sınıf, katalog yetenekleri)', async () => {
    await h.signals.accept([s('HEARTBEAT', { deviceId: PHONE }), s('HEARTBEAT', { deviceId: WATCH }), s('SOS')]);
    const all = { sos: true, fall: true, voice: true, location: true };
    expect((await outboxPayloads()).map((p) => p.source)).toEqual([
      // Kayıtlı cihazlar: device.device_model kataloğu (pil ömrü dahil).
      {
        kind: 'ANDROID_PHONE',
        role: 'PHONE',
        category: 'PHONE',
        tier: 'A',
        caps: { ...all, fall: false },
        batteryLifeH: 30,
      },
      { kind: 'WEAROS_WATCH', role: 'WATCH', category: 'WATCH', tier: 'A', caps: all, batteryLifeH: 40 },
      // Kayıtsız (simülatör): adaptör varsayılanları.
      { kind: 'SIMULATOR', role: 'WATCH', category: 'WATCH', tier: 'A', caps: all, batteryLifeH: null },
    ]);
  });

  it('istemci source gönderemez (şema reddeder)', async () => {
    await expect(
      h.signals.accept([s('SOS', { source: { kind: 'ANDROID_PHONE', role: 'PHONE' } })]),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('telefondan OFF_BODY yalnız kendisi reddedilir (UNSUPPORTED_SIGNAL); HEARTBEAT yazılır', async () => {
    const off = s('OFF_BODY', { deviceId: PHONE });
    expect(await h.signals.accept([s('HEARTBEAT', { deviceId: PHONE }), off])).toEqual({
      accepted: 1,
      duplicates: 0,
      rejected: [{ index: 1, idempotencyKey: off.idempotencyKey, reason: 'UNSUPPORTED_SIGNAL' }],
    });
    expect(await h.rows('SELECT kind FROM signal.signal')).toEqual([{ kind: 'HEARTBEAT' }]);
  });

  it('telefon partisi [SOS, HEART_RATE]: telefon adaptöründe HEART_RATE yok → SOS yine yazılır', async () => {
    const r = await h.signals.accept([s('SOS', { deviceId: PHONE }), s('HEART_RATE', { deviceId: PHONE, value: 80 })]);
    expect(r).toMatchObject({ accepted: 1, rejected: [{ index: 1, reason: 'UNSUPPORTED_SIGNAL' }] });
    expect((await outboxPayloads()).map((p) => p.kind)).toEqual(['SOS']);
  });

  it('partide yalnız desteklenmeyen sinyal → 400 (gövdede rejected)', async () => {
    await expect(h.signals.accept([s('OFF_BODY', { deviceId: PHONE })])).rejects.toMatchObject({
      status: 400,
      response: { rejected: [{ index: 0, reason: 'UNSUPPORTED_SIGNAL' }] },
    });
    expect(await h.rows('SELECT 1 FROM signal.signal')).toEqual([]);
  });

  it('telefon sinyali normalize edilmiş hâliyle kaydedilir', async () => {
    await h.signals.accept([s('SOS', { deviceId: PHONE, device: { onWrist: true }, location: { lat: 41, lng: 29 } })]);
    const [p] = await outboxPayloads();
    expect(p.device).toEqual({});
    expect(p.location).toEqual({ lat: 41, lng: 29, source: 'PHONE' });
  });
});
