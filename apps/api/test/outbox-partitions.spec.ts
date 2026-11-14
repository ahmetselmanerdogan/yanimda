import type { KafkaEnvelope, Signal } from '@yanimda/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { OUTBOX_PARTITIONS } from '../src/common/outbox.worker';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * Ölçek (1 milyon kişi değerlendirmesi, 2026-11-13): core şeridi tek aktif işçiyle ve genel FIFO ile işleniyordu;
 * her HEARTBEAT de bu kuyruktan geçtiği için SOS binlerce heartbeat'in, bir kişinin takılan satırı herkesin arkasında
 * bekliyordu. Sıra yalnız kişi başına gerekli: satırlar kişiye göre bölümlenir (event.outbox.part), her bölüm kendi
 * kirasıyla ve paralel işlenir. Eski tek işçi (kira 1) deploy sırasında çitle dışarıda bırakılır.
 */
let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
});
afterAll(async () => {
  await h.close();
});

const transient = () => Object.assign(new Error('Connection terminated unexpectedly'), { code: '08006' });
const partOf = async (key: string) =>
  Number(
    (
      await h.rows<{ p: number }>(
        `SELECT (((hashtext($1) % ${OUTBOX_PARTITIONS}) + ${OUTBOX_PARTITIONS}) % ${OUTBOX_PARTITIONS})::int p`,
        [key],
      )
    )[0].p,
  );
/** Farklı bölümlere düşen iki kişi kimliği. */
const twoPeople = async (): Promise<[string, string]> => {
  const a = 'pp-a';
  const pa = await partOf(a);
  for (let i = 0; i < 100; i++) if ((await partOf(`pp-b${i}`)) !== pa) return [a, `pp-b${i}`];
  throw new Error('farklı bölüm bulunamadı');
};
/** Aynı bölüme düşen iki kişi kimliği. */
const samePartition = async (): Promise<[string, string]> => {
  const a = 'pp-s';
  const pa = await partOf(a);
  for (let i = 0; i < 2000; i++) if ((await partOf(`pp-t${i}`)) === pa) return [a, `pp-t${i}`];
  throw new Error('aynı bölüm bulunamadı');
};
const label = (a: string) => (e: { payload: Signal }) =>
  `${e.payload.protectedPersonId === a ? 'A' : 'B'}:${e.payload.kind}`;
const deliverAll = async (t?: number) => h.worker(t === undefined ? {} : { now: () => new Date(t) }).drain();

