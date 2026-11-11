import type { KafkaEnvelope, Signal, SignalSource } from '@yanimda/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '../src/common/bus';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { ChainService } from '../src/modules/chain/chain.service';
import { loadProcedures } from '../src/modules/chain/procedures';
import { onHold } from '../src/modules/event/coverage';
import type { EventService } from '../src/modules/event/event.service';
import { coverageNoneOf, loadRulePack, ruleFor, staticRules } from '../src/modules/event/rules.loader';
import { WellnessService } from '../src/modules/wellness/wellness.service';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * T-087 kalan (docs/07 S4.7, S4.10, S5.4), olay motoru + PGlite. Saatler sabit test saatidir (gün içi saatten
 * bağımsız; gece penceresi 22:00–08:00 İstanbul):
 *  - YERİNDE KONTROL (P2): kapsama YOK iken takılı cihaz pili yeterliyken birden sustu → 2 sa; telefon dahil tüm
 *    cihazlar sessiz → 6 sa; kişiye "iyi" ile ulaşıldıysa açılmaz; açık KAPSAMA BOŞLUĞU yükseltilir; kişi başına bir
 *  - yanınızdayız araması iki denemede cevapsız + 24 sa hareket yok → YERİNDE KONTROL
 *  - "hastanede / seyahatte" modu: ON_HOLD nedeni; hatırlatma, sesli arama, aile, boşluk, yerinde kontrol ve "saat
 *    çıkarıldı" yok; bekleyen boşluk kapanır; SOS ve düşme çalışır; mod bitince sayım o andan başlar
 */
const P = '0190c000-0000-7000-8000-0000000000a1';
const T14 = new Date('2026-11-09T11:00:00Z'); // 14:00 İstanbul
const t = (base: Date, min: number) => new Date(base.getTime() + min * 60_000);
const WATCH: SignalSource = { kind: 'WEAROS_WATCH', role: 'WATCH' };
const pack = loadRulePack('TR');

let h: Harness;
let events: EventService;
let clock: Date | null = null;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  await h.pg.query(`INSERT INTO profile.protected_person (id, display_name) VALUES ($1, 'Ayşe')`, [P]);
  events = h.events(new InMemoryTimers());
  clock = null;
});
afterAll(async () => {
  await h.close();
});

const deliver = (s: ReturnType<typeof sig>) =>
  bus.deliver<Signal>('signal.received', { payload: s } as unknown as KafkaEnvelope<Signal>);
/** Test saati: adımlar arasında 10 dk'da bir tarama (gerçekçi). */
const step = async (at: Date) => {
  if (clock) for (let x = t(clock, 10); x < at; x = t(x, 10)) await events.sweepProtection(x);
  clock = at;
  await events.sweepProtection(at);
};
const send = async (kind: string, at: Date, extra: Record<string, unknown> = {}) => {
  await step(at);
  await deliver(sig(kind, { protectedPersonId: P, deviceId: 'watch', occurredAt: at.toISOString(), ...extra }));
};
/** Takılı LTE saat (telefon yok): susunca kapsama YOK. */
const wornWatch = (at: Date, batteryPct: number) =>
  send('ON_BODY', at, { source: WATCH, device: { connectivity: 'LTE', onWrist: true, batteryPct } });
const notices = async () =>
  (
    await h.rows<{ envelope: { payload: { code: string } } }>(
      "SELECT envelope FROM event.outbox WHERE topic = 'notify.requested' ORDER BY id",
    )
  ).map((r) => r.envelope.payload.code);
const all = async () => Promise.all((await events.all()).map((e) => events.get(e.id)));
const open = async () => (await all()).filter((e) => e.state !== 'CLOSED');
const welfareAudit = (id: string) =>
  h.rows<{ data: { reason: string } }>(
    "SELECT data FROM audit.log WHERE action = 'event.welfare_raised' AND entity_id = $1",
    [id],
  );
const reasons = async () =>
  (
    await h.rows<{ reasons: string[] }>('SELECT reasons FROM event.coverage_state WHERE protected_person_id = $1', [P])
  )[0]?.reasons;
const hold = (until: Date | null) =>
  h.pg.query(`UPDATE profile.protected_person SET hold_mode = $2, hold_until = $3 WHERE id = $1`, [
    P,
    until ? 'HOSPITAL' : null,
    until,
  ]);

describe('kural paketi (S4.7, S5.4)', () => {
  it('YERİNDE KONTROL eşikleri ve merdiveni: P2, telefon → yakınlar → anahtar sahibi; 112 adımı yok', () => {
    expect(coverageNoneOf(pack)).toMatchObject({ welfareDroppedH: 2, welfareSilentH: 6, welfareNoMovementH: 24 });
    const r = ruleFor(pack, 'WELFARE_CHECK')!;
    expect(r).toMatchObject({ priority: 2, operatorScript: 'O-SCRIPT-WELFARE' });
    expect(r.chain).toEqual(['CALL_PHONE', 'CALL_CONTACT:1', 'CALL_CONTACT:2', 'CALL_KEY_HOLDER']);
    expect(r.devicePrompt).toBeUndefined();
    expect(r.autoVoiceScreening).toBeUndefined();
    expect(pack.call112DeadlineSec?.WELFARE_CHECK).toBeUndefined();
    expect(pack.version).toBeGreaterThanOrEqual(5);
  });
});

