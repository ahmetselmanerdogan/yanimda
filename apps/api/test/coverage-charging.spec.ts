import type { KafkaEnvelope, Signal, SignalSource } from '@yanimda/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '../src/common/bus';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { AbsorbedSourceService } from '../src/modules/event/absorbed-source.service';
import type { EventService } from '../src/modules/event/event.service';
import { ProtectionService } from '../src/modules/event/protection.service';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * T-085 / T-086 kabul (docs/07 S10.1 "1. Kapsama ve şarj"), olay motoru + PGlite:
 *  - iki giyilebilir cihaz birbirini ezmiyor; "saat çıkarıldı" yalnız hiçbir A sınıfı cihaz takılı değilken (S3.4)
 *  - saat şarjda + kolye takılı = TAM ve sıfır hatırlatma
 *  - tek saat şarjda: %80/20 dk'da "şarj tamam", 90 dk'da aile, 120 dk'da operatör, gece hiçbir şey (S4.4)
 *  - şarjdan düşen saatin düşmesi yok sayılır; şarjdayken pil uyarısı susar
 *  - kapsama YOK (uyanık): 20 dk hatırlatma, 45 dk aile, 60 dk KAPSAMA BOŞLUĞU; geri dönüş (S4.7) — 6 saatlik
 *    CONNECTION_LOST beklemesinin yerini alır; pili biten saat KAPSAMA BOŞLUĞU (BATTERY_DEAD) olur
 */
const P = 'pp-1';
const T19 = new Date('2026-11-09T16:00:00Z'); // 19:00 İstanbul (varsayılan şarj penceresi 19:00–21:00)
const T14 = new Date('2026-11-09T11:00:00Z'); // 14:00 İstanbul
const t = (base: Date, min: number) => new Date(base.getTime() + min * 60_000);
const WATCH: SignalSource = { kind: 'WEAROS_WATCH', role: 'WATCH' };
const PHONE: SignalSource = { kind: 'ANDROID_PHONE', role: 'PHONE' };
const PENDANT: SignalSource = {
  kind: 'SIMULATOR',
  role: 'WATCH',
  category: 'PENDANT',
  tier: 'A',
  caps: { sos: true, fall: true, voice: true, location: true },
};
const SOURCES: Record<string, SignalSource> = { watch: WATCH, phone: PHONE, pendant: PENDANT };

let h: Harness;
let events: EventService;
let protection: ProtectionService;
/** Testte sürekli yaşayan cihazlar: her sinyal ve taramada aynı anda heartbeat gönderir (telefon, kolye). */
let alive: string[] = [];
/** Testin saati: adımlar arasında 10 dk'da bir yaşayan cihazlar heartbeat gönderir ve tarama çalışır (gerçekçi). */
let clock: Date | null = null;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  events = h.events(new InMemoryTimers());
  protection = new ProtectionService(h.db, h.outbox);
  alive = [];
  clock = null;
});
afterAll(async () => {
  await h.close();
});

const deliver = (s: ReturnType<typeof sig>) =>
  bus.deliver<Signal>('signal.received', { payload: s } as unknown as KafkaEnvelope<Signal>);
const heartbeat = (device: string, at: Date) =>
  deliver(sig('HEARTBEAT', { deviceId: device, occurredAt: at.toISOString(), source: SOURCES[device] }));
const advance = async (at: Date) => {
  if (clock)
    for (let x = t(clock, 10); x < at; x = t(x, 10)) {
      for (const d of alive) await heartbeat(d, x);
      await events.sweepProtection(x);
    }
  clock = at;
};
const send = async (device: string, kind: string, at: Date, extra: Record<string, unknown> = {}) => {
  await advance(at);
  for (const d of alive) if (d !== device) await heartbeat(d, at);
  await deliver(sig(kind, { deviceId: device, occurredAt: at.toISOString(), source: SOURCES[device], ...extra }));
};
/** Yaşayan cihazlar o anda heartbeat gönderir, tarama o ana göre çalışır. */
const step = async (at: Date) => {
  await advance(at);
  for (const d of alive) await heartbeat(d, at);
  await events.sweepProtection(at);
};
/** Olay ve geçişleri (events.all() geçişleri yüklemez). */
const gapEvents = async () =>
  Promise.all((await events.all()).filter((e) => e.type === 'COVERAGE_GAP').map((e) => events.get(e.id)));
