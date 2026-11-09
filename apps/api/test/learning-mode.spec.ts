import { randomBytes } from 'node:crypto';

import type { KafkaEnvelope, Signal } from '@yanimda/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '../src/common/bus';
import { FieldCipher } from '../src/common/field-cipher';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { signal } from '../src/db/schema';
import type { EventService } from '../src/modules/event/event.service';
import { ProtectionService } from '../src/modules/event/protection.service';
import { LearningService } from '../src/modules/learning/learning.service';
import type { Actor } from '../src/modules/profile/contacts';
import { ProfileService } from '../src/modules/profile/profile.service';
import { createHarness, type Harness, sig } from './support/harness';
import { DAY, ist, type Persona, synth } from './support/synthetic';

/**
 * T-070 (D-06) öğrenme modu. Kabul: sentetik 30 günlük veriyle eşikler beklenen aralıkta; aile override korunur.
 * Ek: kişi oluşturulunca +30 gün; öğrenme modunda INACTIVITY operatöre düşmeden önce 2. sessiz soru (SOS/FALL
 * değişmez); dönem sonunda aileye bir kez profil raporu.
 */
const ALICE: Actor = { kind: 'FAMILY', id: 'fam-alice' };
const BOB: Actor = { kind: 'FAMILY', id: 'fam-bob' };
const KEYS = `k1:${randomBytes(32).toString('base64')}`;

let h: Harness;
let profile: ProfileService;
let learning: LearningService;
let protection: ProtectionService;
let timers: InMemoryTimers;
let events: EventService;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  profile = new ProfileService(h.db, new FieldCipher(KEYS), undefined, null);
  learning = new LearningService(h.db, h.outbox, profile);
  protection = new ProtectionService(h.db, h.outbox);
  timers = new InMemoryTimers();
  events = h.events(timers);
});
afterAll(async () => {
  await h.close();
});

const regular: Persona = {
  wake: [6, 50],
  bed: [22, 30],
  rests: [
    [10, 25],
    [14, 40],
    [19, 30],
  ],
  stepEveryMin: 5,
};
/** Kişiyi `created` anında oluşturur (öğrenme modu oradan +30 gün). */
const person = async (created: Date) => (await profile.create(ALICE, { displayName: 'Ayşe Y.' }, created)).id;
async function seed(personId: string, p: Persona = regular, days = 30) {
  const rows = synth(p, days).map((s, i) => ({
    time: s.at,
    deviceId: 'watch-1',
    protectedPersonId: personId,
    kind: s.kind,
    value: s.value,
    payload: {},
    idempotencyKey: `syn:${personId}:${i}`,
  }));
  for (let i = 0; i < rows.length; i += 1000) await h.db.insert(signal).values(rows.slice(i, i + 1000));
}
const thresholdRow = async (id: string) =>
  (
    await h.rows<Record<string, unknown>>(
      'SELECT sleep_start::text, sleep_end::text, inactivity_min, sleep_source, inactivity_source, learned_days, report_sent_at FROM event.threshold WHERE protected_person_id = $1',
      [id],
    )
  )[0];
const notices = async (code: string) =>
  (
    await h.rows<{ envelope: { payload: { code: string; audience: string; vars?: Record<string, unknown> } } }>(
      "SELECT envelope FROM event.outbox WHERE topic = 'notify.requested' ORDER BY id",
    )
  )
    .map((r) => r.envelope.payload)
    .filter((p) => p.code === code);
const deliver = (s: ReturnType<typeof sig>) =>
  bus.deliver<Signal>('signal.received', { payload: s } as unknown as KafkaEnvelope<Signal>);
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

describe('Kişi oluşturma', () => {
  it('learning_mode_until = oluşturma + 30 gün (kural paketi learning.days)', async () => {
    const at = new Date('2026-11-01T09:00:00Z');
    const p = await profile.create(ALICE, { displayName: 'Ayşe Y.' }, at);
    expect(p.learningModeUntil).toBe(new Date(at.getTime() + 30 * DAY).toISOString());
  });
});

