import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import { safeError } from '../../common/safe-error';
import { DB, type Db } from '../../db/client';
import { device } from '../../db/schema';
import { REDIS } from '../signal/idempotency.store';
import { PUSH, type PushPort } from './push.port';

/** Uyandırma aralığı (PUSH_WAKE_MS, 0 = kapalı). Apple arka plan push'larını saatte birkaç taneyle sınırlar. */
export const DEFAULT_WAKE_MS = 15 * 60_000;
/** Bu süre içinde sinyal göndermiş telefon uyandırılmaz. */
export const WAKE_STALE_MS = 10 * 60_000;

/**
 * T-073/T-053: iOS uygulaması arka planda sürekli çalışamaz. Sunucu, bir süredir sessiz iPhone'lara sessiz push
 * (content-available) gönderir; uygulama uyanıp canlılık sinyali ve hareketsizlik denetimini yapar.
 * Birden çok API örneğinde tek örnek gönderir (Redis kilidi). Olay motoru cihaz bilmez; bu cihaz modülündedir.
 */
@Injectable()
export class PushWakeService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('PushWake');
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PUSH) private readonly push: PushPort,
    @Optional() @Inject(REDIS) private readonly redis?: Pick<Redis, 'set'>,
  ) {}

  private get everyMs() {
    return Number(process.env.PUSH_WAKE_MS ?? DEFAULT_WAKE_MS);
  }

  onApplicationBootstrap() {
    const every = this.everyMs;
    if (!(every > 0)) return;
    const tick = () =>
      void this.tick(every)
        .catch((e) => this.log.warn(`Uyandırma turu: ${safeError(e)}`))
        .finally(() => (this.timer = setTimeout(tick, every)));
    this.timer = setTimeout(tick, every);
  }

  onModuleDestroy() {
    clearTimeout(this.timer);
  }

  private async tick(every: number) {
    if (this.redis) {
      try {
        if ((await this.redis.set('push:wake:lock', '1', 'PX', Math.max(1000, every - 1000), 'NX')) !== 'OK') return;
      } catch {
        // Redis yoksa yine gönder: çift uyandırma zararsız, hiç uyandırmamak değil
      }
    }
    await this.wakeStale(new Date(), every);
  }

  /** Sessiz iPhone'ları uyandırır; gönderilen sayısı. */
  async wakeStale(now = new Date(), ttlMs = DEFAULT_WAKE_MS, staleMs = WAKE_STALE_MS): Promise<number> {
    const cutoff = new Date(now.getTime() - staleMs);
    const rows = await this.db
      .select({ id: sql<string>`${device.id}::text` })
      .from(device)
      .where(
        and(
          eq(device.kind, 'IOS_PHONE'),
          isNull(device.revokedAt),
          eq(device.pushProvider, 'APNS'),
          isNotNull(device.pushToken),
          or(isNull(device.lastSeenAt), lt(device.lastSeenAt, cutoff)),
        ),
      );
    for (const r of rows) {
      await this.push.send({
        deviceId: r.id,
        priority: 'normal',
        data: { type: 'WAKE' },
        ttlSec: Math.max(60, Math.floor(ttlMs / 1000)),
      });
    }
    if (rows.length) this.log.log(`Uyandırma: ${rows.length} iPhone`);
    return rows.length;
  }
}
