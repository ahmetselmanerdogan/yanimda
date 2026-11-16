import { Controller, Get, Header, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

import { PG_POOL } from '../db/client';
import { REDIS } from '../modules/signal/idempotency.store';

/**
 * T-083 izleme: kimliksiz canlılık ve hazırlık. Yanıtta sürüm, adres veya hata ayrıntısı yok.
 * - GET /v1/health: süreç HTTP'ye yanıt veriyor (bağımlılıklara bakmaz; yeniden başlatma kararı).
 * - GET /v1/ready: veritabanı yoksa 503 (trafik bu örneğe gelmesin). Redis yoksa 200 "degraded": sinyal alımı
 *   veritabanı tekilliğine düşer (D-01); Redis kesintisinde tüm örnekler hazırlıktan çıkıp hizmet tümden durmasın.
 */
@Controller()
export class HealthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pick<Pool, 'query'>,
    @Inject(REDIS) private readonly redis: Pick<Redis, 'ping'>,
  ) {}

  @Get('health')
  @Header('Cache-Control', 'no-store')
  health() {
    return { status: 'ok' };
  }

  @Get('ready')
  @Header('Cache-Control', 'no-store')
  async ready() {
    const db = await this.pool.query('SELECT 1').then(
      () => true,
      () => false,
    );
    if (!db) throw new ServiceUnavailableException();
    const redis = await this.redis.ping().then(
      () => true,
      () => false,
    );
    return redis ? { status: 'ok', db: 'ok', redis: 'ok' } : { status: 'degraded', db: 'ok', redis: 'down' };
  }
}
