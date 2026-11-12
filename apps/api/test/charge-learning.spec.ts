import type { KafkaEnvelope, Signal, SignalSource } from '@yanimda/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '../src/common/bus';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { chargeSessions, circularMedian, learnChargingWindow, mainCharges } from '../src/modules/event/charge-learning';
import type { EventService } from '../src/modules/event/event.service';
import { ProtectionService } from '../src/modules/event/protection.service';
import { DEFAULT_CHARGE_LEARN, loadRulePack } from '../src/modules/event/rules.loader';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * T-086 (docs/07 S4.3) öğrenilmiş şarj penceresi: 14 günlük CHARGE_START / CHARGE_END geçmişinden günün ana şarjı,
 * en az 7 geçerli gün → başlangıç/bitiş ortancası (15 dk'ya) → LEARNED. Aile verdiyse (FAMILY) dokunulmaz; gece
 * penceresine taşan pencere öğrenilmez; öğrenilen pencere "planlı şarj" sınıflamasında (gap_off_plan) kullanılır.
 * Saat enjekte edilir (gün içi saatten bağımsız).
 */
const TZ = 'Europe/Istanbul';
const P = 'pp-1';
const Q = 'pp-2';
const NOW = new Date('2026-11-20T06:00:00Z'); // 09:00 İstanbul
const DAY = 86_400_000;
const ist = (daysAgo: number, hh: number, mm: number) => new Date(Date.UTC(2026, 10, 20, hh - 3, mm) - daysAgo * DAY); // İstanbul UTC+3
const WATCH: SignalSource = { kind: 'WEAROS_WATCH', role: 'WATCH' };
const PHONE: SignalSource = { kind: 'ANDROID_PHONE', role: 'PHONE' };

describe('saf: oturumlar, ana şarj, dairesel ortanca', () => {
  const at = (iso: string) => new Date(iso);
  it('başlangıç sonraki bitişle eşlenir; bitişsiz / 12 saatten uzun oturum sayılmaz; cihazlar karışmaz', () => {
    const s = chargeSessions(
      [
        { deviceId: 'w', kind: 'CHARGE_START', at: at('2026-11-10T14:00:00Z') },
        { deviceId: 'k', kind: 'CHARGE_START', at: at('2026-11-10T14:10:00Z') },
        { deviceId: 'w', kind: 'CHARGE_START', at: at('2026-11-10T14:05:00Z') }, // tekrar: ilk başlangıç geçerli
        { deviceId: 'w', kind: 'CHARGE_END', at: at('2026-11-10T15:30:00Z') },
        { deviceId: 'k', kind: 'CHARGE_END', at: at('2026-11-11T04:00:00Z') }, // 13 sa 50 dk
        { deviceId: 'w', kind: 'CHARGE_START', at: at('2026-11-11T14:00:00Z') }, // bitişsiz
      ],
      DEFAULT_CHARGE_LEARN,
    );
    expect(s).toEqual([{ deviceId: 'w', start: at('2026-11-10T14:00:00Z'), end: at('2026-11-10T15:30:00Z') }]);
  });

  it('günün ana şarjı en uzun oturumdur; 20 dk altı sayılmaz', () => {
    const m = mainCharges(
      [
        { deviceId: 'w', start: at('2026-11-10T09:00:00Z'), end: at('2026-11-10T09:15:00Z') }, // 15 dk
        { deviceId: 'w', start: at('2026-11-10T14:00:00Z'), end: at('2026-11-10T15:30:00Z') },
        { deviceId: 'w', start: at('2026-11-11T09:00:00Z'), end: at('2026-11-11T09:10:00Z') },
      ],
      TZ,
      DEFAULT_CHARGE_LEARN,
    );
    expect([...m.keys()]).toEqual(['2026-11-10']);
    expect(m.get('2026-11-10')!.start).toEqual(at('2026-11-10T14:00:00Z'));
  });

  it('dairesel ortanca gece yarısını aşan şarjı doğru bulur', () => {
    expect(circularMedian([1430, 10, 20])).toBe(10);
    expect(circularMedian([1420, 1430, 1435])).toBe(1430);
    expect(circularMedian([600, 620])).toBe(610);
  });

  it('yeterli gün: ortanca 15 dk’ya yuvarlanır; 23:30–01:00 şarjı; az gün → null', () => {
    const marks = (days: number, sh: number, sm: number, eh: number, em: number) =>
      Array.from({ length: days }, (_, i) => [
        { deviceId: 'w', kind: 'CHARGE_START' as const, at: ist(i + 1, sh, sm + (i % 3) * 5) },
        { deviceId: 'w', kind: 'CHARGE_END' as const, at: ist(i + 1 - (eh < sh ? 1 : 0), eh, em + (i % 3) * 5) },
      ]).flat();
    expect(learnChargingWindow(marks(10, 17, 0, 18, 15), TZ, NOW, DEFAULT_CHARGE_LEARN)).toEqual({
      start: '17:00',
      end: '18:30',
      validDays: 10,
    });
    expect(learnChargingWindow(marks(9, 23, 30, 0, 50), TZ, NOW, DEFAULT_CHARGE_LEARN)).toEqual({
      start: '23:30',
      end: '01:00',
      validDays: 9,
    });
    expect(learnChargingWindow(marks(6, 17, 0, 18, 15), TZ, NOW, DEFAULT_CHARGE_LEARN)).toBeNull();
  });
});

let h: Harness;
let events: EventService;
let protection: ProtectionService;
let key = 0;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  events = h.events(new InMemoryTimers());
  protection = new ProtectionService(h.db, h.outbox);
});
afterAll(async () => {
  await h.close();
});

