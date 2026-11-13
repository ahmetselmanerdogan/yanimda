import type { VitalQuality, VitalSlice } from '@yanimda/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '../src/common/bus';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { ChainService } from '../src/modules/chain/chain.service';
import { loadProcedures } from '../src/modules/chain/procedures';
import type { EventService } from '../src/modules/event/event.service';
import { loadRulePack, type RulePack, staticRules } from '../src/modules/event/rules.loader';
import { VitalsService } from '../src/modules/vitals/vitals.service';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * T-092 (docs/07 S6, S10.1 aşama 3) değer kuralları, PGlite + olay motoru. Saatler sabit test saatidir (VitalsService
 * saati enjekte edilir; gün içi saatten bağımsız). Bayrak kapalıyken davranış bugünküyle aynıdır.
 */
const P = '0190c000-0000-7000-8000-0000000000b1';
const P2 = '0190c000-0000-7000-8000-0000000000b2';
const T = new Date('2026-11-09T11:00:00Z'); // 14:00 İstanbul (gece penceresi dışında)
const t = (min: number, base = T) => new Date(base.getTime() + min * 60_000);
const DAY = 86_400_000;
const off = loadRulePack('TR');
const on: RulePack = { ...off, vitals: { ...off.vitals!, enabled: true } };

let h: Harness;
let events: EventService;
let vitals: VitalsService;
let clock = T;

const HEALTH =
  'health.vital_sample, health.vital_daily, health.vital_baseline, health.vital_profile, health.vital_alert, health.vital_silence, health.vital_review';

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

async function setup(pack: RulePack) {
  await h.reset();
  await h.pg.exec(`TRUNCATE ${HEALTH}, event.supervisor_alert`);
  for (const id of [P, P2])
    await h.pg.query(`INSERT INTO profile.protected_person (id, display_name) VALUES ($1, 'Ayşe')`, [id]);
  events = h.events(new InMemoryTimers(), pack);
  vitals = new VitalsService(h.db, h.outbox, events, staticRules(pack));
  vitals.subscribe(bus);
  vitals.clock = () => clock;
  clock = T;
}

/** Sinyal yolu (signal.signal + outbox → bus): saat takılı, pil %80. */
const send = async (kind: string, at: Date, extra: Record<string, unknown> = {}, person = P) => {
  clock = at;
  await h.signals.accept([
    sig(kind, {
      protectedPersonId: person,
      deviceId: 'watch',
      occurredAt: at.toISOString(),
      device: { onWrist: true, batteryPct: 80, connectivity: 'LTE' },
      ...extra,
    }),
  ]);
  await h.worker().drain();
};
/** Öğrenme süresi geçmiş kişi (ilk örnek 20 gün önce). */
const learned = (person = P, extra = '') =>
  h.pg.query(
    `INSERT INTO health.vital_profile (protected_person_id, learning_started_at${extra ? ', ' + extra.split('=')[0] : ''})
     VALUES ($1, $2${extra ? ', ' + extra.split('=')[1] : ''})`,
    [person, new Date(T.getTime() - 20 * DAY)],
  );
/** Doğrudan örnek (kural tablosu için hızlı yol): son örnek `end`, dakikada bir. */
const samples = async (
  value: number | number[],
  n: number,
  end: Date,
  o: {
    kind?: 'HR' | 'SPO2';
    every?: number;
    q?: VitalQuality;
    slice?: VitalSlice;
    eligible?: boolean;
    person?: string;
  } = {},
) => {
  for (let i = 0; i < n; i++) {
    const at = new Date(end.getTime() - (n - 1 - i) * (o.every ?? 1) * 60_000);
    await h.pg.query(
      `INSERT INTO health.vital_sample (protected_person_id, device_id, kind, value, at, quality, slice, worn, still,
         eligible, source_key) VALUES ($1, 'watch', $2, $3, $4, $5, $6, true, true, $7, $8)`,
      [
        o.person ?? P,
        o.kind ?? 'HR',
        Array.isArray(value) ? value[i] : value,
        at,
        o.q ?? 'Q2',
        o.slice ?? 'REST',
        o.eligible ?? true,
        `s:${Math.random()}`,
      ],
    );
  }
  clock = end;
};
const evaluate = async (at: Date, person = P) => {
  clock = at;
  const f = await vitals.evaluatePerson(person, at);
  await h.worker().drain();
  return f;
};
const all = async () => Promise.all((await events.all()).map((e) => events.get(e.id)));
const openEvents = async () => (await all()).filter((e) => e.state !== 'CLOSED');
const topics = async () =>
  (await h.rows<{ topic: string }>('SELECT topic FROM event.outbox ORDER BY id')).map((r) => r.topic);
