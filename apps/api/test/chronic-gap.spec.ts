import { randomBytes } from 'node:crypto';

import type { KafkaEnvelope, Signal, SignalSource } from '@yanimda/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '../src/common/bus';
import { FieldCipher } from '../src/common/field-cipher';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import type { EventService } from '../src/modules/event/event.service';
import { ProtectionService } from '../src/modules/event/protection.service';
import { loadRulePack } from '../src/modules/event/rules.loader';
import { ProfileService } from '../src/modules/profile/profile.service';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * docs/07 S4.10 kronik boşluk planı (T-086): 7 günde 5 kapsama boşluğundan sonra her boşlukta KAPSAMA BOŞLUĞU (P3)
 * açılmaz — kişi kronik boşluk olur, aileye bir kez F-COVERAGE-CHRONIC, operasyona bir FOLLOW_UP (P4). Kişiye özel
 * tolerans (profil PATCH coverageToleranceMin) olay eşiğini yükseltir ve dönemi bitirir. Hastanede / seyahatte modu
 * her şeyi susturur; SOS etkilenmez. Saat enjekte edilir.
 */
const P = '00000000-0000-0000-0000-0000000000d1';
const KEYS = `k1:${randomBytes(32).toString('base64')}`;
const WATCH: SignalSource = { kind: 'WEAROS_WATCH', role: 'WATCH' };
/** 2026-11-02 + gün, İstanbul saati. */
const ist = (day: number, hh: number, mm = 0) => new Date(Date.UTC(2026, 10, 2 + day, hh - 3, mm));

let h: Harness;
let events: EventService;
let protection: ProtectionService;
let profile: ProfileService;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  await h.pg.query(
    "INSERT INTO profile.protected_person (id, display_name, address_line, city) VALUES ($1, 'Ayşe', 'Gül Sok. 5', 'İstanbul')",
    [P],
  );
  events = h.events(new InMemoryTimers());
  protection = new ProtectionService(h.db, h.outbox);
  profile = new ProfileService(h.db, new FieldCipher(KEYS));
});
afterAll(async () => {
  await h.close();
});

const deliver = (kind: string, at: Date) =>
  bus.deliver<Signal>('signal.received', {
    payload: sig(kind, {
      protectedPersonId: P,
      deviceId: 'watch',
      occurredAt: at.toISOString(),
      source: WATCH,
      device: { connectivity: 'LTE' },
    }),
  } as unknown as KafkaEnvelope<Signal>);
/** Gün `day`: saat 10:00'da takılı görülür, sonra susar (telefon yok → YOK); `sweeps` dakikalarında tarama. */
async function gapDay(day: number, sweeps = [20, 85]) {
  await deliver('ON_BODY', ist(day, 10));
  for (const m of sweeps) await events.sweepProtection(new Date(ist(day, 10).getTime() + m * 60_000));
}
const gapEvents = async () => (await events.all()).filter((e) => e.type === 'COVERAGE_GAP');
const followUps = async () => (await events.all()).filter((e) => e.type === 'FOLLOW_UP');
const notices = async (code: string) =>
  h.rows<{ envelope: { payload: { audience: string; vars?: Record<string, number> } } }>(
    "SELECT envelope FROM event.outbox WHERE topic = 'notify.requested' AND envelope->'payload'->>'code' = $1",
    [code],
  );
const gaps = () =>
  h.rows<{ at: Date; chronic: boolean }>(
    'SELECT at, chronic FROM event.coverage_gap WHERE protected_person_id = $1 ORDER BY at',
    [P],
  );

