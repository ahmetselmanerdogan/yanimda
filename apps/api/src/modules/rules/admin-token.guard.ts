import { timingSafeEqual } from 'node:crypto';

import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

/**
 * Paylaşılan yönetici anahtarı (`x-admin-token` = ADMIN_TOKEN) yalnız geliştirme, test ve CI betikleri içindir.
 * T-081 (G-4; ASVS 1.2.4, 2.5.4, 3.5.2, 4.3.1): üretimde (NODE_ENV=production) bu yol tamamen kapalıdır — MFA'sız,
 * paylaşımlı, süresiz bir sır yönetici yetkisi vermez; yönetici yalnız OIDC ADMIN (operations realm, parola + OTP).
 * Üretimde ADMIN_TOKEN tanımlıysa API açılmaz (`assertAdminTokenPolicy`, main.ts). ADMIN_TOKEN tanımsızsa da kapalı.
 */
export function adminTokenEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== 'production' && !!env.ADMIN_TOKEN;
}

/** Açılış denetimi: üretimde ADMIN_TOKEN dolu → hata (field-cipher / device-token açılış denetimleri gibi). */
export function assertAdminTokenPolicy(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === 'production' && env.ADMIN_TOKEN)
    throw new Error('ADMIN_TOKEN üretimde tanımlanamaz: yönetici uçları yalnız OIDC ADMIN (MFA) ile');
}

@Injectable()
export class AdminTokenGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const expected = process.env.ADMIN_TOKEN;
    const given = ctx.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>().headers[
      'x-admin-token'
    ];
    if (!adminTokenEnabled() || !expected || !given) throw new ForbiddenException('Yönetici yetkisi gerekli');
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ForbiddenException('Yönetici yetkisi gerekli');
    return true;
  }
}
