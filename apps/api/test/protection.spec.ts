import type { KafkaEnvelope, ProtectionState, Signal } from '@yanimda/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '../src/common/bus';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import type { EventService } from '../src/modules/event/event.service';
import { computeProtection, type ProtectionFacts } from '../src/modules/event/protection';
import { ProtectionService } from '../src/modules/event/protection.service';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * T-014 · D-05 Koruma durumu ve gece penceresi. Kabul:
 *  - saat dilimi testi (Europe/Istanbul, America/New_York)
 *  - OFF_BODY 23:00 → NIGHT, 14:00 → PROTECTED_PHONE
 *  - her değişiklik outbox user.protection.changed
 *  - GET /v1/protected-persons/{id}/status
 */
const IST = { timezone: 'Europe/Istanbul', start: '22:00', end: '08:00' };
const NY = { timezone: 'America/New_York', start: '22:00', end: '08:00' };
const at = (iso: string) => new Date(iso);
const min = (d: Date, m: number) => new Date(d.getTime() - m * 60_000);

describe('computeProtection (saf kural)', () => {
  const t14 = at('2026-11-08T11:00:00Z'); // 14:00 İstanbul
  const t23 = at('2026-11-08T20:00:00Z'); // 23:00 İstanbul
  const facts = (f: Partial<ProtectionFacts>, now: Date): ProtectionFacts => ({
    watchOnWrist: null,
    watchSeenAt: now,
    phoneSeenAt: now,
    ...f,
  });
  const table: [string, Partial<ProtectionFacts>, Date, ProtectionState][] = [
    ['saat bilekte, bağlı (gündüz)', { watchOnWrist: true }, t14, 'PROTECTED_WATCH'],
    ['saat bilekte, bağlı (gece) — gece de saat korur', { watchOnWrist: true }, t23, 'PROTECTED_WATCH'],
    ['saat çıkarıldı 14:00, telefon var', { watchOnWrist: false }, t14, 'PROTECTED_PHONE'],
    ['saat çıkarıldı 23:00', { watchOnWrist: false }, t23, 'NIGHT'],
    ['saat çıkarıldı 14:00, telefon yok', { watchOnWrist: false, phoneSeenAt: null }, t14, 'UNPROTECTED'],
    [
      'saat çıkarıldı 14:00, telefon 20 dk sessiz',
      { watchOnWrist: false, phoneSeenAt: min(t14, 20) },
      t14,
      'UNPROTECTED',
    ],
    [
      'saat bilekte ama 20 dk sessiz, telefon var',
      { watchOnWrist: true, watchSeenAt: min(t14, 20) },
      t14,
      'PROTECTED_PHONE',
    ],
    [
      'saat ve telefon sessiz (gündüz)',
      { watchOnWrist: true, watchSeenAt: min(t14, 20), phoneSeenAt: null },
      t14,
      'UNPROTECTED',
    ],
    [
      'saat ve telefon sessiz (gece)',
      { watchOnWrist: true, watchSeenAt: min(t23, 20), phoneSeenAt: null },
      t23,
      'NIGHT',
    ],
    ['bilek bilgisi yok (gündüz, telefon var)', { watchOnWrist: null }, t14, 'PROTECTED_PHONE'],
  ];
  it.each(table)('%s → %s', (_name, f, now, expected) => {
    expect(computeProtection(facts(f, now), now, IST).state).toBe(expected);
  });

  it('New York saat diliminde 23:00 → NIGHT, 14:00 → PROTECTED_PHONE', () => {
    const ny23 = at('2026-11-09T04:00:00Z');
    const ny14 = at('2026-11-08T19:00:00Z');
    expect(computeProtection(facts({ watchOnWrist: false }, ny23), ny23, NY).state).toBe('NIGHT');
    expect(computeProtection(facts({ watchOnWrist: false }, ny14), ny14, NY).state).toBe('PROTECTED_PHONE');
    // aynı anlar İstanbul'da ters: 04:00Z = 07:00 (gece), 19:00Z = 22:00 (gece)
    expect(computeProtection(facts({ watchOnWrist: false }, ny14), ny14, IST).state).toBe('NIGHT');
  });
});

