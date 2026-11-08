import type { Signal } from '@yanimda/contracts';
import { catalogs } from '@yanimda/messages';
import { describe, expect, it } from 'vitest';

import { connectionState, decide, type Decision } from '../src/modules/event/decide';
import { isInWindow } from '../src/modules/event/night';
import { procedureFor } from '../src/modules/event/procedure';
import { loadRulePack, ruleFor } from '../src/modules/event/rules.loader';

/** T-012 · D-02 kabul: her sinyal türü için beklenen olay / olay yok (kural tablo testi). */
const pack = loadRulePack('TR');
const day = { pack, night: false };
const night = { pack, night: true };
const d = (kind: Signal['kind'], value?: number, ctx = day) => decide({ kind, value }, ctx);

describe('Sinyal → karar tablosu (TR kural paketi)', () => {
  const table: [Signal['kind'], number | undefined, typeof day, Decision][] = [
    ['SOS', undefined, day, { action: 'create', type: 'SOS' }],
    ['SOS', undefined, night, { action: 'create', type: 'SOS' }],
    ['FALL', undefined, day, { action: 'create', type: 'FALL' }],
    ['FALL', undefined, night, { action: 'create', type: 'FALL' }],
    ['CANCEL', undefined, day, { action: 'answer' }],
    ['OK', undefined, day, { action: 'answer' }],
    ['INACTIVITY', 45, day, { action: 'create', type: 'INACTIVITY' }],
    ['INACTIVITY', 30, day, { action: 'create', type: 'INACTIVITY' }],
    ['INACTIVITY', 29, day, { action: 'none', reason: 'eşik altı' }],
    ['INACTIVITY', undefined, day, { action: 'create', type: 'INACTIVITY' }], // cihaz eşiği kendisi aştı
    ['OFF_BODY', undefined, day, { action: 'create', type: 'WATCH_OFF' }],
    ['OFF_BODY', undefined, night, { action: 'none', reason: 'gece penceresi' }],
    ['ON_BODY', undefined, day, { action: 'on-body' }],
    ['BATTERY', 50, day, { action: 'none', reason: 'pil yeterli' }],
    ['BATTERY', 21, day, { action: 'none', reason: 'pil yeterli' }],
    ['BATTERY', 20, day, { action: 'notify', notices: [{ code: 'W-BAT-20', audience: 'ELDER' }] }],
    [
      'BATTERY',
      10,
      day,
      {
        action: 'notify',
        notices: [
          { code: 'W-BAT-10', audience: 'ELDER' },
          { code: 'F-BAT-10', audience: 'FAMILY' },
        ],
      },
    ],
    [
      'BATTERY',
      3,
      night,
      {
        action: 'notify',
        notices: [
          { code: 'W-BAT-10', audience: 'ELDER' },
          { code: 'F-BAT-10', audience: 'FAMILY' },
        ],
      },
    ],
    ['BATTERY', undefined, day, { action: 'none', reason: 'pil değeri yok' }],
    ['CALLBACK_REQUEST', undefined, day, { action: 'create', type: 'CALLBACK' }],
    ['TEST', undefined, day, { action: 'create', type: 'TEST' }],
    ['HEARTBEAT', undefined, day, { action: 'none', reason: 'yalnız kayıt' }],
    ['HEART_RATE', 72, day, { action: 'none', reason: 'yalnız kayıt' }],
    ['STEPS', 3200, day, { action: 'none', reason: 'yalnız kayıt' }],
    ['LOCATION', undefined, day, { action: 'none', reason: 'yalnız kayıt' }],
  ];
  it.each(table)('%s (değer=%s, gece=%o) → %o', (kind, value, ctx, expected) => {
    expect(d(kind, value, ctx)).toEqual(expected);
  });

  it('tablo şemadaki tüm sinyal türlerini kapsar', () => {
    const kinds = new Set(table.map((r) => r[0]));
    for (const k of [
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
    ])
      expect(kinds.has(k as Signal['kind']), k).toBe(true);
  });

  it('eşik kural paketinden okunur (paket değişirse karar değişir)', () => {
    const p2 = {
      ...pack,
      rules: pack.rules.map((r) => (r.type === 'INACTIVITY' ? { ...r, thresholdMin: { default: 60 } } : r)),
    };
    expect(decide({ kind: 'INACTIVITY', value: 45 }, { pack: p2, night: false })).toEqual({
      action: 'none',
      reason: 'eşik altı',
    });
  });

  it('pakette kuralı olmayan olay türü üretilmez', () => {
    const p2 = { ...pack, rules: pack.rules.filter((r) => r.type !== 'SOS') };
    expect(decide({ kind: 'SOS' }, { pack: p2, night: false })).toEqual({ action: 'none', reason: 'kural yok: SOS' });
  });

  it('kullanılan bildirim kodları mesaj kataloğunda var (yeni metin uydurulmaz)', () => {
    for (const v of [10, 20]) {
      const r = d('BATTERY', v);
      if (r.action !== 'notify') throw new Error('notify bekleniyordu');
      for (const n of r.notices) expect(catalogs.tr[n.code as keyof typeof catalogs.tr], n.code).toBeTruthy();
    }
  });
});

describe('Bağlantı durumu (HEARTBEAT boşluğu)', () => {
  const now = new Date('2026-11-08T12:00:00Z');
  const ago = (min: number) => new Date(now.getTime() - min * 60_000);
  it.each([
    [ago(1), 'ONLINE'],
    [ago(14.9), 'ONLINE'],
    [ago(15), 'NO_CONNECTION'],
    [ago(359), 'NO_CONNECTION'],
    [ago(360), 'LOST'],
    [null, 'LOST'],
  ] as const)('son görülme %s → %s', (last, state) => {
    expect(connectionState(last, now, pack)).toBe(state);
  });
});

describe('Gece penceresi (kişi saat dilimi)', () => {
  it.each([
    ['2026-11-08T20:00:00Z', 'Europe/Istanbul', true], //   23:00 İstanbul
    ['2026-11-08T11:00:00Z', 'Europe/Istanbul', false], //  14:00 İstanbul
    ['2026-11-08T04:59:00Z', 'Europe/Istanbul', true], //   07:59
    ['2026-11-08T05:00:00Z', 'Europe/Istanbul', false], //  08:00 (bitiş hariç)
    ['2026-11-08T19:00:00Z', 'Europe/Istanbul', true], //   22:00 (başlangıç dahil)
    ['2026-11-09T04:00:00Z', 'America/New_York', true], //  23:00 New York
    ['2026-11-08T19:00:00Z', 'America/New_York', false], // 14:00 New York
  ])('%s %s → gece=%s', (iso, tz, expected) => {
    expect(isInWindow(new Date(iso), tz)).toBe(expected);
  });
  it('pencere gün içinde de olabilir', () => {
    expect(isInWindow(new Date('2026-11-08T11:00:00Z'), 'Europe/Istanbul', '13:00', '15:00')).toBe(true);
    expect(isInWindow(new Date('2026-11-08T13:00:00Z'), 'Europe/Istanbul', '13:00', '15:00')).toBe(false);
  });
});

describe('Prosedür şablonu', () => {
  it('test olayları 112 adımı olmadan şablon alır', () => {
    const fall = ruleFor(pack, 'FALL')!;
    expect(procedureFor(fall, false)).toContain('CALL_112');
    expect(procedureFor(fall, true)).not.toContain('CALL_112');
    expect(procedureFor(fall, true)).toEqual(fall.chain.filter((s) => s !== 'CALL_112'));
  });
});
