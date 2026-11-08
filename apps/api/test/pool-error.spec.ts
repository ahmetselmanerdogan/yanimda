import { describe, expect, it } from 'vitest';

import { createPool } from '../src/db/client';

/** Boştaki Postgres bağlantısı koparsa süreç çökmemeli (failover / DB yeniden başlatma). */
describe('Postgres havuzu', () => {
  it("havuz 'error' olayı dinleniyor (dinleyici yoksa Node süreci kapanır)", async () => {
    const pool = createPool('postgres://kimse@127.0.0.1:1/yok');
    expect(pool.listenerCount('error')).toBeGreaterThan(0);
    expect(() => pool.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow();
    await pool.end();
  });
});