describe('Günlük öğrenme işi (sentetik 30 gün)', () => {
  it('eşikler beklenen aralıkta; olay motoru kişiye özel eşiği kullanır', async () => {
    const id = await person(ist(0, 6));
    await seed(id);
    const r = await learning.runDue(ist(29, 12));
    expect(r).toEqual({ learned: 1, reported: 0 });
    const row = (await thresholdRow(id))!;
    expect(row).toMatchObject({ sleep_source: 'LEARNED', inactivity_source: 'LEARNED' });
    expect(minutes(row.sleep_start as string)).toBeGreaterThanOrEqual(22 * 60 + 30);
    expect(minutes(row.sleep_end as string)).toBeGreaterThanOrEqual(6 * 60 + 30);
    expect(minutes(row.sleep_end as string)).toBeLessThanOrEqual(7 * 60 + 15);
    const learned = row.inactivity_min as number;
    expect(learned).toBeGreaterThanOrEqual(35);
    expect(learned).toBeLessThanOrEqual(55);
    expect(row.learned_days).toBeGreaterThanOrEqual(13);

    const s = await protection.settingsOf(id);
    expect(s).toMatchObject({ inactivityMin: learned, start: (row.sleep_start as string).slice(0, 5) });

    // INACTIVITY değeri öğrenilmiş eşiğin altında → olay yok; üstünde → olay.
    await deliver(sig('INACTIVITY', { protectedPersonId: id, value: learned - 1 }));
    expect(await events.all()).toEqual([]);
    await deliver(sig('INACTIVITY', { protectedPersonId: id, value: learned }));
    expect(await events.all()).toHaveLength(1);
  });

  it('aynı gün ikinci tarama tekrar öğrenmez; ertesi gün öğrenir', async () => {
    const id = await person(ist(0, 6));
    await seed(id);
    expect((await learning.runDue(ist(20, 12))).learned).toBe(1);
    expect((await learning.runDue(ist(20, 18))).learned).toBe(0);
    expect((await learning.runDue(ist(21, 12))).learned).toBe(1);
  });

  it('aile override korunur: aile ayarladığı alan öğrenmeyle değişmez, diğeri öğrenilir; null → öğrenmeye döner', async () => {
    const id = await person(ist(5, 6)); // öğrenme modu 35. güne kadar
    await seed(id);
    await learning.setThresholds(ALICE, id, { inactivityMin: 60 });
    await learning.runDue(ist(29, 12));
    let row = (await thresholdRow(id))!;
    expect(row).toMatchObject({ inactivity_min: 60, inactivity_source: 'FAMILY', sleep_source: 'LEARNED' });

    await learning.setThresholds(ALICE, id, { sleepWindow: { start: '21:30', end: '06:00' } });
    await learning.runDue(ist(30, 12));
    row = (await thresholdRow(id))!;
    expect(row).toMatchObject({ sleep_start: '21:30:00', sleep_end: '06:00:00', sleep_source: 'FAMILY' });
    expect(row.inactivity_min).toBe(60);

    const sum = await learning.setThresholds(ALICE, id, { inactivityMin: null });
    expect(sum.inactivity).toMatchObject({ minutes: 30, source: 'DEFAULT' });
    await learning.runDue(ist(31, 12));
    expect((await thresholdRow(id))!.inactivity_source).toBe('LEARNED');
  });

  it('aile eşik ayarı doğrulanır; başka ailenin kişisi 404', async () => {
    const id = await person(new Date());
    const status = (p: Promise<unknown>) => p.then(() => 200).catch((e: { status?: number }) => e.status);
    expect(await status(learning.setThresholds(ALICE, id, { inactivityMin: 5 }))).toBe(400);
    expect(await status(learning.setThresholds(ALICE, id, { inactivityMin: 91 }))).toBe(400);
    expect(await status(learning.setThresholds(ALICE, id, { sleepWindow: { start: '25:00', end: '07:00' } }))).toBe(
      400,
    );
    expect(await status(learning.setThresholds(ALICE, id, {}))).toBe(400);
    expect(await status(learning.setThresholds(BOB, id, { inactivityMin: 45 }))).toBe(404);
    expect(await status(learning.summary(BOB, id))).toBe(404);
    expect(await status(learning.setThresholds(ALICE, id, { inactivityMin: 45 }))).toBe(200);
  });

  it('veri yoksa varsayılanlar kalır', async () => {
    const id = await person(ist(0, 6));
    await learning.runDue(ist(10, 12));
    expect(await thresholdRow(id)).toMatchObject({
      sleep_start: '22:00:00',
      sleep_end: '08:00:00',
      inactivity_min: null,
      sleep_source: 'DEFAULT',
      learned_days: 0,
    });
  });
});