const deliver = (s: ReturnType<typeof sig>) =>
  bus.deliver<Signal>('signal.received', { payload: s } as unknown as KafkaEnvelope<Signal>);
const send = (person: string, device: string, kind: string, at: Date, source: SignalSource) =>
  deliver(
    sig(kind, {
      protectedPersonId: person,
      deviceId: `${person}-${device}`,
      occurredAt: at.toISOString(),
      source,
      device: { connectivity: 'LTE' },
    }),
  );
/** Geçmiş şarj sinyali (signal.signal; olay motorundan geçmez). */
const mark = (person: string, kind: string, at: Date, category = 'WATCH') =>
  h.pg.query(
    `INSERT INTO signal.signal (time, device_id, protected_person_id, kind, payload, idempotency_key, received_at)
     VALUES ($1, $2, $3, $4, $5, $6, $1)`,
    [
      at.toISOString(),
      `${person}-${category.toLowerCase()}`,
      person,
      kind,
      JSON.stringify({ source: { kind: 'SIMULATOR', role: 'WATCH', category, tier: 'A' } }),
      `hist-${key++}`,
    ],
  );
/** `days` gün, her gün 17:00/17:05/17:10 → 18:15/18:20/18:25 (+ öğlen 10 dk'lık kısa şarj, telefonun gece şarjı). */
async function history(person: string, days: number, from = 1, sh = 17, eh = 18) {
  for (let i = from; i < from + days; i++) {
    const j = i - from;
    await mark(person, 'CHARGE_START', ist(i, sh, (j % 3) * 5));
    await mark(person, 'CHARGE_END', ist(i, eh, 15 + (j % 3) * 5));
    await mark(person, 'CHARGE_START', ist(i, 12, 0));
    await mark(person, 'CHARGE_END', ist(i, 12, 10));
    await mark(person, 'CHARGE_START', ist(i, 23, 0), 'PHONE');
  }
}
const plan = async (person: string) =>
  (
    await h.rows<{ window_start: string; window_end: string; source: string; learned_days: number | null }>(
      'SELECT window_start, window_end, source, learned_days FROM event.charging_plan WHERE protected_person_id = $1',
      [person],
    )
  )[0];
const learnedAudits = () =>
  h.rows<{ entity_id: string; data: Record<string, unknown> }>(
    "SELECT entity_id, data FROM audit.log WHERE action = 'coverage.charging_plan_learned' AND entity_id IN ($1, $2)",
    [P, Q],
  );

