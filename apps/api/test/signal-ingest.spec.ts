import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';
import type { KafkaEnvelope, Signal } from '@yanimda/contracts';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { down, migrate } from '../src/db/migrate';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * T-010 · D-01 Sinyal alımı kalıcı. Kabul:
 *  - 1 sinyal → 1 signal.signal + 1 event.outbox satırı (tek transaction)
 *  - işçi çalışınca abonelere ulaşır; işçi öldürülüp yeniden başlatılınca kayıp yok (10 sinyal / 10 teslim)
 *  - aynı key → duplicates=1 (Redis; Redis yoksa/kaybolursa veritabanı tekil indeksi)
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

const count = async (table: string) =>
  Number((await h.rows<{ n: number }>(`SELECT count(*)::int n FROM ${table}`))[0].n);

describe('POST /v1/signals → kalıcı kayıt', () => {
  it('1 sinyal → 1 signal satırı + 1 outbox satırı (signal.received)', async () => {
    const s = sig('FALL', { value: 1, location: { lat: 41, lng: 29 } });
    expect(await h.signals.accept([s])).toEqual({ accepted: 1, duplicates: 0 });

    const [row] = await h.rows<{ kind: string; idempotency_key: string; device_id: string; time: Date }>(
      'SELECT kind, idempotency_key, device_id, time FROM signal.signal',
    );
    expect(row).toMatchObject({ kind: 'FALL', idempotency_key: s.idempotencyKey, device_id: 'dev-1' });
    expect(new Date(row.time).toISOString()).toBe(s.occurredAt);

    const outbox = await h.rows<{ topic: string; envelope: KafkaEnvelope<Signal>; processed_at: Date | null }>(
      'SELECT topic, envelope, processed_at FROM event.outbox',
    );
    expect(outbox).toHaveLength(1);
    expect(outbox[0].topic).toBe('signal.received');
    expect(outbox[0].processed_at).toBeNull();
    expect(outbox[0].envelope.payload.idempotencyKey).toBe(s.idempotencyKey);
    expect(outbox[0].envelope.payload.receivedAt).toBeTruthy();
  });

  it('outbox zarfı kafka-envelope şemasına uyar (v2.0 Kafka geçişi için)', async () => {
    await h.signals.accept([sig('SOS')]);
    const [{ envelope }] = await h.rows<{ envelope: unknown }>('SELECT envelope FROM event.outbox');
    const ajv = new Ajv2020({ allErrors: true });
    addFormats(ajv);
    const schemaPath = join(__dirname, '../../../packages/contracts/schemas/kafka-envelope.schema.json');
    const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')));
    expect(validate(envelope), JSON.stringify(validate.errors)).toBe(true);
  });

  it('şemaya uymayan sinyal 400 döner ve partiden hiçbir şey yazılmaz', async () => {
    await expect(h.signals.accept([sig('FALL'), { ...sig('FALL'), kind: 'NOPE' }])).rejects.toMatchObject({
      status: 400,
    });
    expect(await count('signal.signal')).toBe(0);
    expect(await count('event.outbox')).toBe(0);
  });

  it('boş parti 400', async () => {
    await expect(h.signals.accept([])).rejects.toMatchObject({ status: 400 });
  });
});

