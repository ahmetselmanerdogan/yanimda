import type { Signal } from '@yanimda/contracts';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { safeErrorDetail } from '../src/common/safe-error';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * Denetim bulguları (outbox işçisi):
 *  - MEDIUM: core satırı geçici altyapı hatasında (Postgres bağlantısı/failover, sorgu zaman aşımı) 5 denemede
 *    (~30 sn) DLQ'ya düşüyordu → kısa bir veritabanı kesintisinde FALL `signal.received` kaybolabilirdi. Geçici
 *    hata DLQ bütçesini tüketmez; sınırlı (en çok 30 sn) geri çekilmeyle ~1 saat yeniden denenir. Kalıcı hata
 *    eskisi gibi 5 denemede DLQ. Sıra (kuyruk başı) korunur.
 *  - MEDIUM (PII): last_error'a ham `e.message` yazılıyordu; Drizzle "Failed query ... params: ..." konum/sağlık
 *    değeri içerebilir → yalnız hata adı + kodu saklanır, parametre asla.
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
const outboxRow = async () =>
  (
    await h.rows<{ attempts: number; transient_attempts: number; last_error: string | null; next_attempt_at: Date }>(
      'SELECT attempts, transient_attempts, last_error, next_attempt_at FROM event.outbox WHERE processed_at IS NULL ORDER BY id LIMIT 1',
    )
  )[0];
const dlqCount = async () => Number((await h.rows<{ n: number }>('SELECT count(*)::int n FROM event.outbox_dlq'))[0].n);

describe('OutboxWorker core: geçici hata DLQ bütçesini tüketmez', () => {
  it("FALL geçici hatada 5'ten çok denenir, DLQ'ya düşmez, sırayı korur; düzelince sırayla teslim", async () => {
    const seen: string[] = [];
    let down = true;
    h.bus.subscribe<Signal>('signal.received', (e) => {
      if (down) throw transient();
      seen.push(e.payload.kind);
    });
    await h.signals.accept([sig('FALL'), sig('CANCEL')]);
    let t = Date.now();
    for (let i = 0; i < 20; i++) {
      t += 10 * 60_000; // her tur geri çekilmenin ötesinde
      await h.worker({ now: () => new Date(t) }).drain();
    }
    expect(await dlqCount()).toBe(0);
    expect(seen).toEqual([]); // CANCEL, FALL'dan önce teslim edilmedi
    const row = await outboxRow();
    expect(row).toMatchObject({ attempts: 0, transient_attempts: 20 });
    expect(row.last_error).toContain('08006');

    down = false;
    t += 10 * 60_000;
    expect(await h.worker({ now: () => new Date(t) }).drain()).toBe(2);
    expect(seen).toEqual(['FALL', 'CANCEL']);
  });

  it('geçici hatada geri çekilme 30 sn ile sınırlı (kesinti bitince FALL en geç ~30 sn içinde işlenir)', async () => {
    h.bus.subscribe('signal.received', () => {
      throw transient();
    });
    await h.signals.accept([sig('FALL')]);
    let t = Date.now();
    for (let i = 0; i < 12; i++) {
      t += 10 * 60_000;
      await h.worker({ now: () => new Date(t) }).drain();
    }
    const row = await outboxRow();
    expect(row.next_attempt_at.getTime() - t).toBeLessThanOrEqual(30_000);
    expect(row.next_attempt_at.getTime() - t).toBeGreaterThan(0);
  });

  it('geçici hata da sonsuza dek kuyruğu tıkamaz: transientMaxAttempts sonra DLQ, kuyruk ilerler', async () => {
    const seen: string[] = [];
    h.bus.subscribe<Signal>('signal.received', (e) => {
      if (e.payload.kind === 'SOS') throw transient();
      seen.push(e.payload.kind);
    });
    await h.signals.accept([sig('SOS'), sig('HEARTBEAT')]);
    let t = Date.now();
    for (let i = 0; i < 8; i++) {
      t += 10 * 60_000;
      await h.worker({ now: () => new Date(t), transientMaxAttempts: 8 }).drain();
    }
    const dlq = await h.rows<{ attempts: number; last_error: string }>(
      'SELECT attempts, last_error FROM event.outbox_dlq',
    );
    expect(dlq).toHaveLength(1);
    expect(dlq[0].attempts).toBe(8);
    expect(dlq[0].last_error).toContain('08006');
    expect(seen).toEqual(['HEARTBEAT']);
  });

  it('varsayılan geçici sınırı ~1 saatlik yeniden denemeyi kapsar', async () => {
    h.bus.subscribe('signal.received', () => {
      throw transient();
    });
    await h.signals.accept([sig('FALL')]);
    // Her tur tam geri çekilme süresi kadar sonra: toplam bekleme ≥ 1 saat olana dek DLQ'ya düşmemeli.
    let t = Date.now();
    const start = t;
    while (t - start < 3600_000) {
      await h.worker({ now: () => new Date(t) }).drain();
      const row = await outboxRow();
      expect(row, `${(t - start) / 60_000} dk sonra DLQ'ya düştü`).toBeDefined();
      t = row.next_attempt_at.getTime();
    }
    expect(await dlqCount()).toBe(0);
  });

  it('kalıcı hata eskisi gibi 5 denemede DLQ; önceki geçici hatalar bu bütçeyi tüketmez', async () => {
    let n = 0;
    h.bus.subscribe('signal.received', () => {
      n++;
      if (n <= 3) throw transient();
      throw new TypeError('zehirli mesaj');
    });
    await h.signals.accept([sig('SOS')]);
    let t = Date.now();
    for (let i = 0; i < 7; i++) {
      t += 10 * 60_000;
      await h.worker({ now: () => new Date(t) }).drain();
    }
    expect(await dlqCount()).toBe(0); // 3 geçici + 4 kalıcı
    expect(await outboxRow()).toMatchObject({ attempts: 4, transient_attempts: 3 });
    t += 10 * 60_000;
    await h.worker({ now: () => new Date(t) }).drain();
    const dlq = await h.rows<{ attempts: number; last_error: string }>(
      'SELECT attempts, last_error FROM event.outbox_dlq',
    );
    expect(dlq).toEqual([{ attempts: 8, last_error: 'TypeError' }]);
  });
});