let h: Harness;
let events: EventService;
let protection: ProtectionService;
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
const ble = (onWrist?: boolean) => ({ device: { connectivity: 'BLE', ...(onWrist === undefined ? {} : { onWrist }) } });
const stateOf = async (p = 'pp-1') =>
  (await h.rows<{ state: string }>('SELECT state FROM event.protection_state WHERE protected_person_id = $1', [p]))[0]
    ?.state;
const changes = async () =>
  (
    await h.rows<{ envelope: { payload: { from: string | null; to: string } } }>(
      "SELECT envelope FROM event.outbox WHERE topic = 'user.protection.changed' ORDER BY id",
    )
  ).map((r) => `${r.envelope.payload.from}→${r.envelope.payload.to}`);

describe('Sinyallerle koruma durumu (kabul)', () => {
  it('OFF_BODY 23:00 (İstanbul) → NIGHT', async () => {
    await deliver(sig('OFF_BODY', { occurredAt: '2026-11-08T20:00:00Z', ...ble(false) }));
    expect(await stateOf()).toBe('NIGHT');
  });

  it('OFF_BODY 14:00 (İstanbul) → PROTECTED_PHONE', async () => {
    await deliver(sig('OFF_BODY', { occurredAt: '2026-11-08T11:00:00Z', ...ble(false) }));
    expect(await stateOf()).toBe('PROTECTED_PHONE');
  });

  it('OFF_BODY 23:00 (New York) → NIGHT, 14:00 → PROTECTED_PHONE', async () => {
    await h.pg.exec(`INSERT INTO profile.protected_person (id, display_name, timezone)
      VALUES ('00000000-0000-0000-0000-0000000000aa', 'NY', 'America/New_York')`);
    const p = '00000000-0000-0000-0000-0000000000aa';
    await deliver(sig('OFF_BODY', { protectedPersonId: p, occurredAt: '2026-11-09T04:00:00Z', ...ble(false) }));
    expect(await stateOf(p)).toBe('NIGHT');
    await deliver(sig('OFF_BODY', { protectedPersonId: p, occurredAt: '2026-11-09T19:00:00Z', ...ble(false) }));
    expect(await stateOf(p)).toBe('PROTECTED_PHONE');
  });

  it('ON_BODY → PROTECTED_WATCH', async () => {
    await deliver(sig('ON_BODY', { occurredAt: '2026-11-08T11:00:00Z', ...ble() }));
    expect(await stateOf()).toBe('PROTECTED_WATCH');
  });

  it('kişiye özel gece penceresi (event.threshold) kullanılır', async () => {
    await h.pg.exec(
      "INSERT INTO event.threshold (protected_person_id, sleep_start, sleep_end) VALUES ('pp-1', '13:00', '15:00')",
    );
    await deliver(sig('OFF_BODY', { occurredAt: '2026-11-08T11:00:00Z', ...ble(false) })); // 14:00 İstanbul
    expect(await stateOf()).toBe('NIGHT');
  });

  it('her değişiklik user.protection.changed yazar; değişiklik yoksa yazmaz', async () => {
    await deliver(sig('ON_BODY', { occurredAt: '2026-11-08T10:00:00Z', ...ble() }));
    await deliver(sig('HEARTBEAT', { occurredAt: '2026-11-08T10:05:00Z', ...ble(true) }));
    await deliver(sig('OFF_BODY', { occurredAt: '2026-11-08T11:00:00Z', ...ble(false) }));
    await deliver(sig('OFF_BODY', { occurredAt: '2026-11-08T20:00:00Z', ...ble(false) }));
    expect(await changes()).toEqual([
      'null→PROTECTED_WATCH',
      'PROTECTED_WATCH→PROTECTED_PHONE',
      'PROTECTED_PHONE→NIGHT',
    ]);
  });

  it('geç gelen eski sinyal yeni durumu ezmez', async () => {
    await deliver(sig('ON_BODY', { occurredAt: '2026-11-08T11:00:00Z', ...ble() }));
    await deliver(sig('OFF_BODY', { occurredAt: '2026-11-08T10:00:00Z', ...ble(false) })); // tampondan geç geldi
    expect(await stateOf()).toBe('PROTECTED_WATCH');
  });

  it('kayıtlı telefon cihazından gelen sinyal telefonun görüldüğünü işaretler', async () => {
    await h.pg.exec(`
      INSERT INTO profile.protected_person (id, display_name) VALUES ('00000000-0000-0000-0000-000000000001', 'demo');
      INSERT INTO device.device (id, protected_person_id, kind)
      VALUES ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-000000000001', 'ANDROID_PHONE')`);
    const p = '00000000-0000-0000-0000-000000000001';
    // saat LTE ile doğrudan (telefon köprüsü yok) çıkarıldı → telefon bilinmiyor → UNPROTECTED
    await deliver(
      sig('OFF_BODY', { protectedPersonId: p, occurredAt: '2026-11-08T11:00:00Z', device: { connectivity: 'LTE' } }),
    );
    expect(await stateOf(p)).toBe('UNPROTECTED');
    // telefon kendi heartbeat'ini gönderdi → PROTECTED_PHONE
    await deliver(
      sig('HEARTBEAT', {
        protectedPersonId: p,
        deviceId: '00000000-0000-0000-0000-00000000f001',
        occurredAt: '2026-11-08T11:01:00Z',
      }),
    );
    expect(await stateOf(p)).toBe('PROTECTED_PHONE');
  });
});