const notices = async () =>
  (
    await h.rows<{ envelope: { payload: { code: string; audience: string; vars?: { min?: number } } } }>(
      "SELECT envelope FROM event.outbox WHERE topic = 'notify.requested' ORDER BY id",
    )
  ).map(({ envelope: { payload: p } }) => `${p.code}/${p.audience}`);
const level = async () =>
  (await h.rows<{ level: string }>('SELECT level FROM event.coverage_state WHERE protected_person_id = $1', [P]))[0]
    ?.level;

describe('Çoklu cihaz (S1.1, S3.4)', () => {
  it('iki giyilebilir cihaz birbirini ezmez: saat çıkarılınca kolye TAM tutar, "saat çıkarıldı" açılmaz', async () => {
    await send('watch', 'ON_BODY', t(T14, 0), { device: { connectivity: 'LTE' } });
    await send('pendant', 'ON_BODY', t(T14, 1));
    await send('watch', 'OFF_BODY', t(T14, 2), { device: { connectivity: 'LTE' } });
    expect(await level()).toBe('FULL');
    expect(await events.all()).toEqual([]);
    const [row] = await h.rows<{ devices: Record<string, { onBody: boolean; category: string }> }>(
      'SELECT devices FROM event.coverage_state WHERE protected_person_id = $1',
      [P],
    );
    expect(row!.devices.watch).toMatchObject({ onBody: false, category: 'WATCH' });
    expect(row!.devices.pendant).toMatchObject({ onBody: true, category: 'PENDANT' });
    // Eski durum alanı türetilir: kolye takılıyken "saat koruması".
    expect((await protection.status(P, t(T14, 2))).state).toBe('PROTECTED_WATCH');
    // Kolye de çıkarılırsa "saat çıkarıldı" beklemesi açılır (telefon yok → kapsama YOK).
    await send('pendant', 'OFF_BODY', t(T14, 3));
    expect((await events.all()).map((e) => [e.type, e.state])).toEqual([['WATCH_OFF', 'DEVICE_PROMPT']]);
  });

  it('kapsama geçmişi ve user.coverage.changed her seviye değişikliğinde yazılır', async () => {
    await send('phone', 'HEARTBEAT', t(T14, 0));
    await send('watch', 'ON_BODY', t(T14, 1), { device: { connectivity: 'BLE' } });
    await send('watch', 'CHARGE_START', t(T14, 2), { device: { connectivity: 'BLE' } });
    const hist = await h.rows<{ from_level: string | null; level: string }>(
      'SELECT from_level, level FROM event.coverage_history WHERE protected_person_id = $1 ORDER BY id',
      [P],
    );
    expect(hist.map((x) => `${x.from_level}→${x.level}`)).toEqual([
      'null→PHONE_ONLY',
      'PHONE_ONLY→FULL',
      'FULL→PHONE_ONLY',
    ]);
    const topics = await h.rows<{ n: number }>(
      "SELECT count(*)::int AS n FROM event.outbox WHERE topic = 'user.coverage.changed'",
    );
    expect(topics[0]!.n).toBe(3);
  });
});

