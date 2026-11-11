import { createServer, type Server, type Socket } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import { isTransient } from '../src/common/problem.filter';
import { createPool } from '../src/db/client';

/** Boştaki Postgres bağlantısı koparsa süreç çökmemeli (failover / DB yeniden başlatma). */
describe('Postgres havuzu', () => {
  it("havuz 'error' olayı dinleniyor (dinleyici yoksa Node süreci kapanır)", async () => {
    const pool = createPool('postgres://kimse@127.0.0.1:1/yok');
    expect(pool.listenerCount('error')).toBeGreaterThan(0);
    expect(() => pool.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow();
    await pool.end();
  });

  /**
   * Kaos (Postgres 10 sn kapalı) CI'da iki kez: Postgres dönerken açılan bir bağlantı yanıt almadan asılı kaldı;
   * outbox işçisi o sorguyu sonsuza dek bekledi, SOS API yeniden başlayana kadar kuyruğa düşmedi. Zaman aşımları
   * olmadan tek asılı bağlantı acil akışını durdurur.
   */
  it('TCP kabul edip hiç yanıt vermeyen sunucu: bağlantı zaman aşımıyla hata (asılı kalmaz), geçici sayılır', async () => {
    const sockets: Socket[] = [];
    const server: Server = createServer((s) => void sockets.push(s)); // el sıkışmaya hiç yanıt yok
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const pool = createPool(`postgres://x@127.0.0.1:${port}/x`, { connectTimeoutMs: 300 });
    const t0 = Date.now();
    const err = await pool.query('SELECT 1').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(isTransient(err)).toBe(true); // API 503 + Retry-After döner, cihaz yeniden dener
    await pool.end();
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('varsayılanlar: bağlantı 5 sn, sorgu 30 sn, TCP keepalive; ortamdan ayarlanır', async () => {
    const pool = createPool('postgres://kimse@127.0.0.1:1/yok');
    expect(pool.options).toMatchObject({
      connectionTimeoutMillis: 5_000,
      query_timeout: 30_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });
    await pool.end();
    const tuned = createPool('postgres://kimse@127.0.0.1:1/yok', {
      env: { DATABASE_CONNECT_TIMEOUT_MS: '2000', DATABASE_QUERY_TIMEOUT_MS: '10000' },
    });
    expect(tuned.options).toMatchObject({ connectionTimeoutMillis: 2_000, query_timeout: 10_000 });
    await tuned.end();
  });

  it('sorgu okuma zaman aşımında bağlantı kapatılır: havuza asılı bağlantı geri dönmez', async () => {
    const pool = createPool('postgres://kimse@127.0.0.1:1/yok');
    const destroy = vi.fn();
    const client = {
      connection: { stream: { destroy } },
      query: () => Promise.reject(new Error('Query read timeout')),
    };
    pool.emit('connect', client);
    await expect(client.query()).rejects.toThrow('Query read timeout');
    await new Promise((r) => setImmediate(r));
    expect(destroy).toHaveBeenCalledTimes(1);

    const ok = { connection: { stream: { destroy: vi.fn() } }, query: () => Promise.reject(new Error('syntax')) };
    pool.emit('connect', ok);
    await expect(ok.query()).rejects.toThrow('syntax');
    expect(ok.connection.stream.destroy).not.toHaveBeenCalled(); // normal SQL hatası bağlantıyı kapatmaz
    await pool.end();
  });

  it('zaman aşımı hataları geçici (503)', () => {
    expect(isTransient(new Error('Query read timeout'))).toBe(true);
    expect(isTransient(new Error('timeout exceeded when trying to connect'))).toBe(true);
    expect(isTransient(new Error('Connection terminated due to connection timeout'))).toBe(true);
  });
});