describe('S4.10 kronik boşluk', () => {
  it('kural paketi: 7 günde 5 boşluk, tolerans üst sınırı 240 dk, amir listesi %80', () => {
    expect(loadRulePack().chronicGap).toEqual({ gaps: 5, days: 7, toleranceMaxMin: 240, protectedPct: 80 });
  });

  it('5. boşlukta P3 yerine kronik işaret + aileye bir bildirim + bir FOLLOW_UP; sonraki boşluk sessiz; SOS çalışır', async () => {
    for (let d = 0; d < 4; d++) await gapDay(d);
    expect(await gapEvents()).toHaveLength(4); // her gün bir P3 (ertesi gün kapsama dönünce kapanır)
    expect((await gapEvents()).filter((e) => e.state !== 'CLOSED')).toHaveLength(1);
    await gapDay(4);
    expect(await gapEvents()).toHaveLength(4);
    const [fu] = await followUps();
    expect(fu).toMatchObject({ priority: 4 });
    expect((await events.get(fu!.id)).transitions[0]).toMatchObject({ to: 'CREATED', note: 'COVERAGE_CHRONIC' });
    const sent = await notices('F-COVERAGE-CHRONIC');
    expect(sent.map((x) => x.envelope.payload)).toEqual([
      expect.objectContaining({ audience: 'FAMILY', vars: { n: 5, days: 7 } }),
    ]);
    expect((await protection.coverage.view(P, ist(4, 12))).chronicGap).toEqual({ since: ist(4, 11, 25).toISOString() });

    await gapDay(5);
    expect(await gapEvents()).toHaveLength(4);
    expect(await followUps()).toHaveLength(1);
    expect(await notices('F-COVERAGE-CHRONIC')).toHaveLength(1);
    expect((await gaps()).map((g) => g.chronic)).toEqual([false, false, false, false, true, true]);

    await deliver('SOS', ist(5, 13));
    expect((await events.all()).some((e) => e.type === 'SOS' && e.priority === 1)).toBe(true);
  });

  it('kişiye özel tolerans: dönem biter, olay eşiği 60 → 90 dk; profil görünümünde', async () => {
    for (let d = 0; d < 5; d++) await gapDay(d);
    expect((await protection.coverage.view(P, ist(5, 9))).chronicGap).not.toBeNull();
    const v = await profile.update({ kind: 'ADMIN' }, P, { coverageToleranceMin: 30 }, ist(5, 9));
    expect(v.coverageToleranceMin).toBe(30);
    expect(await protection.coverage.view(P, ist(5, 9))).toMatchObject({ chronicGap: null, toleranceMin: 30 });
    await expect(profile.update({ kind: 'ADMIN' }, P, { coverageToleranceMin: 241 })).rejects.toMatchObject({
      status: 400,
    });

    await gapDay(5, [20, 85]); // YOK 65 dk < 60 + 30
    expect((await gaps()).filter((g) => g.at >= ist(5, 0))).toEqual([]);
    await events.sweepProtection(new Date(ist(5, 10).getTime() + 115 * 60_000)); // 95 dk
    const after = (await gaps()).filter((g) => g.at >= ist(5, 0));
    expect(after).toEqual([{ at: new Date(ist(5, 10).getTime() + 115 * 60_000), chronic: false }]);
    // Sayım temizlenmeden sonra yeniden başladı: P3 istendi (açık FOLLOW_UP'a eklenir).
    const fu = (await followUps())[0]!;
    expect((await events.get(fu.id)).sourceSignalIds.some((x) => x.startsWith('coverage-none:'))).toBe(true);
  });

  it('hastanede / seyahatte modunda boşluk sayılmaz; hold geçmişe yazılır', async () => {
    await gapDay(0);
    await h.pg.query("UPDATE profile.protected_person SET hold_mode = 'HOSPITAL', hold_until = $2 WHERE id = $1", [
      P,
      ist(9, 0).toISOString(),
    ]);
    for (let d = 1; d < 7; d++) await gapDay(d);
    expect(await gaps()).toHaveLength(1);
    expect(await followUps()).toEqual([]);
    const hist = await h.rows<{ level: string; reasons: string[] }>(
      'SELECT level, reasons FROM event.coverage_history WHERE protected_person_id = $1 ORDER BY id',
      [P],
    );
    expect(hist.some((x) => x.reasons.includes('ON_HOLD'))).toBe(true);
  });
});
