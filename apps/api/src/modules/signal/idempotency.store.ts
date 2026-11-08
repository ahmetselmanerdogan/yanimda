import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { safeError } from '../../common/safe-error';

export const REDIS = Symbol('REDIS');

/**
 * D-01 idempotency: Redis `SET idem:<key> NX EX`.
 *
 * Kayıp sıfır için iki aşamalı: önce kısa ömürlü "pending" (60 sn) alınır, veritabanı commit'inden sonra
 * 24 saatlik "done" yazılır; yazım başarısızsa anahtar silinir. Süreç commit öncesi ölürse "pending" 60 sn'de
 * düşer ve cihazın yeniden denemesi geçer. Redis erişilemezse `unavailable` döner: sinyal yine yazılır,
 * tekrarı veritabanının tekil indeksi (idempotency_key, time) yakalar.
 */
export type ClaimResult = 'claimed' | 'duplicate' | 'pending' | 'unavailable';

export const IDEM_TTL_SEC = 24 * 3600;
export const PENDING_TTL_SEC = 60;

export class IdempotencyStore {
  private readonly log = new Logger('Idempotency');

  constructor(private readonly redis: Pick<Redis, 'set' | 'get' | 'del'>) {}

  private k(key: string) {
    return `idem:${key}`;
  }

  async claim(key: string): Promise<ClaimResult> {
    try {
      if ((await this.redis.set(this.k(key), 'pending', 'EX', PENDING_TTL_SEC, 'NX')) === 'OK') return 'claimed';
      return (await this.redis.get(this.k(key))) === 'pending' ? 'pending' : 'duplicate';
    } catch (e) {
      this.log.warn(`Redis erişilemiyor, veritabanı tekilliğine düşülüyor: ${safeError(e)}`);
      return 'unavailable';
    }
  }

  async complete(key: string): Promise<void> {
    await this.redis.set(this.k(key), 'done', 'EX', IDEM_TTL_SEC).catch(() => undefined);
  }

  async release(key: string): Promise<void> {
    await this.redis.del(this.k(key)).catch(() => undefined);
  }
}