describe('YERİNDE KONTROL (S4.7)', () => {
  it('takılı saat pili %80 iken birden sustu: 60 dk KAPSAMA BOŞLUĞU, 2 sa YERİNDE KONTROL (P2) — olay yükseltilir', async () => {
    await wornWatch(T14, 80);
    await step(t(T14, 16)); // saat 15 dk sessiz → YOK (boşluk başı)
    await step(t(T14, 76));
    const [gap] = await open();
    expect(gap).toMatchObject({ type: 'COVERAGE_GAP', priority: 3, state: 'OPERATOR_QUEUE' });
    await step(t(T14, 135));
    expect((await events.get(gap!.id)).type).toBe('COVERAGE_GAP');
    await step(t(T14, 136)); // 16 + 120 uyanık dk
    await step(t(T14, 146)); // tekrar ayıklanır
    const list = await all();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: gap!.id, type: 'WELFARE_CHECK', priority: 2, state: 'OPERATOR_QUEUE' });
    expect(list[0]!.sourceSignalIds).toEqual(expect.arrayContaining([expect.stringMatching(/^welfare:/)]));
    expect((await welfareAudit(gap!.id)).map((a) => a.data.reason)).toEqual(['DEVICE_DROPPED']);
    // Konsol: neden ve 112 son sınırı yok (operatör kararı).
    const chain = new ChainService(h.db, events, loadProcedures('TR'), undefined, undefined, staticRules(pack));
    const v = await chain.claim(gap!.id, 'op-1');
    expect(v.ladder).toMatchObject({ welfareReason: 'DEVICE_DROPPED', call112DeadlineSec: null });
    expect(v.chain!.steps.map((s) => s.kind)).toEqual([
      'CALL_PHONE',
      'CALL_CONTACT',
      'CALL_CONTACT',
      'CALL_KEY_HOLDER',
    ]);
  });

  it('pili düşük (≤%20) saat sustu: 2 sa değil, telefon dahil tüm cihazlar 6 sa sessizse; operatör ulaşamadıysa yeni olay', async () => {
    await wornWatch(T14, 15);
    await step(t(T14, 16));
    await step(t(T14, 76));
    const [gap] = await open();
    await events.claim(gap!.id, 'op-1');
    await events.closeByOperator(gap!.id, 'op-1', 'UNREACHABLE');
    await step(t(T14, 200));
    expect(await open()).toEqual([]);
    await step(t(T14, 375));
    expect(await open()).toEqual([]);
    await step(t(T14, 376)); // 16 + 360
    await step(t(T14, 386));
    const [w] = await open();
    expect(w).toMatchObject({ type: 'WELFARE_CHECK', priority: 2, state: 'OPERATOR_QUEUE' });
    expect(w!.transitions[0]).toMatchObject({ to: 'CREATED', note: 'ALL_SILENT' });
    expect((await all()).filter((e) => e.type === 'WELFARE_CHECK')).toHaveLength(1);
  });

  it('boşluk başından beri kişiye ulaşılıp "iyi" dendiyse YERİNDE KONTROL açılmaz', async () => {
    await wornWatch(T14, 80);
    await step(t(T14, 16));
    await step(t(T14, 76));
    const [gap] = await open();
    await events.claim(gap!.id, 'op-1');
    await events.closeByOperator(gap!.id, 'op-1', 'OK');
    await step(t(T14, 400));
    expect(await open()).toEqual([]);
    expect((await all()).map((e) => e.type)).toEqual(['COVERAGE_GAP']);
  });

  it('cihaz geri gelirse sayım biter: yerinde kontrol açılmaz', async () => {
    await wornWatch(T14, 80);
    await step(t(T14, 16));
    await send('HEARTBEAT', t(T14, 100), { source: WATCH, device: { connectivity: 'LTE', onWrist: true } });
    await step(t(T14, 140));
    expect((await all()).map((e) => e.type)).toEqual(['COVERAGE_GAP']);
    expect(await open()).toEqual([]); // kapsama geri gelince sistem kapattı
  });
});

