import { createServer } from 'node:http';

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HealthController } from '../src/common/health.controller';
import { configureHttpSecurity } from '../src/common/http-security';
import { configureServerTimeouts } from '../src/common/http-server';
import { ProblemFilter } from '../src/common/problem.filter';
import { PG_POOL } from '../src/db/client';
import { REDIS } from '../src/modules/signal/idempotency.store';

/**
 * T-083 / T-080 izleme: kimliksiz canlılık (/v1/health) ve hazırlık (/v1/ready) uçları. Compose healthcheck,
 * Helm yoklamaları ve sentetik izleme bunları kullanır (önceden 401 dönen /v1/queue "ayakta" sayılıyordu).
 */
const state = { db: true, redis: true };
const pool = {
  query: async () => {
    if (!state.db) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
    return { rows: [{ ok: 1 }] };
  },
};
const redis = {
  ping: async () => {
    if (!state.redis) throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
    return 'PONG';
  },
};

@Module({
  controllers: [HealthController],
  providers: [
    { provide: PG_POOL, useValue: pool },
    { provide: REDIS, useValue: redis },
  ],
})
class HealthTestModule {}

describe('sağlık uçları', () => {
  let base: string;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const app = await NestFactory.create(HealthTestModule, { logger: false });
    configureHttpSecurity(app, {});
    app.setGlobalPrefix('v1');
    app.useGlobalFilters(new ProblemFilter());
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/v1`.replace('[::1]', '127.0.0.1');
    close = () => app.close();
  });
  afterAll(() => close());

  it('/health: kimliksiz 200, bağımlılıklara bakmaz (veritabanı yokken de)', async () => {
    state.db = false;
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'ok' });
    expect(r.headers.get('cache-control')).toBe('no-store');
    state.db = true;
  });

  it('/ready: veritabanı ve Redis ayakta → 200', async () => {
    const r = await fetch(`${base}/ready`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'ok', db: 'ok', redis: 'ok' });
  });

  it('/ready: veritabanı yok → 503 + Retry-After (trafik bu örneğe gelmesin); hata ayrıntısı sızmaz', async () => {
    state.db = false;
    const r = await fetch(`${base}/ready`);
    const body = await r.text();
    expect(r.status).toBe(503);
    expect(r.headers.get('retry-after')).toBe('2');
    expect(body).not.toContain('5432');
    state.db = true;
  });

  it('/ready: Redis yok → 200 ama redis "down" (sinyal alımı veritabanı tekilliğine düşer; tüm örnekler hazırlıktan çıkmasın)', async () => {
    state.redis = false;
    const r = await fetch(`${base}/ready`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'degraded', db: 'ok', redis: 'down' });
    state.redis = true;
  });
});

describe('HTTP sunucu zaman aşımları', () => {
  it('boştaki bağlantı süresi önündeki vekil / yük dengeleyiciden (ör. 60 sn) uzun: varsayılan 65 sn, başlık 66 sn; ortamdan ayarlanır', () => {
    const s = createServer();
    configureServerTimeouts(s, {});
    expect(s.keepAliveTimeout).toBe(65_000);
    expect(s.headersTimeout).toBe(66_000);
    configureServerTimeouts(s, { HTTP_KEEPALIVE_TIMEOUT_MS: '30000' });
    expect(s.keepAliveTimeout).toBe(30_000);
    expect(s.headersTimeout).toBe(31_000);
  });
});