const notices = async () =>
  (
    await h.rows<{ envelope: { payload: { code: string } } }>(
      "SELECT envelope FROM event.outbox WHERE topic = 'notify.requested' ORDER BY id",
    )
  ).map((r) => r.envelope.payload.code);
const count = async (table: string) => (await h.rows<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))[0]!.n;
const closeAs = async (id: string, outcome: string) => {
  await events.claim(id, 'op-1');
  await events.closeByOperator(id, 'op-1', outcome);
  await h.worker().drain();
};

describe('bayrak kapalı: davranış bugünküyle aynı (S6 giriş, S10.2)', () => {
  /** Düşük nabız + hareketsizlik, düşük oksijen, cilt sıcaklığı: kapalıyken yalnız kayıt. */
  const scenario = async () => {
    await send('ON_BODY', t(-30));
    for (let m = 0; m <= 15; m++) await send('HEART_RATE', t(m), { value: 35, vital: { quality: 'Q2' } });
    await send('SPO2', t(0), { value: 82 });
    await send('SPO2', t(12), { value: 82 });
    await send('SKIN_TEMP_DEVIATION', t(13), { value: 1.6 });
    await vitals.sweep(t(20));
    return {
      events: (await events.all()).map((e) => [e.type, e.priority, e.state]),
      topics: await topics(),
    };
  };

  it('olay, bildirim, health satırı yok; sinyaller yalnız kaydedilir; uçlar 404', async () => {
    await setup(off);
    const withVitals = await scenario();
    expect(withVitals.events).toEqual([]);
    expect(await notices()).toEqual([]);
    for (const tb of HEALTH.split(', ')) expect(await count(tb)).toBe(0);
    expect(await h.rows('SELECT kind, count(*)::int AS n FROM signal.signal GROUP BY kind ORDER BY kind')).toEqual([
      { kind: 'HEART_RATE', n: 16 },
      { kind: 'ON_BODY', n: 1 },
      { kind: 'SKIN_TEMP_DEVIATION', n: 1 },
      { kind: 'SPO2', n: 2 },
    ]);
    await expect(vitals.weeklyTrends(P)).rejects.toMatchObject({ status: 404 });
    // Kapalıyken ayar yazılmaz (GET `enabled: false` döner; PUT 404, health satırı yok).
    await expect(
      vitals.setSettings(P, { lowHr: 35, familyConsent: true, doctorNote: true }, 'fam-1', t(0)),
    ).rejects.toMatchObject({ status: 404 });
    await expect(vitals.setSettings(P, { trendsMuted: true }, 'fam-1', t(0))).rejects.toMatchObject({ status: 404 });
    expect((await vitals.settings(P)).enabled).toBe(false);
    await expect(
      vitals.eventVitals('0190c000-0000-7000-8000-000000000999', { sub: 'op', supervisor: false }),
    ).rejects.toMatchObject({
      status: 404,
    });

    // Aynı senaryo VitalsService hiç yokken: outbox ve olaylar birebir aynı.
    await h.reset();
    for (const id of [P, P2])
      await h.pg.query(`INSERT INTO profile.protected_person (id, display_name) VALUES ($1, 'Ayşe')`, [id]);
    events = h.events(new InMemoryTimers(), off);
    const baseline = await scenario();
    expect(baseline).toEqual(withVitals);
  });

  it('VITALS_ENABLED=false paket açık olsa da kapatır', async () => {
    process.env.VITALS_ENABLED = 'false';
    try {
      await setup(on);
      await learned();
      await send('ON_BODY', t(-30));
      for (let m = 0; m <= 6; m++) await send('HEART_RATE', t(m), { value: 35 });
      expect(await all()).toEqual([]);
      expect(await count('health.vital_sample')).toBe(0);
    } finally {
      delete process.env.VITALS_ENABLED;
    }
  });
});