describe('OutboxWorker bölümleri: sıra kişi başına, kişiler birbirini bekletmez', () => {
  it('aynı kişinin satırları aynı bölümde; kişiler bölümlere dağılır; kişisiz zarf konu kimliğine göre', async () => {
    const people = Array.from({ length: 64 }, (_, i) => `pp-${i}`);
    await h.signals.accept(
      people.flatMap((p) => [sig('HEARTBEAT', { protectedPersonId: p }), sig('SOS', { protectedPersonId: p })]),
    );
    const rows = await h.rows<{ person: string; part: number }>(
      "SELECT envelope->'payload'->>'protectedPersonId' person, part FROM event.outbox",
    );
    expect(rows).toHaveLength(128);
    const byPerson = new Map<string, Set<number>>();
    for (const r of rows) byPerson.set(r.person, (byPerson.get(r.person) ?? new Set()).add(Number(r.part)));
    for (const [p, parts] of byPerson) {
      expect(parts.size).toBe(1);
      expect([...parts][0]).toBe(await partOf(p));
    }
    expect(new Set(rows.map((r) => Number(r.part))).size).toBeGreaterThan(8);

    await h.outbox.publish('supervisor.alert', {
      eventId: 'e1',
      type: 'supervisor.alert',
      version: 1,
      occurredAt: new Date().toISOString(),
      countryCode: 'TR',
      subjectUserId: 'partner',
      payload: { code: 'X' },
    } as KafkaEnvelope<unknown>);
    const [alert] = await h.rows<{ part: number }>("SELECT part FROM event.outbox WHERE topic = 'supervisor.alert'");
    expect(Number(alert.part)).toBe(await partOf('partner'));
  });

  it('bir kişinin takılan satırı yalnız o kişiyi bekletir: başka kişinin SOS’u teslim edilir, sıra korunur', async () => {
    const [a, b] = await twoPeople();
    const seen: string[] = [];
    let down = true;
    h.bus.subscribe<Signal>('signal.received', (e) => {
      if (down && e.payload.protectedPersonId === a) throw transient();
      seen.push(`${e.payload.protectedPersonId === a ? 'A' : 'B'}:${e.payload.kind}`);
    });
    await h.signals.accept([
      sig('FALL', { protectedPersonId: a }),
      sig('CANCEL', { protectedPersonId: a }),
      sig('SOS', { protectedPersonId: b }),
    ]);
    let t = Date.now();
    await deliverAll(t);
    expect(seen).toEqual(['B:SOS']); // A'nın FALL'u B'yi bekletmedi; A'nın CANCEL'ı FALL'dan önce gitmedi

    down = false;
    t += 10 * 60_000;
    expect(await deliverAll(t)).toBe(2);
    expect(seen).toEqual(['B:SOS', 'A:FALL', 'A:CANCEL']);
  });

  it('iki işçi aynı anda: her satır bir kez, her kişinin sırası korunur', async () => {
    const kinds = ['FALL', 'CANCEL', 'HEARTBEAT', 'SOS', 'OK'];
    const people = Array.from({ length: 12 }, (_, i) => `pp-c${i}`);
    const got = new Map<string, string[]>();
    h.bus.subscribe<Signal>('signal.received', async (e) => {
      await new Promise((r) => setTimeout(r, Math.random() * 3)); // teslimler iç içe geçsin
      const list = got.get(e.payload.protectedPersonId) ?? [];
      list.push(e.payload.kind);
      got.set(e.payload.protectedPersonId, list);
    });
    for (const k of kinds) await h.signals.accept(people.map((p) => sig(k, { protectedPersonId: p })));

    const [x, y] = await Promise.all([h.worker({ concurrency: 4 }).drain(), h.worker({ concurrency: 4 }).drain()]);
    expect(x + y).toBe(people.length * kinds.length);
    for (const p of people) expect(got.get(p)).toEqual(kinds);
    expect((await h.rows('SELECT 1 FROM event.outbox WHERE processed_at IS NULL')).length).toBe(0);
  });

  it('deploy: eski tek işçi kirası (id 1) canlıyken bölümlü işçi beklemede; kira bitince çitler, eski işçi giremez', async () => {
    const seen: string[] = [];
    h.bus.subscribe<Signal>('signal.received', (e) => void seen.push(e.payload.kind));
    await h.rows("INSERT INTO event.outbox_lease (id, owner, until) VALUES (1, 'eski', now() + interval '30 seconds')");
    await h.signals.accept([sig('SOS')]);
    expect(await deliverAll()).toBe(0); // eski işçi hâlâ genel FIFO'yla çalışıyor olabilir: iki düzen karışmaz
    expect(seen).toEqual([]);

    await h.rows("UPDATE event.outbox_lease SET until = now() - interval '1 second' WHERE id = 1");
    expect(await deliverAll()).toBe(1);
    expect(seen).toEqual(['SOS']);

    // Eski işçinin kira sorgusu (0003) artık hiç dönmez: çit sonsuza dek tutulur.
    const old = await h.rows(`
      INSERT INTO event.outbox_lease (id, owner, until) VALUES (1, 'eski', now() + interval '30 seconds')
      ON CONFLICT (id) DO UPDATE SET owner = EXCLUDED.owner, until = EXCLUDED.until
      WHERE event.outbox_lease.until < now() OR event.outbox_lease.owner = EXCLUDED.owner
      RETURNING owner`);
    expect(old).toHaveLength(0);
  });
});