describe('Dönem sonu profil raporu', () => {
  it('30. gün aileye F-LEARN-REPORT bir kez; özet uçta rapor zamanı ve eşikler', async () => {
    const id = await person(ist(0, 6));
    await seed(id);
    expect((await learning.runDue(ist(29, 12))).reported).toBe(0);
    expect(await learning.runDue(ist(30, 7))).toEqual({ learned: 1, reported: 1 });
    expect(await learning.runDue(ist(31, 7))).toEqual({ learned: 0, reported: 0 });
    const sent = await notices('F-LEARN-REPORT');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ audience: 'FAMILY' });
    expect(Object.keys(sent[0]!.vars!).sort()).toEqual(['inactivityMin', 'sleepEnd', 'sleepStart']);

    const sum = await learning.summary(ALICE, id, ist(31, 7));
    expect(sum.learningMode.active).toBe(false);
    expect(sum.reportSentAt).not.toBeNull();
    expect(sum.sleepWindow.source).toBe('LEARNED');
    expect(sum.inactivity).toMatchObject({ source: 'LEARNED', default: 30, min: 15, max: 90 });
    expect(sent[0]!.vars).toMatchObject({ inactivityMin: sum.inactivity.minutes, sleepStart: sum.sleepWindow.start });
  });
});

describe('Öğrenme modunda INACTIVITY: operatöre düşmeden önce 2. sessiz soru', () => {
  const only = async () => {
    const all = await events.all();
    expect(all).toHaveLength(1);
    return events.get(all[0]!.id);
  };

  it('1. soru cevapsız → 2. sessiz soru (cihaza W-INACT-1); o da cevapsız → kuyruk', async () => {
    const id = await person(new Date());
    await deliver(sig('INACTIVITY', { protectedPersonId: id }));
    const ev = await only();
    await timers.fire(ev.id, 'silent-ask-expire');
    const again = await only();
    expect(again.state).toBe('DEVICE_PROMPT');
    expect(new Date(again.devicePromptUntil!).getTime()).toBeGreaterThan(Date.now() + 100_000);
    expect(timers.pendingIds()).toEqual([`${ev.id}.learning-ask-expire`]);
    expect(await notices('W-INACT-1')).toEqual([expect.objectContaining({ audience: 'ELDER' })]);

    await timers.fire(ev.id, 'learning-ask-expire');
    const queued = await only();
    expect(queued.state).toBe('OPERATOR_QUEUE');
    expect(queued.transitions.find((t) => t.to === 'ESCALATED')!.note).toBe('2. sessiz soru cevapsız');
  });

  it('2. soruya cevap (OK) → yanlış alarm olarak kapanır, zamanlayıcı silinir', async () => {
    const id = await person(new Date());
    await deliver(sig('INACTIVITY', { protectedPersonId: id }));
    const ev = await only();
    await timers.fire(ev.id, 'silent-ask-expire');
    await deliver(sig('OK', { protectedPersonId: id }));
    expect((await only()).state).toBe('CLOSED');
    expect(timers.pendingIds()).toEqual([]);
  });

  it('öğrenme modu bitmişse 1. soru cevapsız → doğrudan kuyruk', async () => {
    const id = await person(new Date(Date.now() - 31 * DAY));
    await deliver(sig('INACTIVITY', { protectedPersonId: id }));
    const ev = await only();
    await timers.fire(ev.id, 'silent-ask-expire');
    expect((await only()).state).toBe('OPERATOR_QUEUE');
    expect(await notices('W-INACT-1')).toEqual([]);
  });

  it('FALL öğrenme modunda değişmez: soru cevapsız → kuyruk', async () => {
    const id = await person(new Date());
    await deliver(sig('FALL', { protectedPersonId: id }));
    const ev = await only();
    await timers.fire(ev.id, 'prompt-expire');
    expect((await only()).state).toBe('OPERATOR_QUEUE');
  });
});