describe('sinyal alımı ve ortak şartlar (S6.4)', () => {
  beforeEach(() => setup(on));

  it('geçerli örnek health şemasına; 25–250 dışı nabız atılır; ≥5 dk takılı olmadan eligible değil', async () => {
    await send('HEART_RATE', t(0), { value: 70 }); // ilk takılı gözlem şimdi → 5 dk dolmadı
    await send('HEART_RATE', t(1), { value: 260 });
    await send('HEART_RATE', t(6), { value: 72 });
    await send('HEART_RATE', t(7), { value: 72, device: { onWrist: true, batteryPct: 8 } }); // pil < %10
    await send('HEART_RATE', t(8), { value: 72, device: { onWrist: true, batteryPct: 80, charging: true } });
    const rows = await h.rows<{ value: number; eligible: boolean; worn: boolean }>(
      'SELECT value, eligible, worn FROM health.vital_sample ORDER BY at',
    );
    expect(rows).toEqual([
      { value: 70, eligible: false, worn: true },
      { value: 72, eligible: true, worn: true },
      { value: 72, eligible: false, worn: true },
      { value: 72, eligible: false, worn: true },
    ]);
    const [p] = await h.rows<{ learning_started_at: Date }>('SELECT learning_started_at FROM health.vital_profile');
    expect(new Date(p!.learning_started_at).toISOString()).toBe(t(0).toISOString());
  });

  it('öğrenme süresinde (ilk örnekten 14 gün) değer olayı yok', async () => {
    await send('ON_BODY', t(-30));
    for (let m = 0; m <= 15; m++) await send('HEART_RATE', t(m), { value: 35 });
    expect(await all()).toEqual([]);
    expect(await count('health.vital_alert')).toBe(0);
  });

  it('adım (hareket) varken örnek eligible değil; kombinasyon yok', async () => {
    await learned();
    await send('ON_BODY', t(-30));
    let steps = 1000;
    for (let m = 0; m <= 11; m++) {
      await send('STEPS', t(m), { value: (steps += 10) });
      await send('HEART_RATE', t(m), { value: 35 });
    }
    expect(await all()).toEqual([]); // 5 dk'da 50 adım → ortak şart sağlanmıyor
  });

  it('hiç hareket yok + düşük nabız ≥5 dk → P2 HEART_ANOMALY, kuyruğun başına, ön eleme / cihaz sorusu yok', async () => {
    await learned();
    // Başka kişinin daha önce açılmış P2 olayı (yerinde kontrol) kuyrukta.
    await events.raiseWelfare(P2, 'ALL_SILENT', 'welfare:test', t(-60));
    await send('ON_BODY', t(-30));
    for (let m = 0; m <= 5; m++) await send('HEART_RATE', t(m), { value: 36 });
    const [ev] = (await openEvents()).filter((e) => e.protectedPersonId === P);
    expect(ev).toMatchObject({ type: 'HEART_ANOMALY', priority: 2, state: 'OPERATOR_QUEUE', headOfQueue: true });
    expect(ev!.transitions.map((x) => x.to)).toEqual(['CREATED', 'ESCALATED', 'OPERATOR_QUEUE']);
    const q = await events.queuePage({ limit: 10, offset: 0 });
    expect(q.items.map((i) => [i.eventId, i.headOfQueue])).toEqual([
      [ev!.id, true],
      [expect.any(String), false],
    ]);
    // Merdiven (S5.4 "Anormal değer"): cihaz → telefon → 1. yakın; operatör metni O-SCRIPT-VITALS.
    const chain = new ChainService(h.db, events, loadProcedures('TR'), undefined, undefined, staticRules(on));
    const v = await chain.claim(ev!.id, 'op-1');
    expect(v.chain!.steps.map((s) => s.kind)).toEqual(['CALL_WATCH', 'CALL_PHONE', 'CALL_CONTACT']);
    // Aynı süren okuma ikinci olay / kayıt açmaz.
    await send('HEART_RATE', t(6), { value: 36 });
    expect(await count('health.vital_alert')).toBe(1);
    // Log'da / denetimde değer yok; aile kuyrukta bildirim almaz (P2 değer olayı aile bildirimi değil).
    expect(await notices()).toEqual([]);
  });
});