describe('Şarj (S4.4) — kabul', () => {
  it('saat şarjda + kolye takılı = TAM ve sıfır hatırlatma', async () => {
    alive = ['phone', 'pendant'];
    await send('phone', 'HEARTBEAT', t(T19, -5));
    await send('pendant', 'ON_BODY', t(T19, -5));
    await send('watch', 'ON_BODY', t(T19, -4));
    await send('watch', 'CHARGE_START', t(T19, 0), { device: { batteryPct: 30 } });
    await send('watch', 'HEARTBEAT', t(T19, 25), { device: { batteryPct: 85, charging: true } });
    for (const m of [30, 90, 130]) await step(t(T19, m));
    expect(await level()).toBe('FULL');
    expect(await notices()).toEqual([]);
    expect(await events.all()).toEqual([]);
  });

  it('tek saat şarjda: %80 ve 20 dk → "şarj tamam"; 90 dk → aile (bir kez); 120 dk → KAPSAMA BOŞLUĞU', async () => {
    alive = ['phone'];
    await send('phone', 'HEARTBEAT', t(T19, -5));
    await send('watch', 'ON_BODY', t(T19, -4));
    await send('watch', 'CHARGE_START', t(T19, 0), { device: { batteryPct: 30 } });
    expect(await level()).toBe('PHONE_ONLY');
    await send('watch', 'HEARTBEAT', t(T19, 15), { device: { batteryPct: 85, charging: true } }); // %80 ama 15 dk
    expect(await notices()).toEqual([]);
    await send('watch', 'HEARTBEAT', t(T19, 20), { device: { batteryPct: 86, charging: true } });
    expect(await notices()).toEqual(['W-CHARGE-DONE/ELDER', 'P-CHARGE-DONE/ELDER']);
    await step(t(T19, 89));
    expect(await notices()).toHaveLength(2);
    await step(t(T19, 90));
    await step(t(T19, 100));
    expect(await notices()).toEqual(['W-CHARGE-DONE/ELDER', 'P-CHARGE-DONE/ELDER', 'F-CHARGE-GAP/FAMILY']);
    const [gap] = await h.rows<{ v: { min: number } }>(
      "SELECT envelope->'payload'->'vars' AS v FROM event.outbox WHERE envelope->'payload'->>'code' = 'F-CHARGE-GAP'",
    );
    expect(gap!.v.min).toBe(90);
    await step(t(T19, 119));
    expect(await gapEvents()).toEqual([]);
    await step(t(T19, 120));
    await step(t(T19, 121)); // tekrar ayıklanır
    const [ev] = await gapEvents();
    expect(await events.all()).toHaveLength(1);
    expect(ev).toMatchObject({ type: 'COVERAGE_GAP', priority: 3, state: 'OPERATOR_QUEUE' });
    expect(ev!.transitions[0]).toMatchObject({ to: 'CREATED', note: 'CHARGING' });
    // Saat takıldı → TAM; operatörün üstlenmediği olay sistemce kapanır.
    await send('watch', 'ON_BODY', t(T19, 125));
    expect(await level()).toBe('FULL');
    expect(await events.get(ev!.id)).toMatchObject({ state: 'CLOSED', closeReason: 'kapsama geri geldi' });
  });

  it('gece hiçbir şey; uyanış + 30 dk devam eder (plan dışı şarj: aile 60 dk)', async () => {
    alive = ['phone'];
    const T2130 = new Date('2026-11-09T18:30:00Z'); // 21:30 İstanbul — plan penceresi (19–21) dışında
    await send('phone', 'HEARTBEAT', t(T2130, -5));
    await send('watch', 'ON_BODY', t(T2130, -4));
    await send('watch', 'CHARGE_START', T2130, { device: { batteryPct: 20 } });
    await send('watch', 'HEARTBEAT', t(T2130, 90), { device: { batteryPct: 100, charging: true } }); // 23:00
    await step(t(T2130, 120)); // 23:30
    await step(new Date('2026-11-10T02:00:00Z')); // 05:00
    expect(await level()).toBe('NIGHT'); // 05:00
    await step(new Date('2026-11-10T05:20:00Z')); // 08:20 (gece bitti, uyanış + 30 dolmadı)
    expect(await notices()).toEqual([]);
    await step(new Date('2026-11-10T05:31:00Z')); // 08:31 → "şarj tamam" sabah
    expect(await notices()).toEqual(['W-CHARGE-DONE/ELDER', 'P-CHARGE-DONE/ELDER']);
    await step(new Date('2026-11-10T05:59:00Z')); // 30 + 29 uyanık dk
    expect(await notices()).toHaveLength(2);
    await step(new Date('2026-11-10T06:00:00Z')); // 30 + 30 = 60 → aile (plan dışı)
    expect((await notices()).slice(2)).toEqual(['F-CHARGE-GAP/FAMILY']);
    await step(new Date('2026-11-10T06:59:00Z')); // 119
    expect(await gapEvents()).toEqual([]);
    await step(new Date('2026-11-10T07:00:00Z')); // 120
    expect(await gapEvents()).toHaveLength(1);
  });

  it('şarjdan çıktı, takılmadı: 15 ve 30 dk hatırlatma (cihaz + telefon); takılınca biter', async () => {
    alive = ['phone'];
    await send('phone', 'HEARTBEAT', t(T19, -5));
    await send('watch', 'ON_BODY', t(T19, -4));
    await send('watch', 'CHARGE_START', T19, { device: { batteryPct: 50 } });
    await send('watch', 'CHARGE_END', t(T19, 30), { device: { batteryPct: 95 } });
    await step(t(T19, 44));
    expect(await notices()).toEqual([]);
    await step(t(T19, 45));
    await step(t(T19, 60));
    await step(t(T19, 61));
    expect(await notices()).toEqual([
      'W-WEAR-REMIND/ELDER',
      'P-WEAR-REMIND/ELDER',
      'W-WEAR-REMIND/ELDER',
      'P-WEAR-REMIND/ELDER',
    ]);
    await send('watch', 'ON_BODY', t(T19, 62));
    alive = ['phone', 'watch'];
    await step(t(T19, 130));
    expect(await level()).toBe('FULL');
    expect(await notices()).toHaveLength(4);
    expect(await events.all()).toEqual([]);
  });

  it('"şarj ediyorum" (S4.5) hatırlatmaları ve aileyi susturur, 120 dk operatör olayını susturmaz', async () => {
    alive = ['phone'];
    await send('phone', 'HEARTBEAT', t(T19, -5));
    await send('watch', 'ON_BODY', t(T19, -4));
    await send('watch', 'CHARGE_START', T19, { device: { batteryPct: 50 } });
    const r = await protection.coverage.chargingIntent(P, undefined, 'DEVICE', t(T19, 1));
    expect(r.until).toBe(t(T19, 91).toISOString());
    await send('watch', 'CHARGE_END', t(T19, 10), { device: { batteryPct: 70 } });
    for (const m of [25, 40, 90]) await step(t(T19, m));
    expect(await notices()).toEqual([]);
    await step(t(T19, 120));
    expect(await gapEvents()).toHaveLength(1);
    const [audit] = await h.rows<{ data: unknown }>(
      "SELECT data FROM audit.log WHERE action = 'coverage.charging_intent' AND entity_id = $1",
      [P],
    );
    expect(audit!.data).toEqual({ minutes: 90, by: 'DEVICE' });
  });

  it('kapsama YOK iken şarja girildi → telefona "telefonu yanınızda tutun"', async () => {
    await send('watch', 'ON_BODY', t(T19, -4), { device: { connectivity: 'LTE' } });
    await send('watch', 'CHARGE_START', T19, { device: { connectivity: 'LTE' } });
    expect(await level()).toBe('NONE');
    expect(await notices()).toEqual(['P-CHARGE-COVER/ELDER']);
  });
});

