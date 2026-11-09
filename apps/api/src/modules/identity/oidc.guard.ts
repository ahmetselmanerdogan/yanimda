import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AdminTokenGuard } from '../rules/admin-token.guard';
import { OidcVerifier, type Role, TokenError, type UserPrincipal } from './oidc-verifier';

export const ROLES_KEY = 'yanimda:roles';
/** Uca erişebilecek roller (herhangi biri yeter). Boşsa geçerli token yeterlidir. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export interface UserRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: UserPrincipal;
}

export const bearer = (req: UserRequest): string | undefined => {
  const h = req.headers.authorization;
  const v = Array.isArray(h) ? h[0] : h;
  const m = v && /^Bearer\s+(\S+)$/i.exec(v);
  return m ? m[1] : undefined;
};

/** Operatör kimliği token'dan (T-020): `X-Operator-Id` kaldırıldı. */
export const userOf = (req: UserRequest): UserPrincipal => req.user!; // OidcGuard doldurur

/**
 * T-020 OidcGuard: `Authorization: Bearer <Keycloak erişim token'ı>` zorunlu; `req.user` doldurulur.
 * Token yok/geçersiz → 401, rol yetmiyor → 403. Ayrıntı istemciye verilmez, log'a kimlik yazılmaz.
 */
@Injectable()
export class OidcGuard implements CanActivate {
  constructor(
    @Inject(OidcVerifier) private readonly verifier: OidcVerifier,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<UserRequest>();
    req.user = await authenticate(this.verifier, req);
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (roles?.length && !roles.some((r) => req.user!.roles.includes(r))) throw new ForbiddenException('Yetki yok');
    return true;
  }
}

export async function authenticate(verifier: OidcVerifier, req: UserRequest): Promise<UserPrincipal> {
  const token = bearer(req);
  if (!token || !verifier.enabled) throw new UnauthorizedException('Giriş gerekli');
  try {
    return await verifier.verify(token);
  } catch (e) {
    if (e instanceof TokenError) throw new UnauthorizedException('Giriş gerekli');
    throw e;
  }
}

/**
 * Yönetici uçları: OIDC ADMIN rolü veya (betikler, CI için) `x-admin-token` = ADMIN_TOKEN.
 * Bearer gelirse yalnız OIDC denenir; geçersizse paylaşılan token'a düşülmez.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  private readonly shared = new AdminTokenGuard();
  constructor(@Inject(OidcVerifier) private readonly verifier: OidcVerifier) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<UserRequest>();
    if (!req.headers.authorization) return this.shared.canActivate(ctx);
    req.user = await authenticate(this.verifier, req);
    if (!req.user.roles.includes('ADMIN')) throw new ForbiddenException('Yönetici yetkisi gerekli');
    return true;
  }
}