describe('kurallar → olay (S6.4)', () => {
  beforeEach(async () => {
    await setup(on);
    await learned();
  });

  it('düşük nabız (az hareket, kombinasyon değil) ≥10 dk → P3; yüksek nabız dinlenirken → P3', async () => {
    // Örnekler ortak şartı sağlıyor ama son 5 dk'da birkaç adım var: "hiç hareket yok" değil.
    await h.signals.accept([
      sig('STEPS', { protectedPersonId: P, deviceId: 'phone', occurredAt: t(5).toISOString(), value: 100 }),
      sig('STEPS', { protectedPersonId: P, deviceId: 'phone', occurredAt: t(9).toISOString(), value: 105 }),
    ]);
    await samples(38, 11, t(10));
    expect((await evaluate(t(10))).map((f) => f.rule)).toEqual(['LOW_HR']);
    const [ev] = await openEvents();
    expect(ev).toMatchObject({ type: 'HEART_ANOMALY', priority: 3, state: 'OPERATOR_QUEUE' });
    expect(ev!.headOfQueue).toBeUndefined();

    await setup(on);
    await learned();
    await samples(135, 11, t(10));
    await evaluate(t(10));
    expect(await openEvents()).toEqual([expect.objectContaining({ type: 'HEART_ANOMALY', priority: 3 })]);
  });

  it('oksijen ≤%88 iki okuma 10 dk arayla → SPO2_LOW P3; nabız ≥120 ile P2', async () => {
    await samples(86, 2, t(10), { kind: 'SPO2', every: 10 });
    await evaluate(t(10));
    expect(await openEvents()).toEqual([expect.objectContaining({ type: 'SPO2_LOW', priority: 3 })]);

    await setup(on);
    await learned();
    await samples(86, 2, t(10), { kind: 'SPO2', every: 10 });
    await samples(125, 3, t(10));
    await evaluate(t(10));
    expect(await openEvents()).toEqual([expect.objectContaining({ type: 'SPO2_LOW', priority: 2 })]);
  });

  it('Q3 (yüzük) tek başına olay açmaz', async () => {
    await samples(84, 3, t(20), { kind: 'SPO2', every: 10, q: 'Q3' });
    await samples(35, 15, t(20), { q: 'Q3' });
    expect(await evaluate(t(20))).toEqual([]);
    expect(await all()).toEqual([]);
  });

  it('düşme + alışılmadık nabız: P1 kalır, operatöre vurgu (denetim + VITALS_ABNORMAL), değer olayı açılmaz', async () => {
    await send('FALL', t(0));
    const [fall] = await openEvents();
    await samples(150, 3, t(2), { eligible: false });
    const f = await evaluate(t(2));
    expect(f.map((x) => x.rule)).toEqual(['FALL_HR_HIGHLIGHT']);
    expect(await openEvents()).toEqual([expect.objectContaining({ id: fall!.id, type: 'FALL', priority: 1 })]);
    const audit = await h.rows(
      "SELECT data FROM audit.log WHERE action = 'event.vitals_highlight' AND entity_id = $1",
      [fall!.id],
    );
    expect(audit).toEqual([{ data: { rule: 'FALL_HR_HIGHLIGHT' } }]);
    const upd = await h.rows<{ envelope: { payload: { reason: string } } }>(
      "SELECT envelope FROM event.outbox WHERE topic = 'event.updated'",
    );
    expect(upd.map((u) => u.envelope.payload.reason)).toContain('VITALS_ABNORMAL');
    await evaluate(t(3)); // bir kez
    expect(await count('health.vital_alert')).toBe(1);
    const view = await vitals.eventVitals(fall!.id, { sub: 'op-1', supervisor: false }, t(3));
    expect(view).toMatchObject({ highlight: true, alerts: [{ rule: 'FALL_HR_HIGHLIGHT', value: 150 }] });
  });

  it('tabandan sapma ≥30 dk → yalnız aileye F-VITAL-TREND (günde bir; aile susturabilir), operatör yok', async () => {
    await h.pg.query(`INSERT INTO health.vital_baseline VALUES ($1, 'HR', 'REST', 70, 10, $2)`, [P, t(-60)]);
    await samples(95, 31, t(30));
    await evaluate(t(30));
    expect(await all()).toEqual([]);
    expect(await notices()).toEqual(['F-VITAL-TREND']);
    await samples([60, 60, 60], 3, t(33)); // okuma normale döndü
    await samples(95, 31, t(70));
    await evaluate(t(70));
    expect(await notices()).toEqual(['F-VITAL-TREND', 'F-VITAL-TREND']); // tüketici günlük anahtarla tekilleştirir
    const keys = await h.rows<{ envelope: { payload: { dedupeKey: string } } }>(
      "SELECT envelope FROM event.outbox WHERE topic = 'notify.requested'",
    );
    expect(new Set(keys.map((k) => k.envelope.payload.dedupeKey)).size).toBe(1);

    await setup(on);
    await learned(P, 'trends_muted=true');
    await h.pg.query(`INSERT INTO health.vital_baseline VALUES ($1, 'HR', 'REST', 70, 10, $2)`, [P, t(-60)]);
    await samples(95, 31, t(30));
    await evaluate(t(30));
    expect(await notices()).toEqual([]);
  });
});