describe('Şarjdaki cihaz (S3.4, S4.2)', () => {
  it('şarj bilgisini taşıyan düşme yok sayılır ve denetime yazılır; eski şarj bilgisi veto etmez', async () => {
    const s = sig('FALL', { deviceId: 'watch', source: WATCH, device: { charging: true } });
    await deliver(s);
    expect(await events.all()).toEqual([]);
    const [a] = await h.rows<{ data: unknown }>(
      "SELECT data FROM audit.log WHERE action = 'signal.ignored' AND entity_id = $1",
      [s.idempotencyKey],
    );
    expect(a!.data).toEqual({ kind: 'FALL', reason: 'CHARGING_FALL' });
    // Kayıtlı durum "şarjda" ama düşme sinyali şarj bilgisi taşımıyor → P1 açılır.
    await deliver(sig('FALL', { deviceId: 'watch', source: WATCH }));
    expect((await events.all()).map((e) => e.type)).toEqual(['FALL']);
  });

  it('şarjdayken pil uyarıları susar; şarjdan çıkınca döner', async () => {
    alive = ['phone'];
    await send('watch', 'CHARGE_START', t(T14, 0));
    await send('watch', 'BATTERY', t(T14, 1), { value: 10 });
    await send('watch', 'BATTERY', t(T14, 1), { value: 10, device: { charging: true } });
    expect(await notices()).toEqual([]);
    await send('watch', 'CHARGE_END', t(T14, 2));
    await send('watch', 'BATTERY', t(T14, 3), { value: 10 });
    expect(await notices()).toEqual(['W-BAT-10/ELDER', 'F-BAT-10/FAMILY']);
  });

  it('şarja takılan saat bekleyen "saat çıkarıldı"yı kapatır; şarj bilgili OFF_BODY olay açmaz', async () => {
    await send('watch', 'OFF_BODY', t(T14, 0));
    const [off] = await events.all();
    expect(off).toMatchObject({ type: 'WATCH_OFF', state: 'DEVICE_PROMPT' });
    await send('watch', 'CHARGE_START', t(T14, 1));
    expect(await events.get(off!.id)).toMatchObject({ state: 'CLOSED', closeReason: 'şarja takıldı' });
    await send('watch', 'OFF_BODY', t(T14, 2), { device: { charging: true } });
    expect((await events.all()).filter((e) => e.state !== 'CLOSED')).toEqual([]);
  });
});