describe('OutboxWorker last_error: PII yok', () => {
  const PII = ['41.0123', '29.0456', 'kalp ritmi 182', 'Ayşe'];
  const drizzleErr = () =>
    new DrizzleQueryError(
      'insert into "signal"."signal" ("location", "value", "note") values ($1, $2, $3)',
      ['{"lat":41.0123,"lng":29.0456}', 'kalp ritmi 182', 'Ayşe'],
      Object.assign(new Error('duplicate key value violates unique constraint "signal_idem_uq"'), {
        code: '23505',
        constraint: 'signal_idem_uq',
      }),
    );
  const noPii = (s: string | null | undefined) => {
    expect(s).toBeTruthy();
    for (const p of PII) expect(s).not.toContain(p);
    expect(s).not.toMatch(/Failed query|params/);
  };

  it('safeErrorDetail: hata zinciri adı + kod, parametre/mesaj yok', () => {
    const s = safeErrorDetail(drizzleErr());
    noPii(s);
    expect(s).toContain('DrizzleQueryError');
    expect(s).toContain('23505');
    expect(safeErrorDetail(new Error('Ayşe 41.0123'))).toBe('Error');
    expect(safeErrorDetail('Ayşe')).toBe('string');
    expect(safeErrorDetail(undefined)).toBe('undefined');
  });

  it('core: event.outbox ve outbox_dlq last_error parametre içermez', async () => {
    h.bus.subscribe('signal.received', () => {
      throw drizzleErr();
    });
    await h.signals.accept([sig('FALL')]);
    let t = Date.now();
    t += 10 * 60_000;
    await h.worker({ now: () => new Date(t) }).drain();
    noPii((await outboxRow()).last_error);
    for (let i = 0; i < 5; i++) {
      t += 10 * 60_000;
      await h.worker({ now: () => new Date(t) }).drain();
    }
    const [dlq] = await h.rows<{ last_error: string }>('SELECT last_error FROM event.outbox_dlq');
    noPii(dlq.last_error);
  });

  it('side: event.outbox_side last_error parametre içermez', async () => {
    h.bus.subscribe(
      'signal.received',
      () => {
        throw drizzleErr();
      },
      { lane: 'side', name: 'stats' },
    );
    await h.signals.accept([sig('FALL')]);
    await h.worker().drainCore();
    await h.worker().drainSide();
    const [row] = await h.rows<{ last_error: string }>('SELECT last_error FROM event.outbox_side');
    noPii(row.last_error);
  });
});