describe('OutboxWorker önceliği: alarm rutin ölçümlerin arkasında beklemez, kişi sırası bozulmaz', () => {
  it('urgent: rutin ölçüm sinyali değil; olay konuları her zaman acil', async () => {
    await h.signals.accept([sig('HEARTBEAT'), sig('LOCATION'), sig('BATTERY', { value: 50 }), sig('SOS'), sig('OK')]);
    const rows = await h.rows<{ kind: string; urgent: boolean; pkey: string }>(
      "SELECT envelope#>>'{payload,kind}' kind, urgent, pkey FROM event.outbox ORDER BY id",
    );
    expect(rows.map((r) => [r.kind, r.urgent])).toEqual([
      ['HEARTBEAT', false],
      ['LOCATION', false],
      ['BATTERY', false],
      ['SOS', true],
      ['OK', true],
    ]);
    expect(new Set(rows.map((r) => r.pkey)).size).toBe(1);
  });

  it('aynı bölümde: SOS’u olan kişi (önceki heartbeat’iyle, sırasıyla) başka kişinin 150 heartbeat’inden önce', async () => {
    const [a, b] = await samePartition();
    const seen: string[] = [];
    h.bus.subscribe<Signal>('signal.received', (e) => void seen.push(label(a)(e)));
    await h.signals.accept(Array.from({ length: 150 }, () => sig('HEARTBEAT', { protectedPersonId: a })));
    await h.signals.accept([sig('HEARTBEAT', { protectedPersonId: b }), sig('SOS', { protectedPersonId: b })]);
    await h.worker({ concurrency: 1 }).drain();
    expect(seen.slice(0, 2)).toEqual(['B:HEARTBEAT', 'B:SOS']);
    expect(seen).toHaveLength(152);
  });

  it('aynı bölümde: takılan kişi yalnız kendini bekletir; diğer kişinin SOS’u ve heartbeat’i ilerler', async () => {
    const [a, b] = await samePartition();
    const seen: string[] = [];
    let down = true;
    h.bus.subscribe<Signal>('signal.received', (e) => {
      if (down && e.payload.protectedPersonId === a) throw transient();
      seen.push(label(a)(e));
    });
    await h.signals.accept([sig('FALL', { protectedPersonId: a }), sig('CANCEL', { protectedPersonId: a })]);
    await h.signals.accept([sig('HEARTBEAT', { protectedPersonId: b }), sig('SOS', { protectedPersonId: b })]);
    let t = Date.now();
    await deliverAll(t);
    expect(seen).toEqual(['B:HEARTBEAT', 'B:SOS']);
    down = false;
    t += 10 * 60_000;
    await deliverAll(t);
    expect(seen).toEqual(['B:HEARTBEAT', 'B:SOS', 'A:FALL', 'A:CANCEL']);
  });

  it('acil satırı olan bölüm önce seçilir (tek şerit): başka bölümdeki 300 heartbeat’ten önce SOS', async () => {
    const [a, b] = await twoPeople();
    const seen: string[] = [];
    h.bus.subscribe<Signal>('signal.received', (e) => void seen.push(label(a)(e)));
    await h.signals.accept(Array.from({ length: 300 }, () => sig('HEARTBEAT', { protectedPersonId: a })));
    await h.signals.accept([sig('SOS', { protectedPersonId: b })]);
    await h.worker({ concurrency: 1 }).drain();
    expect(seen[0]).toBe('B:SOS');
    expect(seen).toHaveLength(301);
  });

  it('teslim sürerken gelen SOS, bölümün sırası gelmeden bir sonraki toplu turda alınır', async () => {
    const [a, b] = await twoPeople();
    const seen: string[] = [];
    let injected = false;
    h.bus.subscribe<Signal>('signal.received', async (e) => {
      seen.push(label(a)(e));
      if (!injected && seen.length === 5) {
        injected = true;
        await h.signals.accept([sig('SOS', { protectedPersonId: b })]);
      }
    });
    await h.signals.accept(Array.from({ length: 400 }, () => sig('HEARTBEAT', { protectedPersonId: a })));
    await h.worker({ concurrency: 1, batchSize: 50 }).drain();
    const at = seen.indexOf('B:SOS');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThanOrEqual(50); // en geç ilk toplu turun ardından
    expect(seen).toHaveLength(401);
  });

  it('bölümü bu turda boşalmışken gelen SOS turun bitmesini beklemez (aşırı yükte p95 18–37 sn)', async () => {
    // Aşırı yükte tur hiç bitmez (bölümler hep dolu); bölümü turda "bitti" sayılan kişinin SOS'u turun sonunu
    // bekliyordu. Acil bölüm, bu turda boşalmış olsa da bir sonraki toplu turda alınmalı.
    const [a, b] = await twoPeople();
    const seen: string[] = [];
    let injected = -1;
    h.bus.subscribe<Signal>('signal.received', async (e) => {
      seen.push(label(a)(e));
      if (injected < 0 && seen.length === 110) {
        injected = seen.length;
        await h.signals.accept([sig('SOS', { protectedPersonId: b })]);
      }
    });
    await h.signals.accept(Array.from({ length: 400 }, () => sig('HEARTBEAT', { protectedPersonId: a })));
    await h.signals.accept([sig('HEARTBEAT', { protectedPersonId: b })]); // b'nin bölümü turun başında biter
    await h.worker({ concurrency: 1, batchSize: 50 }).drain();
    expect(seen.indexOf('B:HEARTBEAT')).toBeLessThan(110);
    const at = seen.indexOf('B:SOS');
    expect(at).toBeGreaterThanOrEqual(injected);
    expect(at - injected).toBeLessThanOrEqual(50); // en geç süren toplu turun ardından
    expect(seen).toHaveLength(402);
  });

  it('toplu tur ortasında gelen SOS turun bitmesini beklemez: şerit acil iş görünce bırakır, kalanı sonra', async () => {
    // Aşırı yükte toplu tur (100 satır) saniyeler sürer; tek şerit doluyken SOS onun sonunu bekliyordu.
    const [a, b] = await twoPeople();
    const seen: string[] = [];
    let injected = -1;
    h.bus.subscribe<Signal>('signal.received', async (e) => {
      seen.push(label(a)(e));
      if (injected < 0 && seen.length === 5) {
        injected = seen.length;
        await h.signals.accept([sig('SOS', { protectedPersonId: b })]);
      }
    });
    await h.signals.accept(Array.from({ length: 300 }, () => sig('HEARTBEAT', { protectedPersonId: a })));
    await h.worker({ concurrency: 1, batchSize: 100, yieldCheckMs: 0 }).drain();
    const at = seen.indexOf('B:SOS');
    expect(at - injected).toBeLessThanOrEqual(2);
    expect(seen.filter((x) => x === 'A:HEARTBEAT')).toHaveLength(300); // bırakılan tur kaybolmaz
  });

  it('işlenen bölümün içinde başka kişinin SOS’u da turun sonunu beklemez; takılı acil anahtar turu döndürmez', async () => {
    const [a, b] = await samePartition();
    const seen: string[] = [];
    let injected = -1;
    h.bus.subscribe<Signal>('signal.received', async (e) => {
      seen.push(label(a)(e));
      if (injected < 0 && seen.length === 5) {
        injected = seen.length;
        await h.signals.accept([sig('SOS', { protectedPersonId: b })]);
      }
    });
    await h.signals.accept(Array.from({ length: 300 }, () => sig('HEARTBEAT', { protectedPersonId: a })));
    await h.worker({ concurrency: 1, batchSize: 100, yieldCheckMs: 0 }).drain();
    expect(seen.indexOf('B:SOS') - injected).toBeLessThanOrEqual(2);
    expect(seen).toHaveLength(301);

    // Acil anahtar geri çekilmede: bölümün rutin turu her satırda bırakılmaz, hepsi teslim edilir.
    await h.reset();
    seen.length = 0;
    let failSos = true;
    h.bus.subscribe<Signal>('signal.received', (e) => {
      if (e.payload.kind === 'SOS' && failSos) throw new Error('geçici değil');
      seen.push(label(a)(e));
    });
    await h.signals.accept([sig('SOS', { protectedPersonId: b })]);
    await h.signals.accept(Array.from({ length: 150 }, () => sig('HEARTBEAT', { protectedPersonId: a })));
    const w = h.worker({ concurrency: 1, batchSize: 100, yieldCheckMs: 0 });
    await w.drainCore(); // SOS denemesi başarısız, geri çekilmeye girer
    await w.drainCore();
    expect(seen.filter((x) => x === 'A:HEARTBEAT')).toHaveLength(150);
    failSos = false;
  });

  it('acil bölümün kirası başka işçideyse tur onu tekrar tekrar denemez, diğer bölümler ilerler', async () => {
    const [a, b] = await twoPeople();
    await h.rows(
      "INSERT INTO event.outbox_lease (id, owner, until) VALUES ($1, 'baska-isci', now() + interval '1 hour')",
      [100 + (await partOf(b))],
    );
    const seen: string[] = [];
    h.bus.subscribe<Signal>('signal.received', (e) => void seen.push(label(a)(e)));
    await h.signals.accept([sig('SOS', { protectedPersonId: b })]);
    await h.signals.accept(Array.from({ length: 120 }, () => sig('HEARTBEAT', { protectedPersonId: a })));
    const w = h.worker({ concurrency: 2, batchSize: 50 });
    await expect(
      Promise.race([w.drainCore(), new Promise((_, no) => setTimeout(() => no(new Error('tur bitmedi')), 10_000))]),
    ).resolves.toBe(120);
    expect(seen).not.toContain('B:SOS');
  });

  it('kirası başka işçide olduğu için alınamayan acil bölüm, kira bırakılınca aynı turda alınır (çok sunucu)', async () => {
    // İki API'de her iki işçi de bölümü "alınamadı" sayıp turu boyunca bırakırsa SOS turların sonunu bekliyordu
    // (2 sunucu ölçümü: p95 22 sn). "Takıldı" işareti kısa süreli olmalı.
    const [a, b] = await twoPeople();
    const lease = 100 + (await partOf(b));
    await h.rows(
      "INSERT INTO event.outbox_lease (id, owner, until) VALUES ($1, 'baska-isci', now() + interval '1 hour')",
      [lease],
    );
    const seen: string[] = [];
    h.bus.subscribe<Signal>('signal.received', async (e) => {
      seen.push(label(a)(e));
      if (seen.length === 20) await h.rows("UPDATE event.outbox_lease SET until = '-infinity' WHERE id = $1", [lease]);
      await new Promise((r) => setTimeout(r, 5));
    });
    await h.signals.accept([sig('SOS', { protectedPersonId: b })]);
    await h.signals.accept(Array.from({ length: 200 }, () => sig('HEARTBEAT', { protectedPersonId: a })));
    await h.worker({ concurrency: 1, batchSize: 50, yieldCheckMs: 0 }).drainCore();
    expect(seen).toContain('B:SOS');
    expect(seen.indexOf('B:SOS')).toBeLessThan(200); // heartbeat'lerin sonunu beklemedi
  }, 20_000);
});

describe('side şeridi: süzgeçli abone ilgisiz sinyal için satır yazmaz', () => {
  it('yalnız BATTERY isteyen side abonesi: HEARTBEAT için event.outbox_side satırı yok', async () => {
    const got: string[] = [];
    h.bus.subscribe<Signal>('signal.received', (e) => void got.push(e.payload.kind), {
      lane: 'side',
      name: 'test.battery',
      accepts: (e) => (e.payload as Signal).kind === 'BATTERY',
    });
    await h.signals.accept([sig('HEARTBEAT'), sig('BATTERY', { value: 15 }), sig('HEARTBEAT')]);
    await deliverAll();
    expect(await h.rows("SELECT 1 FROM event.outbox_side WHERE handler = 'test.battery'")).toHaveLength(1);
    expect(got).toEqual(['BATTERY']);
  });
});