describe('Yanınızdayız araması cevapsız + 24 sa hareket yok (S5.4)', () => {
  const insertMissed = (completedAt: Date) =>
    h.pg.query(
      `INSERT INTO event.check_call (id, protected_person_id, due_at, window_until, channel, status, completed_at,
                                     outcome, attempts)
       VALUES (gen_random_uuid(), $1, $2, $2, 'CALL', 'MISSED', $2, 'UNREACHABLE', 1)`,
      [P, completedAt],
    );
  const movement = (kind: string, at: Date, value: number | null = null) =>
    h.pg.query(
      `INSERT INTO signal.signal (time, device_id, protected_person_id, kind, value, payload, idempotency_key)
       VALUES ($1, 'watch', $2, $3, $4, '{}', gen_random_uuid()::text)`,
      [at, P, kind, value],
    );

  it('hareket yoksa YERİNDE KONTROL (NO_MOVEMENT), dönem başına bir; adım / takma hareket sayılır', async () => {
    const wellness = new WellnessService(h.db, h.outbox, events, undefined, staticRules(pack));
    const now = new Date();
    await insertMissed(t(now, -60));
    await movement('HEARTBEAT', t(now, -30)); // cihaz canlı ama hareket değil
    await movement('STEPS', t(now, -20), 0);
    expect(await wellness.welfareSweep(now)).toBe(1);
    expect(await wellness.welfareSweep(t(now, 1))).toBe(0);
    const [w] = await open();
    expect(w).toMatchObject({ type: 'WELFARE_CHECK', priority: 2, state: 'OPERATOR_QUEUE' });
    expect(w!.transitions[0]!.note).toBe('NO_MOVEMENT');
    expect(w!.sourceSignalIds[0]).toMatch(/^welfare-wellness:/);

    await h.reset();
    await h.pg.query(`INSERT INTO profile.protected_person (id, display_name) VALUES ($1, 'Ayşe')`, [P]);
    events = h.events(new InMemoryTimers());
    const w2 = new WellnessService(h.db, h.outbox, events, undefined, staticRules(pack));
    await insertMissed(t(now, -60));
    await movement('STEPS', t(now, -23 * 60), 120); // 23 sa önce yürüdü
    expect(await w2.welfareSweep(now)).toBe(0);
    await insertMissed(t(now, -25 * 60)); // 24 sa'ten eski kaçırma bakılmaz
    expect(await w2.welfareSweep(t(now, 2 * 60))).toBe(1); // hareketin üzerinden 25 sa geçti
  });
});

describe('Hastanede / seyahatte modu (S4.10)', () => {
  it('ON_HOLD: hatırlatma, sesli arama, aile, boşluk ve yerinde kontrol yok; "saat çıkarıldı" açılmaz; SOS ve düşme çalışır', async () => {
    await hold(new Date(Date.now() + 86_400_000));
    await wornWatch(T14, 80);
    expect(await reasons()).toContain('ON_HOLD');
    await step(t(T14, 16));
    await step(t(T14, 400));
    expect(await notices()).toEqual([]);
    expect(await all()).toEqual([]);
    await send('OFF_BODY', t(T14, 401), { source: WATCH, device: { connectivity: 'LTE' } });
    expect(await all()).toEqual([]);
    const [a] = await h.rows<{ data: unknown }>("SELECT data FROM audit.log WHERE action = 'event.suppressed'");
    expect(a!.data).toEqual({ type: 'WATCH_OFF', reason: 'ON_HOLD' });
    await send('FALL', t(T14, 402), { source: WATCH });
    await send('SOS', t(T14, 403), { source: WATCH });
    expect((await open()).map((e) => [e.type, e.priority])).toEqual([['FALL', 1]]); // SOS düşme olayına eklendi
  });

  it('mod açılınca bekleyen KAPSAMA BOŞLUĞU kapanır (aileye "geri geldi" gitmez); bitince sayım o andan başlar', async () => {
    await wornWatch(T14, 80);
    await step(t(T14, 16));
    await step(t(T14, 76));
    const [gap] = await open();
    expect(gap!.type).toBe('COVERAGE_GAP');
    const sent = (await notices()).length;
    await hold(new Date(Date.now() + 86_400_000));
    await step(t(T14, 86));
    expect(await events.get(gap!.id)).toMatchObject({ state: 'CLOSED', closeReason: 'hastanede / seyahatte modu' });
    expect((await notices()).length).toBe(sent);
    // Mod bitti (bitiş geçmişte): sayım bitişten başlar.
    await hold(t(T14, 90));
    await step(t(T14, 90)); // yeni boşluk başı
    await step(t(T14, 109));
    expect((await notices()).length).toBe(sent);
    await step(t(T14, 110));
    expect((await notices()).slice(sent)).toEqual(['P-COVERAGE-NONE', 'W-WEAR-REMIND', 'V-COVERAGE-NONE']);
  });

  it('onHold: bitiş geçmişse kapalı', () => {
    expect(onHold({ holdUntil: t(T14, 10) }, T14)).toBe(true);
    expect(onHold({ holdUntil: T14 }, T14)).toBe(false);
    expect(onHold({ holdUntil: null }, T14)).toBe(false);
  });
});