describe('alarm yorgunluğu (S6.7)', () => {
  beforeEach(async () => {
    await setup(on);
    await learned();
  });

  it('operatör "iyi" → aynı kural 24 sa susar; %20 kötüleşme sessizliği deler', async () => {
    await samples(135, 11, t(10));
    await evaluate(t(10));
    const [ev] = await openEvents();
    await closeAs(ev!.id, 'OK');
    const [sil] = await h.rows<{ rule: string; ref_value: number }>('SELECT rule, ref_value FROM health.vital_silence');
    expect(sil).toEqual({ rule: 'HIGH_HR', ref_value: 135 });
    await samples(80, 3, t(14));
    await samples(150, 11, t(30)); // yeni bölüm, kötüleşme %20'den az (135 × 1,2 = 162)
    await evaluate(t(30));
    expect(await openEvents()).toEqual([]);
    await samples(80, 3, t(34));
    await samples(165, 11, t(50));
    await evaluate(t(50));
    expect(await openEvents()).toEqual([expect.objectContaining({ type: 'HEART_ANOMALY', priority: 3 })]);
  });

  it('haftada en çok 2 değer kaynaklı kontrol araması; fazlası amirin eşik incelemesine; P2 sınırsız', async () => {
    for (const [i, start] of [0, 60, 120].entries()) {
      await samples(60, 3, t(start - 1));
      await samples(135, 11, t(start + 10));
      await evaluate(t(start + 10));
      const open = await openEvents();
      if (i < 2) {
        expect(open).toHaveLength(1);
        await closeAs(open[0]!.id, 'UNREACHABLE');
      } else expect(open).toEqual([]);
    }
    expect(await h.rows('SELECT outcome FROM health.vital_alert ORDER BY at')).toEqual([
      { outcome: 'EVENT' },
      { outcome: 'EVENT' },
      { outcome: 'LIMITED' },
    ]);
    expect(await h.rows('SELECT rule, reason, resolved_at FROM health.vital_review')).toEqual([
      { rule: 'HIGH_HR', reason: 'WEEKLY_LIMIT', resolved_at: null },
    ]);
    // P2 kombinasyonu sınıra takılmaz.
    await samples(60, 3, t(199));
    await samples(36, 6, t(205));
    await evaluate(t(205));
    expect(await openEvents()).toEqual([expect.objectContaining({ priority: 2, headOfQueue: true })]);
    // Amir incelemeyi kapatır (denetimde).
    const [r] = await vitals.reviews();
    const done = await vitals.resolveReview(r!.id, 'sup-1', { note: 'eşik görüşüldü' }, t(210));
    expect(r).toMatchObject({ rule: 'HIGH_HR', reason: 'WEEKLY_LIMIT', note: null, resolvedAt: null });
    expect(r).toHaveProperty('name'); // amirin listesinde kişi adı (profil yoksa null)
    expect(done).toMatchObject({ resolvedBy: 'sup-1', note: 'eşik görüşüldü' });
    expect(await vitals.reviews()).toEqual([]);
  });

  it('değer olaylarında 30 günde 3 yanlış alarm → eşik incelemesi (T-071 incelemesi değerlere)', async () => {
    for (const start of [0, 60, 120]) {
      await samples(60, 3, t(start - 1));
      await samples(36, 6, t(start + 5)); // P2: haftalık sınır yok
      await evaluate(t(start + 5));
      const [open] = await openEvents();
      await closeAs(open!.id, 'FALSE_ALARM');
    }
    expect(await h.rows('SELECT rule, reason FROM health.vital_review')).toEqual([
      { rule: 'LOW_HR_STILL', reason: 'FALSE_ALARMS' },
    ]);
  });
});