describe('öğrenilmiş şarj penceresi (servis + tarama)', () => {
  it('14 gün / ≥7 geçerli gün → LEARNED; günde bir kez; denetimde yalnız pencere ve gün sayısı', async () => {
    expect(loadRulePack().charging?.learn).toMatchObject({ days: 14, minDays: 7 });
    await send(P, 'w', 'HEARTBEAT', ist(0, 8, 0), WATCH); // kapsama satırı
    await history(P, 11, 1);
    await mark(P, 'CHARGE_START', ist(14, 17, 0)); // en eski şarj 14. gün (14 günlük geçmiş)
    await mark(P, 'CHARGE_END', ist(14, 18, 15));
    await events.sweepProtection(NOW);
    expect(await plan(P)).toEqual({ window_start: '17:00', window_end: '18:30', source: 'LEARNED', learned_days: 12 });
    expect(await protection.coverage.chargingPlan(P)).toMatchObject({
      window: '17:00-18:30',
      source: 'LEARNED',
      learnedDays: 12,
      learnedAt: NOW.toISOString(),
    });
    const [a] = await learnedAudits();
    expect(a).toEqual({ entity_id: P, data: { window: '17:00-18:30', validDays: 12 } });
    // Aynı gün ikinci tarama öğrenmez; ertesi gün aynı pencere denetime tekrar yazılmaz.
    await events.sweepProtection(new Date(NOW.getTime() + 60_000));
    await events.sweepProtection(new Date(NOW.getTime() + DAY));
    expect(await learnedAudits()).toHaveLength(1);
  });

  it('geçmiş 14 günü kapsamıyor veya 7 geçerli gün yok → varsayılan kalır', async () => {
    await send(P, 'w', 'HEARTBEAT', ist(0, 8, 0), WATCH);
    await send(Q, 'w', 'HEARTBEAT', ist(0, 8, 0), WATCH);
    await history(P, 10, 1); // 10 gün: 14 günlük geçmiş yok
    await history(Q, 6, 1);
    await mark(Q, 'CHARGE_START', ist(14, 17, 0)); // eski ama 7 geçerli gün yok
    await mark(Q, 'CHARGE_END', ist(14, 17, 10));
    await events.sweepProtection(NOW);
    expect(await plan(P)).toBeUndefined();
    expect(await plan(Q)).toBeUndefined();
    expect((await protection.coverage.chargingPlan(P)).source).toBe('DEFAULT');
  });

  it('aile penceresi (FAMILY) kazanır; gece penceresine taşan pencere öğrenilmez', async () => {
    await send(P, 'w', 'HEARTBEAT', ist(0, 8, 0), WATCH);
    await send(Q, 'w', 'HEARTBEAT', ist(0, 8, 0), WATCH);
    await history(P, 14, 1);
    await protection.coverage.setChargingPlan(P, { window: '20:00-21:00' }, 'fam-1', NOW);
    await history(Q, 14, 1, 22, 23); // 22:00–23:20: gece penceresiyle (22:00–08:00) kesişir
    await events.sweepProtection(NOW);
    expect(await plan(P)).toMatchObject({ window_start: '20:00', window_end: '21:00', source: 'FAMILY' });
    expect(await plan(Q)).toBeUndefined();
  });

  it('öğrenilen pencere "planlı şarj" sınıflamasında kullanılır (plan dışı boşluk değil)', async () => {
    for (const x of [P, Q]) {
      await send(x, 'p', 'HEARTBEAT', ist(0, 8, 0), PHONE);
      await send(x, 'w', 'ON_BODY', ist(0, 8, 0), WATCH);
    }
    await history(P, 14, 1);
    await events.sweepProtection(NOW);
    for (const x of [P, Q]) {
      await send(x, 'p', 'HEARTBEAT', ist(0, 17, 5), PHONE);
      await send(x, 'w', 'CHARGE_START', ist(0, 17, 10), WATCH);
    }
    const rows = await h.rows<{ id: string; gap_cause: string; gap_off_plan: boolean }>(
      'SELECT protected_person_id AS id, gap_cause, gap_off_plan FROM event.coverage_state ORDER BY 1',
    );
    // P öğrenilmiş 17:00–18:30 penceresinde şarj ediyor; Q varsayılan 19:00–21:00 dışında.
    expect(rows).toEqual([
      { id: P, gap_cause: 'CHARGING', gap_off_plan: false },
      { id: Q, gap_cause: 'CHARGING', gap_off_plan: true },
    ]);
    expect((await protection.coverage.supervisorSummary()).plannedCharging).toBe(1);
  });
});