describe('Idempotency', () => {
  it('aynı key aynı partide iki kez → duplicates=1', async () => {
    const s = sig('HEARTBEAT');
    expect(await h.signals.accept([s, s])).toEqual({ accepted: 1, duplicates: 1 });
    expect(await count('signal.signal')).toBe(1);
    expect(await count('event.outbox')).toBe(1);
  });

  it('aynı key ayrı isteklerde → duplicates=1', async () => {
    const s = sig('SOS');
    await h.signals.accept([s]);
    expect(await h.signals.accept([s])).toEqual({ accepted: 0, duplicates: 1 });
    expect(await count('event.outbox')).toBe(1);
  });

  it('Redis anahtarı kaybolsa da (flush/yeniden başlatma) veritabanı tekrarı yakalar', async () => {
    const s = sig('FALL');
    await h.signals.accept([s]);
    await h.redis.flushall();
    expect(await h.signals.accept([s])).toEqual({ accepted: 0, duplicates: 1 });
    expect(await count('signal.signal')).toBe(1);
    expect(await count('event.outbox')).toBe(1);
  });

  it('Redis erişilemezse sinyal yine kabul edilir (kayıp yok), tekrar veritabanında yakalanır', async () => {
    const s = sig('SOS');
    h.redis.set = (() => Promise.reject(new Error('ECONNREFUSED'))) as never;
    h.redis.get = (() => Promise.reject(new Error('ECONNREFUSED'))) as never;
    h.redis.del = (() => Promise.reject(new Error('ECONNREFUSED'))) as never;
    expect(await h.signals.accept([s])).toEqual({ accepted: 1, duplicates: 0 });
    expect(await h.signals.accept([s])).toEqual({ accepted: 0, duplicates: 1 });
    expect(await count('event.outbox')).toBe(1);
  });

  it('anahtar 24 saat tutulur', async () => {
    const s = sig('HEARTBEAT');
    await h.signals.accept([s]);
    const ttl = await h.redis.ttl(`idem:${s.idempotencyKey}`);
    expect(ttl).toBeGreaterThan(86400 - 5);
    expect(ttl).toBeLessThanOrEqual(86400);
  });

  it('veritabanı yazımı başarısızsa 503 döner ve anahtar bırakılır (cihaz yeniden dener, kayıp yok)', async () => {
    const s = sig('FALL');
    await h.pg.exec('ALTER TABLE event.outbox RENAME TO outbox_off');
    await expect(h.signals.accept([s])).rejects.toMatchObject({ status: 503 });
    expect(await h.redis.get(`idem:${s.idempotencyKey}`)).toBeNull();
    expect(await count('signal.signal')).toBe(0); // signal insert de geri alındı (tek transaction)
    await h.pg.exec('ALTER TABLE event.outbox_off RENAME TO outbox');
    expect(await h.signals.accept([s])).toEqual({ accepted: 1, duplicates: 0 });
  });

  it("hata log'larında PII yok (konum, kişi, anahtar, payload)", async () => {
    const s = sig('FALL', { location: { lat: 41.0123, lng: 29.0456 }, protectedPersonId: 'pp-gizli-42' });
    const logged: string[] = [];
    const spies = (['log', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(Logger.prototype, m).mockImplementation((msg: unknown) => void logged.push(String(msg))),
    );
    await h.pg.exec('ALTER TABLE event.outbox RENAME TO outbox_off');
    await expect(h.signals.accept([s])).rejects.toMatchObject({ status: 503 });
    await h.pg.exec('ALTER TABLE event.outbox_off RENAME TO outbox');
    spies.forEach((sp) => sp.mockRestore());
    expect(logged.length).toBeGreaterThan(0);
    for (const secret of ['41.0123', '29.0456', 'pp-gizli-42', s.idempotencyKey, 'params'])
      expect(logged.join('\n')).not.toContain(secret);
  });

  it('aynı sinyal eş zamanlı iki istekte yalnız bir kez yazılır', async () => {
    const s = sig('SOS');
    const results = await Promise.allSettled([h.signals.accept([s]), h.signals.accept([s])]);
    const ok = results.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<never>).value);
    expect(ok.reduce((n, r: { accepted: number }) => n + r.accepted, 0)).toBe(1);
    for (const r of results) if (r.status === 'rejected') expect((r.reason as { status: number }).status).toBe(503); // "işleniyor, tekrar dene"
    expect(await count('signal.signal')).toBe(1);
  });
});

describe('Cihaz durumu (geçici olarak signal içinde; device modülü gelince taşınır)', () => {
  beforeEach(async () => {
    await h.pg.exec(`
      INSERT INTO profile.protected_person (id, display_name) VALUES ('00000000-0000-0000-0000-000000000001', 'demo');
      INSERT INTO device.device (id, protected_person_id, kind)
      VALUES ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-000000000001', 'WEAROS_WATCH');`);
  });
  const deviceId = '00000000-0000-0000-0000-00000000d001';
  const device = async () =>
    (
      await h.rows<{ last_seen_at: Date; battery_pct: number; on_wrist: boolean; connectivity: string }>(
        'SELECT last_seen_at, battery_pct, on_wrist, connectivity FROM device.device',
      )
    )[0];

  it('last_seen_at, battery_pct, on_wrist güncellenir', async () => {
    const s = sig('HEARTBEAT', { deviceId, device: { batteryPct: 63, onWrist: true, connectivity: 'BLE' } });
    await h.signals.accept([s]);
    const d = await device();
    expect(d).toMatchObject({ battery_pct: 63, on_wrist: true, connectivity: 'BLE' });
    expect(new Date(d.last_seen_at).toISOString()).toBe(s.occurredAt);
  });

  it('geç gelen (tamponlanmış) eski sinyal yeni durumu ezmez', async () => {
    const now = Date.now();
    await h.signals.accept([
      sig('HEARTBEAT', { deviceId, occurredAt: new Date(now).toISOString(), device: { batteryPct: 40 } }),
    ]);
    await h.signals.accept([
      sig('HEARTBEAT', { deviceId, occurredAt: new Date(now - 60_000).toISOString(), device: { batteryPct: 90 } }),
    ]);
    expect((await device()).battery_pct).toBe(40);
  });

  it('BATTERY değeri ve OFF_BODY/ON_BODY cihaz durumuna yansır', async () => {
    const t = Date.now();
    await h.signals.accept([
      sig('BATTERY', { deviceId, value: 18, occurredAt: new Date(t).toISOString() }),
      sig('OFF_BODY', { deviceId, occurredAt: new Date(t + 1000).toISOString() }),
    ]);
    expect(await device()).toMatchObject({ battery_pct: 18, on_wrist: false });
    await h.signals.accept([sig('ON_BODY', { deviceId, occurredAt: new Date(t + 2000).toISOString() })]);
    expect((await device()).on_wrist).toBe(true);
  });

  it('kayıtlı olmayan cihaz sinyali yine kabul edilir', async () => {
    expect(await h.signals.accept([sig('SOS', { deviceId: 'bilinmeyen' })])).toEqual({ accepted: 1, duplicates: 0 });
  });
});

