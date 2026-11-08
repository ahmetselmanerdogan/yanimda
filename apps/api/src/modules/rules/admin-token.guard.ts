import { timingSafeEqual } from 'node:crypto';

import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

/**
 * Geçici yönetici koruması: `x-admin-token` başlığı ADMIN_TOKEN ile eşleşmeli. ADMIN_TOKEN tanımsızsa
 * yönetici uçları tamamen kapalıdır (güvenli varsayılan). T-020'de OIDC + @Roles('ADMIN') ile değiştirilir.
 */
@Injectable()
export class AdminTokenGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const expected = process.env.ADMIN_TOKEN;
    const given = ctx.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>().headers[
      'x-admin-token'
    ];
    if (!expected || !given) throw new ForbiddenException('Yönetici yetkisi gerekli');
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ForbiddenException('Yönetici yetkisi gerekli');
    return true;
  }
}