describe('ulaşılamama ve üstlenme (S5.4, S6.4)', () => {
  beforeEach(async () => {
    await setup(on);
    await learned();
  });

  it('P3 değer olayı 15 dk üstlenilmezse amire O-VITAL-UNCLAIMED (bir kez)', async () => {
    await samples(135, 11, t(10));
    await evaluate(t(10));
    const [ev] = await openEvents();
    const queued = new Date(ev!.escalatedAt!);
    await vitals.sweepEvents(new Date(queued.getTime() + 14 * 60_000));
    expect(await count('event.supervisor_alert')).toBe(0);
    await vitals.sweepEvents(new Date(queued.getTime() + 15 * 60_000));
    await vitals.sweepEvents(new Date(queued.getTime() + 16 * 60_000));
    expect(await h.rows('SELECT code, event_id FROM event.supervisor_alert')).toEqual([
      { code: 'O-VITAL-UNCLAIMED', event_id: ev!.id },
    ]);
  });

  it('kişiye ulaşılamadı ve 10 dk hiçbir cihazda hareket yok → P2 hareketsizlik merdiveni', async () => {
    await samples(135, 11, t(10));
    await evaluate(t(10));
    const [ev] = await openEvents();
    const fired = (await h.rows<{ at: Date }>('SELECT at FROM health.vital_alert'))[0]!.at;
    await vitals.sweepEvents(new Date(new Date(fired).getTime() + 9 * 60_000));
    expect((await events.get(ev!.id)).type).toBe('HEART_ANOMALY');
    await vitals.sweepEvents(new Date(new Date(fired).getTime() + 10 * 60_000));
    const up = await events.get(ev!.id);
    expect(up).toMatchObject({ type: 'INACTIVITY', priority: 2, state: 'OPERATOR_QUEUE' });
    // Konsol görünümü olay türü değişse de açık (değer kaydı olaya bağlı).
    const view = await vitals.eventVitals(ev!.id, { sub: 'op-1', supervisor: false }, t(20));
    expect(view.alerts.map((a) => a.rule)).toEqual(['HIGH_HR']);
  });

  it('hareket varsa veya kişiye ulaşıldıysa geçiş yok', async () => {
    await samples(135, 11, t(10));
    await evaluate(t(10));
    const [ev] = await openEvents();
    const fired = new Date((await h.rows<{ at: Date }>('SELECT at FROM health.vital_alert'))[0]!.at);
    await h.signals.accept([
      sig('STEPS', {
        protectedPersonId: P,
        deviceId: 'phone',
        occurredAt: new Date(fired.getTime() + 60_000).toISOString(),
        value: 10,
      }),
      sig('STEPS', {
        protectedPersonId: P,
        deviceId: 'phone',
        occurredAt: new Date(fired.getTime() + 8 * 60_000).toISOString(),
        value: 400,
      }),
    ]);
    await vitals.sweepEvents(new Date(fired.getTime() + 10 * 60_000));
    expect((await events.get(ev!.id)).type).toBe('HEART_ANOMALY');
  });
});