describe('Kapsama YOK (S4.7) — eski 6 saatlik CONNECTION_LOST yerine', () => {
  it('uyanık 20 dk hatırlatma, 45 dk aile, 60 dk KAPSAMA BOŞLUĞU (bağlantı yok); geri gelince aile + kapanış', async () => {
    await send('watch', 'ON_BODY', T14, { device: { connectivity: 'LTE' } }); // telefon yok
    expect(await level()).toBe('FULL');
    await step(t(T14, 16)); // saat 15 dk sessiz → YOK
    expect(await level()).toBe('NONE');
    await step(t(T14, 35));
    expect(await notices()).toEqual([]);
    await step(t(T14, 36));
    // S4.7: hatırlatma + yaşlının numarasına otomatik sesli arama (boşluk başına bir).
    expect(await notices()).toEqual(['P-COVERAGE-NONE/ELDER', 'W-WEAR-REMIND/ELDER', 'V-COVERAGE-NONE/ELDER']);
    await step(t(T14, 61));
    expect((await notices()).slice(3)).toEqual(['F-COVERAGE-NONE/FAMILY']);
    await step(t(T14, 75));
    expect(await gapEvents()).toEqual([]);
    await step(t(T14, 76));
    await step(t(T14, 77));
    const gaps = await gapEvents();
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.transitions[0]!.note).toBe('CONNECTION_LOST');
    expect(gaps[0]!.sourceSignalIds[0]).toMatch(/^coverage-none:/);
    await send('watch', 'HEARTBEAT', t(T14, 80), { device: { connectivity: 'LTE', onWrist: true } });
    expect(await level()).toBe('FULL');
    expect((await notices()).slice(4)).toEqual(['F-COVERAGE-BACK/FAMILY']);
    expect(await events.get(gaps[0]!.id)).toMatchObject({ state: 'CLOSED', confirmedOutcome: 'OK' });
  });

  it('hiç cihazı bilinmeyen kişide zamanlayıcı işlemez (ör. yalnız "şarj ediyorum" çağrısı)', async () => {
    await protection.coverage.chargingIntent(P, undefined, 'FAMILY', T14);
    expect(await level()).toBe('NONE');
    await step(t(T14, 90));
    expect(await notices()).toEqual([]);
    expect(await events.all()).toEqual([]);
  });

  it('gece kapsama yok → hiçbir şey; sabah uyanış + 30 dk sonra sayılır', async () => {
    const T23 = new Date('2026-11-09T20:00:00Z'); // 23:00
    await send('watch', 'ON_BODY', T23, { device: { connectivity: 'LTE' } });
    await step(t(T23, 30));
    await step(new Date('2026-11-10T05:29:00Z')); // 08:29
    expect(await notices()).toEqual([]);
    expect(await events.all()).toEqual([]);
    await step(new Date('2026-11-10T05:50:00Z')); // 08:50 → 20 uyanık dk
    expect(await notices()).toEqual(['P-COVERAGE-NONE/ELDER', 'W-WEAR-REMIND/ELDER', 'V-COVERAGE-NONE/ELDER']);
  });

  it('pili biten saat (≤%5) susarsa, telefon koruyor olsa da 120 dk sonra KAPSAMA BOŞLUĞU (pil bitti)', async () => {
    alive = ['phone'];
    await send('phone', 'HEARTBEAT', t(T14, 0));
    await send('watch', 'HEARTBEAT', T14, { device: { batteryPct: 4, onWrist: true, connectivity: 'LTE' } });
    await step(t(T14, 16));
    expect(await level()).toBe('PHONE_ONLY');
    await step(t(T14, 119));
    expect(await gapEvents()).toEqual([]);
    await step(t(T14, 120));
    const [ev] = await gapEvents();
    expect(ev!.transitions[0]!.note).toBe('BATTERY_DEAD');
    expect(await notices()).toEqual([]); // pil bittiğinde aile şarj bildirimi yok
  });

  it('bekleyen "saat çıkarıldı" sürerken kapsama boşluğu → beklemeden operatöre; o olay kapanınca kendi olayı açılır', async () => {
    const release = new AbsorbedSourceService(h.db);
    release.subscribe(bus);
    await send('watch', 'OFF_BODY', T14, { device: { connectivity: 'LTE' } }); // telefon yok → YOK
    const [off] = await events.all();
    expect(off).toMatchObject({ type: 'WATCH_OFF', state: 'DEVICE_PROMPT' });
    await step(t(T14, 60));
    const escalated = await events.get(off!.id);
    expect(escalated.state).toBe('OPERATOR_QUEUE');
    expect(escalated.sourceSignalIds).toEqual(expect.arrayContaining([expect.stringMatching(/^coverage-none:/)]));
    await events.claim(off!.id, 'op-1');
    await events.closeByOperator(off!.id, 'op-1', 'OK');
    await h.worker().drain();
    await step(t(T14, 61));
    await step(t(T14, 62));
    const open = (await events.all()).filter((e) => e.state !== 'CLOSED');
    expect(open).toEqual([expect.objectContaining({ type: 'COVERAGE_GAP', state: 'OPERATOR_QUEUE' })]);
  });
});

describe('Eski koruma durumu ve sabah "saat çıkarıldı"', () => {
  it('telefon köprüsüyle gelen saat: telefon düşerse köprülü saat de düşer (S4.8)', async () => {
    await send('watch', 'HEARTBEAT', T14, { device: { connectivity: 'BLE', onWrist: true } });
    expect(await level()).toBe('FULL');
    await step(t(T14, 16));
    expect(await level()).toBe('NONE');
    expect((await protection.status(P, t(T14, 16))).state).toBe('UNPROTECTED');
  });
});
