import type { CoverageLevel, CoverageReason, DeviceCategory, DeviceSummary } from '@yanimda/contracts';
import catalog from '@yanimda/messages/tr.json';
import { describe, expect, it } from 'vitest';

import {
  categoryCode,
  commandResultCode,
  deviceLabel,
  gapReasonCode,
  levelCode,
  reasonCode,
  ringAllTargets,
  seenText,
  stripOrder,
  voiceText,
} from './devices';
import { t } from './i18n';

const NOW = Date.parse('2026-11-11T10:00:00Z');
const dev = (id: string, category: DeviceCategory, o: Partial<DeviceSummary> = {}): DeviceSummary => ({
  id,
  kind: category === 'PHONE' ? 'ANDROID_PHONE' : 'WEAROS_WATCH',
  category,
  tier: category === 'RING' ? 'C' : 'A',
  bodyLocation: null,
  nickname: null,
  online: true,
  lastSeenAt: new Date(NOW - 60_000).toISOString(),
  batteryPct: 80,
  charging: false,
  chargingSince: null,
  onBody: category === 'PHONE' ? null : true,
  estimatedHoursLeft: null,
  voiceOrder: null,
  voiceOrderManual: false,
  ...o,
});

describe('T-089 cihaz şeridi (S7.1)', () => {
  it('sıra: sesli arama sırası, sonra sessiz cihazlar kategoriye göre', () => {
    const list = [
      dev('ring', 'RING'),
      dev('phone', 'PHONE', { voiceOrder: 2 }),
      dev('watch', 'WATCH', { voiceOrder: 1 }),
      dev('home', 'HOME_UNIT'),
    ];
    expect(stripOrder(list).map((d) => d.id)).toEqual(['watch', 'phone', 'home', 'ring']);
  });

  it('"Tümünü çaldır": çevrimiçi takılı alarm cihazı ve telefon; şarjdaki, çıkarılmış, çevrimdışı, yüzük değil', () => {
    const list = [
      dev('worn', 'WATCH'),
      dev('unknown', 'PENDANT', { onBody: null }),
      dev('charging', 'WATCH', { charging: true, onBody: false }),
      dev('off', 'WATCH', { onBody: false }),
      dev('offline', 'WATCH', { online: false }),
      dev('ring', 'RING'),
      dev('phone', 'PHONE'),
    ];
    expect(ringAllTargets(list).map((d) => d.id)).toEqual(['worn', 'unknown', 'phone']);
  });

  it('son görülme, sesli arama rozeti (elle verilen ayrı), ad', () => {
    expect(seenText(null, NOW)).toBe('Hiç görülmedi');
    expect(seenText(new Date(NOW - 20_000).toISOString(), NOW)).toBe('az önce görüldü');
    expect(seenText(new Date(NOW - 4 * 60_000).toISOString(), NOW)).toBe('4 dk önce görüldü');
    expect(seenText(new Date(NOW - 125 * 60_000).toISOString(), NOW)).toBe('2 sa önce görüldü');
    expect(voiceText({ voiceOrder: 1, voiceOrderManual: false })).toBe('Sesli arama 1');
    expect(voiceText({ voiceOrder: 2, voiceOrderManual: true })).toBe('Sesli arama 2 (elle)');
    expect(voiceText({ voiceOrder: null, voiceOrderManual: false })).toBeNull();
    expect(deviceLabel({ nickname: null, category: 'PENDANT' })).toBe('Kolye');
    expect(deviceLabel({ nickname: 'Gece kolyesi', category: 'PENDANT' })).toBe('Gece kolyesi');
  });

  it('komut sonucu: ulaştı (doğrudan / köprü), desteklemiyor, ulaştırılamadı', () => {
    const line = (sent: boolean, outcome: string) => t(commandResultCode({ sent, outcome }), { device: 'Saat' });
    expect(line(true, 'sent')).toBe('Saat: gönderildi');
    expect(line(true, 'relayed')).toBe('Saat: gönderildi');
    expect(line(false, 'unsupported')).toBe('Saat bu komutu desteklemiyor');
    expect(line(false, 'no-token')).toBe('Saat: ulaştırılamadı');
    expect(line(false, 'unconfigured')).toBe('Saat: ulaştırılamadı');
  });

  it('KAPSAMA BOŞLUĞU nedeni açılış notundan (katalog kodu); serbest not gösterilmez', () => {
    expect(gapReasonCode([{ to: 'CREATED', note: 'CHARGING' }, { to: 'DEVICE_PROMPT' }])).toBe('O-UI-GAP-CHARGING');
    expect(gapReasonCode([{ to: 'CREATED', note: 'saat çıkarıldı' }])).toBeNull();
    expect(gapReasonCode([{ to: 'CREATED' }])).toBeNull();
  });

  it('dinamik kodlar katalogda: kategori, seviye, neden, boşluk nedeni', () => {
    const cats: DeviceCategory[] = ['WATCH', 'PHONE', 'PENDANT', 'RING', 'EARBUD', 'EARRING', 'HOME_UNIT', 'CLOUD'];
    const levels: CoverageLevel[] = ['FULL', 'BASIC', 'PHONE_ONLY', 'NIGHT', 'NONE'];
    const reasons: CoverageReason[] = [
      'WATCH_CHARGING',
      'NO_ALARM_DEVICE_WORN',
      'ALARM_DEVICE_OFFLINE',
      'PHONE_OFFLINE',
      'NIGHT_WINDOW',
      'ON_HOLD',
    ];
    const codes = [
      ...cats.map(categoryCode),
      ...levels.map(levelCode),
      ...reasons.map(reasonCode),
      ...['CHARGING', 'WATCH_OFF', 'BATTERY_DEAD', 'CONNECTION_LOST'].map((r) => `O-UI-GAP-${r}`),
      'O-TYPE-COVERAGE_GAP',
      'O-SCRIPT-COVERAGE',
    ];
    expect(codes.filter((c) => !(c in catalog))).toEqual([]);
  });
});
