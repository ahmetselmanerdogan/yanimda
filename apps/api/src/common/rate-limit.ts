import {
  applyDecorators,
  type CallHandler,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type NestInterceptor,
  SetMetadata,
  UseInterceptors,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type Redis from 'ioredis';
import type { Observable } from 'rxjs';

import { REDIS } from '../modules/signal/idempotency.store';
import { safeError } from './safe-error';

/**
 * T-081 (ASVS 11.1.4, 8.1.4, 2.2.1) hız sınırı: Redis sabit pencere (tüm API kopyaları ortak). Sınır aşılınca 429 +
 * `Retry-After`. Redis yoksa AÇIK kalır: hız sınırı acil akışını asla durdurmaz (olay kaybı sıfır). Alarm içeren
 * sinyal partileri (SOS, düşme, hareketsizlik, iptal, iyiyim, geri arama) hiç sayılmaz.
 */
export interface RateLimitOptions {
  /** Anahtar adı (Redis: `rl:<name>:<kimlik>`). */
  name: string;
  limit: number;
  windowSec: number;
  /** Kimlik: oturum açmış kullanıcı (`sub`), cihaz, yol parametresi veya istemci IP'si. */
  by: 'user' | 'device' | 'ip' | `param:${string}`;
  exempt?: (req: unknown) => boolean;
}

const ALARM_KINDS = new Set(['SOS', 'FALL', 'INACTIVITY', 'CANCEL', 'OK', 'CALLBACK_REQUEST']);

export function alarmBatch(body: unknown): boolean {
  return Array.isArray(body) && body.some((s) => ALARM_KINDS.has((s as { kind?: string })?.kind ?? ''));
}

export class RateLimiter {
  private readonly log = new Logger('RateLimit');
  private lastWarn = 0;
  constructor(private readonly redis: Pick<Redis, 'multi'>) {}

  async hit(name: string, id: string, limit: number, windowSec: number) {
    const key = `rl:${name}:${id}`;
    try {
      const r = await this.redis.multi().set(key, '0', 'EX', windowSec, 'NX').incr(key).ttl(key).exec();
      const n = Number(r?.[1]?.[1] ?? 0);
      const ttl = Number(r?.[2]?.[1] ?? windowSec);
      return { allowed: n <= limit, retryAfterSec: Math.max(1, ttl) };
    } catch (e) {
      if (Date.now() - this.lastWarn > 30_000) this.log.warn(`Hız sınırı devre dışı (Redis): ${safeError(e)}`);
      this.lastWarn = Date.now();
      return { allowed: true, retryAfterSec: 0 };
    }
  }
}

type Req = {
  user?: { sub?: string };
  device?: { deviceId?: string };
  params?: Record<string, string>;
  ip?: string;
};

function identity(req: Req, by: RateLimitOptions['by']): string {
  if (by === 'user' && req.user?.sub) return `u:${req.user.sub}`;
  if (by === 'device' && req.device?.deviceId) return `d:${req.device.deviceId}`;
  if (by.startsWith('param:')) {
    const v = req.params?.[by.slice(6)];
    if (v) return `p:${v}`;
  }
  return `ip:${req.ip ?? 'unknown'}`;
}

/** Test ve el ile kurulum için: seçeneklerle bağlı interceptor. */
export function rateLimitInterceptor(limiter: RateLimiter, o: RateLimitOptions) {
  return {
    async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
      const http = ctx.switchToHttp();
      const req = http.getRequest<Req>();
      // Yük testi (k6, tek IP'den binlerce cihaz) için kapatılabilir; üretimde açık kalır.
      if (process.env.RATE_LIMIT !== 'off' && !o.exempt?.(req)) {
        const r = await limiter.hit(o.name, identity(req, o.by), o.limit, o.windowSec);
        if (!r.allowed) {
          http
            .getResponse<{ setHeader(k: string, v: string): void }>()
            .setHeader('Retry-After', String(r.retryAfterSec));
          throw new HttpException('Çok fazla istek, daha sonra yeniden deneyin', HttpStatus.TOO_MANY_REQUESTS);
        }
      }
      return next.handle();
    },
  };
}

const RATE_LIMIT = 'yanimda:rate-limit';

@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  private readonly limiter: RateLimiter;
  constructor(
    @Inject(REDIS) redis: Redis,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {
    this.limiter = new RateLimiter(redis);
  }

  intercept(ctx: ExecutionContext, next: CallHandler) {
    const o = this.reflector.get<RateLimitOptions | undefined>(RATE_LIMIT, ctx.getHandler());
    if (!o) return next.handle();
    return rateLimitInterceptor(this.limiter, o).intercept(ctx, next);
  }
}

/** Uç bazlı hız sınırı. Guard'lardan SONRA çalışır (interceptor): `user` / `device` kimliği hazırdır. */
export const RateLimit = (o: RateLimitOptions) =>
  applyDecorators(SetMetadata(RATE_LIMIT, o), UseInterceptors(RateLimitInterceptor));

/** Sağlayıcı webhook'ları (CPaaS, SMS, ödeme, ön eleme): IP başına bol sınır; imza denetimi ayrıca yapılır. */
export const WEBHOOK_LIMIT: RateLimitOptions = { name: 'webhook', limit: 1200, windowSec: 60, by: 'ip' };
