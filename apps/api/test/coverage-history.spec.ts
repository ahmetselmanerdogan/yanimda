import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CoverageAccess, type CoverageActor, CoverageController } from '../src/modules/device/coverage.controller';
import { dailyCoverage, type HistoryRow, spansOf, summarize, windowStart } from '../src/modules/event/coverage-report';
import { ProtectionService } from '../src/modules/event/protection.service';
import { createHarness, type Harness } from './support/harness';

/**
 * T-085 (docs/07 S7.3, S7.4) uyanık zaman kapsama yüzdesi ve 7 günlük zaman çizelgesi:
 * GET /v1/protected-persons/{id}/coverage/history?days=7. Gece penceresi (22:00–08:00) ve "hastanede / seyahatte"
 * dakikaları yüzdeye girmez; korunan = FULL / BASIC. Saat enjekte edilir.
 */
const TZ = 'Europe/Istanbul';
const SLEEP = { timezone: TZ, start: '22:00', end: '08:00' };
const NOW = new Date('2026-11-10T09:00:00Z'); // 12:00 İstanbul
/** İstanbul yerel saati (UTC+3). */
const ist = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00+03:00`);
const ROWS: HistoryRow[] = [
  { at: ist('2026-11-08', '20:00'), level: 'FULL', reasons: [] },
  { at: ist('2026-11-09', '12:00'), level: 'PHONE_ONLY', reasons: ['WATCH_CHARGING'] },
  { at: ist('2026-11-09', '13:00'), level: 'FULL', reasons: [] },
  { at: ist('2026-11-09', '15:00'), level: 'NONE', reasons: ['PHONE_OFFLINE'] },
  { at: ist('2026-11-09', '15:30'), level: 'FULL', reasons: [] },
  { at: ist('2026-11-09', '22:00'), level: 'NIGHT', reasons: ['NIGHT_WINDOW'] },
  { at: ist('2026-11-10', '08:00'), level: 'FULL', reasons: [] },
  { at: ist('2026-11-10', '10:00'), level: 'FULL', reasons: ['ON_HOLD'] },
  { at: ist('2026-11-10', '11:00'), level: 'FULL', reasons: [] },
];
const DAY1 = {
  date: '2026-11-09',
  awakeMin: 840,
  protectedMin: 750,
  phoneOnlyMin: 60,
  noneMin: 30,
  holdMin: 0,
  unknownMin: 0,
  protectedPct: 89.3,
  phoneOnlyPct: 7.1,
  nonePct: 3.6,
};
const DAY2 = {
  date: '2026-11-10',
  awakeMin: 240,
  protectedMin: 180,
  phoneOnlyMin: 0,
  noneMin: 0,
  holdMin: 60,
  unknownMin: 0,
  protectedPct: 100,
  phoneOnlyPct: 0,
  nonePct: 0,
};

describe('saf: dilimler ve gün başına uyanık zaman', () => {
  it('pencere başı kişinin yerel gece yarısı', () => {
    expect(windowStart(NOW, 2, TZ)).toEqual(ist('2026-11-09', '00:00'));
    expect(windowStart(NOW, 7, TZ)).toEqual(ist('2026-11-04', '00:00'));
  });

  it('pencere öncesindeki son satır başlangıç seviyesidir; aynı seviye + hold birleşir; hold ayrı dilim', () => {
    const from = windowStart(NOW, 2, TZ);
    const s = spansOf(ROWS, from, NOW);
    expect(s.map((x) => [x.from.toISOString(), x.level, x.hold])).toEqual([
      [from.toISOString(), 'FULL', false],
      [ist('2026-11-09', '12:00').toISOString(), 'PHONE_ONLY', false],
      [ist('2026-11-09', '13:00').toISOString(), 'FULL', false],
      [ist('2026-11-09', '15:00').toISOString(), 'NONE', false],
      [ist('2026-11-09', '15:30').toISOString(), 'FULL', false],
      [ist('2026-11-09', '22:00').toISOString(), 'NIGHT', false],
      [ist('2026-11-10', '08:00').toISOString(), 'FULL', false],
      [ist('2026-11-10', '10:00').toISOString(), 'FULL', true],
      [ist('2026-11-10', '11:00').toISOString(), 'FULL', false],
    ]);
    expect(s.at(-1)!.to).toEqual(NOW);
  });

  it('gece ve hold yüzdeye girmez; geçmişi olmayan uyanık dakika "bilinmiyor"', () => {
    const from = windowStart(NOW, 2, TZ);
    const days = dailyCoverage(spansOf(ROWS, from, NOW), from, NOW, SLEEP);
    expect(days).toEqual([DAY1, DAY2]);
    expect(summarize(days)).toMatchObject({ awakeMin: 1080, protectedMin: 930, holdMin: 60, protectedPct: 91.2 });
    const late = dailyCoverage(spansOf(ROWS.slice(3), from, NOW), from, NOW, SLEEP);
    expect(late[0]).toMatchObject({ unknownMin: 420, noneMin: 30, protectedMin: 390, protectedPct: 92.9 });
  });
});

const PERSON = '00000000-0000-0000-0000-0000000000e1';
let h: Harness;
let protection: ProtectionService;
let persons: CoverageController;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  await h.pg.exec(`
    INSERT INTO profile.protected_person (id, display_name) VALUES ('${PERSON}', 'A');
    INSERT INTO profile.family_member (id, protected_person_id, subject, role) VALUES
      ('00000000-0000-0000-0000-00000000fb01', '${PERSON}', 'fam-alice', 'OWNER');`);
  protection = new ProtectionService(h.db, h.outbox);
  persons = new CoverageController(protection, new CoverageAccess(h.db, protection));
  for (const r of ROWS)
    await h.pg.query(
      'INSERT INTO event.coverage_history (protected_person_id, from_level, level, reasons, at) VALUES ($1, NULL, $2, $3, $4)',
      [PERSON, r.level, r.reasons, r.at.toISOString()],
    );
});
afterAll(async () => {
  await h.close();
});

const req = (a: CoverageActor) => ({ headers: {}, coverageActor: a }) as never;
const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as { status?: number }).status;
  }
};

describe('GET /protected-persons/{id}/coverage/history', () => {
  it('servis: zaman çizelgesi + gün başına yüzdeler (aile uygulaması sözleşmesi)', async () => {
    const r = await protection.coverage.history(PERSON, 2, NOW);
    expect(r).toMatchObject({
      protectedPersonId: PERSON,
      days: 2,
      from: ist('2026-11-09', '00:00').toISOString(),
      to: NOW.toISOString(),
      timezone: TZ,
      sleepWindow: { start: '22:00', end: '08:00' },
      daily: [DAY1, DAY2],
      summary: { protectedPct: 91.2 },
    });
    expect(r.segments[0]).toEqual({
      from: ist('2026-11-09', '00:00').toISOString(),
      to: ist('2026-11-09', '12:00').toISOString(),
      level: 'FULL',
      hold: false,
    });
    expect(r.segments).toHaveLength(9);
  });

  it('yetki: aile ve operasyon okur, başka aile 404; days 1–30', async () => {
    const r = await persons.history(PERSON, undefined, req({ kind: 'FAMILY', sub: 'fam-alice' }));
    expect(r.days).toBe(7);
    expect(r.daily).toHaveLength(7);
    // Gerçek saatle (gün içi saatten bağımsız iddialar): yüzdeler 0–100 ya da ölçülemedi.
    expect(r.daily.every((d) => d.protectedPct === null || (d.protectedPct >= 0 && d.protectedPct <= 100))).toBe(true);
    expect(r.summary.awakeMin).toBeGreaterThan(0);
    expect(await status(persons.history(PERSON, '7', req({ kind: 'OPS', sub: 'op-1', supervisor: false })))).toBe('ok');
    expect(await status(persons.history(PERSON, '7', req({ kind: 'FAMILY', sub: 'fam-bob' })))).toBe(404);
    expect(await status(persons.history(PERSON, '0', req({ kind: 'ADMIN' })))).toBe(400);
    expect(await status(persons.history(PERSON, '31', req({ kind: 'ADMIN' })))).toBe(400);
    expect(await status(persons.history(PERSON, 'x', req({ kind: 'ADMIN' })))).toBe(400);
  });
});