describe('OutboxWorker', () => {
  it('işlenmemiş satırları sırayla abonelere verir ve işaretler', async () => {
    const seen: string[] = [];
    h.bus.subscribe<Signal>('signal.received', (e) => {
      seen.push(e.payload.kind);
    });
    await h.signals.accept([sig('FALL'), sig('CANCEL'), sig('HEARTBEAT')]);
    expect(await h.worker().drain()).toBe(3);
    expect(seen).toEqual(['FALL', 'CANCEL', 'HEARTBEAT']);
    expect(await count('event.outbox WHERE processed_at IS NULL')).toBe(0);
    expect(await h.worker().drain()).toBe(0); // ikinci kez teslim yok
  });

  it('işçi öldürülüp yeniden başlatılınca kayıp yok: 10 sinyal → 10 teslim', async () => {
    const delivered = new Set<string>();
    h.bus.subscribe<Signal>('signal.received', (e) => {
      delivered.add(e.payload.idempotencyKey);
    });
    const batch = Array.from({ length: 10 }, (_, i) => sig('FALL', { protectedPersonId: `pp-${i}` }));

    // 1) işçi çalışıyor, 4. teslimde süreç "ölüyor" (handler fırlatır, transaction yarıda kalır)
    let calls = 0;
    const crashing = h.bus.subscribe<Signal>('signal.received', () => {
      if (++calls === 4) throw new Error('süreç öldü');
    });
    await h.signals.accept(batch);
    const w1 = h.worker();
    await w1.drain();
    w1.stop();
    crashing();

    // 2) yeni işçi (yeniden başlatma) kalanları teslim eder
    const w2 = h.worker({ now: () => new Date(Date.now() + 60_000) });
    await w2.drain();
    expect(delivered.size).toBe(10);
    expect(await count('event.outbox WHERE processed_at IS NULL')).toBe(0);
    expect(await count('event.outbox_dlq')).toBe(0);
  });

  it('başarısız satır sırayı korur: arkasındakiler önce teslim edilmez', async () => {
    const seen: string[] = [];
    let fail = true;
    h.bus.subscribe<Signal>('signal.received', (e) => {
      if (e.payload.kind === 'FALL' && fail) throw new Error('geçici');
      seen.push(e.payload.kind);
    });
    await h.signals.accept([sig('FALL'), sig('CANCEL')]);
    await h.worker().drain();
    expect(seen).toEqual([]); // CANCEL, FALL'dan önce işlenmez
    fail = false;
    await h.worker({ now: () => new Date(Date.now() + 60_000) }).drain();
    expect(seen).toEqual(['FALL', 'CANCEL']);
  });

  it('5 denemede başarısız satır outbox_dlq tablosuna taşınır, kuyruk ilerler', async () => {
    const seen: string[] = [];
    h.bus.subscribe<Signal>('signal.received', (e) => {
      if (e.payload.kind === 'SOS') throw new Error('zehirli mesaj');
      seen.push(e.payload.kind);
    });
    await h.signals.accept([sig('SOS'), sig('HEARTBEAT')]);
    let t = Date.now();
    for (let i = 0; i < 5; i++) {
      t += 10 * 60_000;
      await h.worker({ now: () => new Date(t) }).drain();
    }
    const dlq = await h.rows<{ topic: string; attempts: number; last_error: string }>(
      'SELECT topic, attempts, last_error FROM event.outbox_dlq',
    );
    expect(dlq).toEqual([{ topic: 'signal.received', attempts: 5, last_error: 'zehirli mesaj' }]);
    expect(seen).toEqual(['HEARTBEAT']);
    expect(await count('event.outbox WHERE processed_at IS NULL')).toBe(0);
  });

  it('geri çekilme süresi dolmadan yeniden denenmez', async () => {
    let calls = 0;
    h.bus.subscribe('signal.received', () => {
      calls++;
      throw new Error('x');
    });
    await h.signals.accept([sig('SOS')]);
    const w = h.worker();
    await w.drain();
    await w.drain();
    expect(calls).toBe(1);
  });

  it('sinyal kabulü işçiyi hemen uyandırır (1 sn yoklamayı beklemez)', async () => {
    const got = new Promise<string>((resolve) =>
      h.bus.subscribe<Signal>('signal.received', (e) => resolve(e.payload.kind)),
    );
    const w = h.worker({ pollMs: 60_000 });
    w.start();
    await h.signals.accept([sig('SOS')]);
    expect(await got).toBe('SOS');
    w.stop();
  });
});

describe('Migration geri alınabilir (X-05)', () => {
  it('down → up temiz çalışır', async () => {
    await down(h.exec);
    expect(
      await h.rows("SELECT 1 FROM information_schema.tables WHERE table_schema='event' AND table_name='outbox'"),
    ).toEqual([]);
    await migrate(h.exec);
    expect(await h.signals.accept([sig('SOS')])).toEqual({ accepted: 1, duplicates: 0 });
  });
});