describe('Koruma taraması (zamanla değişen durum)', () => {
  it('gece biter, saat hâlâ çıkarılmış → PROTECTED_PHONE/UNPROTECTED ve sabah WATCH_OFF olayı (bir kez)', async () => {
    await deliver(sig('OFF_BODY', { occurredAt: '2026-11-08T20:00:00Z', ...ble(false) })); // 23:00 → NIGHT
    expect(await events.all()).toEqual([]); // gece olay yok
    const morning = at('2026-11-09T05:30:00Z'); // 08:30 İstanbul; telefon 9,5 saattir sessiz
    await events.sweepProtection(morning);
    expect(await stateOf()).toBe('UNPROTECTED');
    const all = await events.all();
    expect(all.map((e) => [e.type, e.state])).toEqual([['WATCH_OFF', 'DEVICE_PROMPT']]);
    await events.sweepProtection(new Date(morning.getTime() + 60_000));
    expect(await events.all()).toHaveLength(1);
  });

  it('saat bilekte ama 15 dk sessiz → telefona düşer (telefon görülüyorsa)', async () => {
    const t = at('2026-11-08T11:00:00Z');
    await deliver(sig('HEARTBEAT', { occurredAt: t.toISOString(), ...ble(true) }));
    expect(await stateOf()).toBe('PROTECTED_WATCH');
    await events.sweepProtection(new Date(t.getTime() + 16 * 60_000));
    expect(await stateOf()).toBe('UNPROTECTED'); // köprü de (telefon) aynı anda sustu
  });

  it('gece başlar, saat bilekte değil → NIGHT (olay yok)', async () => {
    await deliver(sig('OFF_BODY', { occurredAt: '2026-11-08T18:50:00Z', ...ble(false) })); // 21:50
    expect(await stateOf()).toBe('PROTECTED_PHONE');
    expect((await events.all()).map((e) => [e.type, e.state])).toEqual([['WATCH_OFF', 'DEVICE_PROMPT']]);
    await events.sweepProtection(at('2026-11-08T19:05:00Z')); // 22:05
    expect(await stateOf()).toBe('NIGHT');
    // bekleyen WATCH_OFF gece operatöre düşmesin: kapanır (sabah hâlâ çıkarılmışsa yenisi açılır)
    const [ev] = await events.all();
    expect(ev.state).toBe('CLOSED');
    expect((await events.get(ev.id)).closeReason).toBe('gece penceresi');
  });
});

describe('GET /v1/protected-persons/{id}/status', () => {
  it('durum, cihaz bağlantıları, uyku penceresi ve açık olay döner', async () => {
    const t = new Date();
    await deliver(sig('OFF_BODY', { occurredAt: t.toISOString(), ...ble(false) }));
    const st = await protection.status('pp-1', t);
    expect(st).toMatchObject({
      protectedPersonId: 'pp-1',
      watch: { onWrist: false, connection: 'ONLINE' },
      phone: { connection: 'ONLINE' },
      sleepWindow: { timezone: 'Europe/Istanbul', start: '22:00', end: '08:00' },
    });
    expect(['NIGHT', 'PROTECTED_PHONE']).toContain(st.state);
    expect(st.since).toBeTruthy();
  });

  it('bilinmeyen kişi 404', async () => {
    await expect(protection.status('yok-kisi')).rejects.toMatchObject({ status: 404 });
  });
});