describe('görünürlük (S6.8)', () => {
  beforeEach(async () => {
    await setup(on);
    await learned();
  });

  it('operatör: yalnız açık olayda, 5 dk ortancalar + taban + kalite; kapalı 403, değer olmayan olay 404; denetim', async () => {
    await h.pg.query(`INSERT INTO health.vital_baseline VALUES ($1, 'HR', 'SLEEP', 52, 9, $2)`, [P, t(-60)]);
    await samples(70, 30, t(-15));
    await samples(135, 11, t(10));
    await evaluate(t(10));
    const [ev] = await openEvents();
    const view = await vitals.eventVitals(ev!.id, { sub: 'op-1', supervisor: false }, t(10));
    expect(view).toMatchObject({
      eventId: ev!.id,
      windowMin: 120,
      bucketMin: 5,
      baseline: { HR: { SLEEP: 52 } },
      quality: 'Q2',
      alerts: [{ rule: 'HIGH_HR', value: 135 }],
      highlight: false,
      noteCode: 'O-UI-VITALS-NOTE',
    });
    const hr = view.series.find((s) => s.kind === 'HR')!;
    expect(hr.points.length).toBeLessThanOrEqual(24);
    expect(hr.points.every((p) => p.n >= 1)).toBe(true);
    expect(hr.points.reduce((a, p) => a + p.n, 0)).toBe(41); // dakika örnekleri yalnız ortanca içinde
    const audit = await h.rows(
      "SELECT actor_id, data FROM audit.log WHERE action = 'vitals.viewed' AND entity_id = $1",
      [ev!.id],
    );
    expect(audit).toEqual([{ actor_id: 'op-1', data: { purpose: 'event' } }]);

    await closeAs(ev!.id, 'OK');
    await expect(vitals.eventVitals(ev!.id, { sub: 'op-1', supervisor: false }, t(12))).rejects.toMatchObject({
      status: 403,
    });
    await send('SOS', t(13));
    const [sos] = await openEvents();
    await expect(vitals.eventVitals(sos!.id, { sub: 'op-1', supervisor: false }, t(13))).rejects.toMatchObject({
      status: 404,
    });
  });

  it('aile: haftalık eğilim (ham veri yok, sağlık-amaçlı not) ve "iyi" olmayan sonuçlar', async () => {
    const now = new Date(T.getTime() + 2 * DAY); // Çarşamba 11 Kasım, 14:00 İstanbul
    await h.pg.query(
      `INSERT INTO health.vital_daily (protected_person_id, day, kind, slice, median, min, max, n)
       VALUES ($1, '2026-11-04', 'HR', 'REST', 66, 60, 70, 40)`,
      [P],
    );
    await samples(64, 40, new Date(now.getTime() - 3600_000));
    // Cilt sıcaklığı sapması: 10 ve 11 Kasım geceleri (06:00 İstanbul) +1,2 / +1,1 °C.
    await h.pg.query(
      `INSERT INTO health.vital_sample (protected_person_id, device_id, kind, value, at, quality, slice, worn, still,
         eligible, source_key) VALUES ($1, 'ring', 'SKIN_TEMP', 1.2, $2, 'Q3', 'SLEEP', true, true, false, 'st1'),
         ($1, 'ring', 'SKIN_TEMP', 1.1, $3, 'Q3', 'SLEEP', true, true, false, 'st2')`,
      [P, new Date('2026-11-10T03:00:00Z'), new Date('2026-11-11T03:00:00Z')],
    );
    await vitals.sweepDaily(now);
    await samples(135, 11, t(10, now));
    await evaluate(t(10, now));
    const [ev] = await openEvents();
    await closeAs(ev!.id, 'UNREACHABLE');
    const w = await vitals.weeklyTrends(P, 2, t(20, now));
    expect(w.noteCode).toBe('F-VITAL-WELLNESS-NOTE');
    expect(w.weeks).toEqual([
      expect.objectContaining({ weekStart: '2026-11-02', restingHr: 66, skinTempTwoNights: false }),
      expect.objectContaining({
        weekStart: '2026-11-09',
        restingHr: 64,
        skinTempNightsAbove: 2,
        skinTempTwoNights: true,
        validDays: 1,
      }),
    ]);
    expect(w.outcomes).toEqual([
      expect.objectContaining({ eventId: ev!.id, type: 'HEART_ANOMALY', outcome: 'UNREACHABLE' }),
    ]);
    expect(JSON.stringify(w)).not.toMatch(/"value"/);
  });

  it('kişiye özel eşik: aile onayı + doktor notu işareti olmadan 400; içerik tutulmaz; eşik kurala girer', async () => {
    await expect(vitals.setSettings(P, { lowHr: 35 }, 'fam-1', t(0))).rejects.toMatchObject({ status: 400 });
    await expect(vitals.setSettings(P, { lowHr: 35, familyConsent: true }, 'fam-1', t(0))).rejects.toMatchObject({
      status: 400,
    });
    const s = await vitals.setSettings(
      P,
      { lowHr: 35, familyConsent: true, doctorNote: true, doctorNoteRef: 'belge-1' },
      'fam-1',
      t(0),
    );
    expect(s).toMatchObject({ lowHr: 35, doctorNote: true, familyConsentAt: t(0).toISOString() });
    await samples(38, 11, t(10));
    expect(await evaluate(t(10))).toEqual([]); // 38 ≥ 35
    expect(await vitals.setSettings(P, { trendsMuted: true }, 'fam-1', t(11))).toMatchObject({
      trendsMuted: true,
      lowHr: 35,
    });
    const audit = await h.rows<{ data: { fields: string[] } }>(
      "SELECT data FROM audit.log WHERE action = 'vitals.settings' AND entity_id = $1 ORDER BY id",
      [P],
    );
    expect(audit[0]!.data.fields).not.toContain('doctorNoteRef');
  });
});

describe('taban çizgisi ve saklama (S6.3, S6.8)', () => {
  it('14 gün öğrenmeden sonra ≥7 geçerli gün → dilim ortancası; az gün → taban yok (genel eşik)', async () => {
    await setup(on);
    await h.pg.query(`INSERT INTO health.vital_profile (protected_person_id, learning_started_at) VALUES ($1, $2)`, [
      P,
      new Date(T.getTime() - 15 * DAY),
    ]);
    for (let d = 1; d <= 6; d++) await samples(58 + d, 30, new Date(T.getTime() - d * DAY), { slice: 'SLEEP' });
    expect(await vitals.computeBaseline(P, 'Europe/Istanbul', T)).toEqual([]);
    await samples(70, 30, new Date(T.getTime() - 7 * DAY), { slice: 'SLEEP' });
    await samples(50, 30, new Date(T.getTime() - 8 * DAY), { slice: 'SLEEP', q: 'Q3' }); // Q3 sayılmaz
    expect(await vitals.computeBaseline(P, 'Europe/Istanbul', T)).toEqual([
      { slice: 'SLEEP', median: 62, validDays: 7 },
    ]);
    expect(await h.rows('SELECT slice, median FROM health.vital_baseline')).toEqual([{ slice: 'SLEEP', median: 62 }]);
  });

  it('ham örnek 30 gün, özet 13 ay; SPO2/SKIN_TEMP sinyalleri 30 gün; HEART_RATE ham kaydı yalnız bayrak açıkken', async () => {
    for (const pack of [off, on]) {
      await setup(pack);
      const old = new Date(T.getTime() - 31 * DAY);
      await samples(70, 1, old);
      await samples(71, 1, T);
      await h.pg.query(
        `INSERT INTO health.vital_daily (protected_person_id, day, kind, slice, median, min, max, n)
         VALUES ($1, '2025-09-01', 'HR', 'REST', 70, 60, 80, 30), ($1, '2026-01-01', 'HR', 'REST', 70, 60, 80, 30)`,
        [P],
      );
      await h.signals.accept(
        ['SPO2', 'SKIN_TEMP_DEVIATION', 'HEART_RATE', 'STEPS'].map((kind) =>
          sig(kind, { protectedPersonId: P, deviceId: 'watch', occurredAt: old.toISOString(), value: 1 }),
        ),
      );
      await vitals.purge(T);
      expect(await h.rows('SELECT value FROM health.vital_sample')).toEqual([{ value: 71 }]);
      expect(await h.rows('SELECT day::text AS day FROM health.vital_daily')).toEqual([{ day: '2026-01-01' }]);
      const kinds = (await h.rows<{ kind: string }>('SELECT kind FROM signal.signal ORDER BY kind')).map((r) => r.kind);
      expect(kinds).toEqual(pack === on ? ['STEPS'] : ['HEART_RATE', 'STEPS']);
    }
  });
});
