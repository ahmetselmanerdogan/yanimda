import { type CanActivate, type ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';

import { type DevicePrincipal, EnrollmentService } from './enrollment.service';
import { simulatorEnabled } from './simulator-mode';

export interface DeviceRequest {
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  device?: DevicePrincipal;
}

const authHeader = (req: DeviceRequest) => {
  const h = req.headers.authorization;
  return Array.isArray(h) ? h[0] : h;
};

/** T-041 DeviceTokenGuard: geçerli cihaz token'ı zorunlu; `req.device` doldurulur. */
@Injectable()
export class DeviceTokenGuard implements CanActivate {
  constructor(@Inject(EnrollmentService) private readonly enrollment: EnrollmentService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<DeviceRequest>();
    const h = authHeader(req);
    if (!h) throw new UnauthorizedException('Cihaz token gerekli');
    req.device = await this.enrollment.authenticate(h);
    return true;
  }
}

/**
 * POST /v1/signals: token varsa doğrulanır (geçersiz → 401, simülatör açık olsa da). Token yoksa yalnız
 * simülatör açıkken (geliştirme, test) ve kayıtla gelmemiş cihazlar için kabul edilir; üretimde 401.
 */
@Injectable()
export class SignalAuthGuard implements CanActivate {
  constructor(@Inject(EnrollmentService) private readonly enrollment: EnrollmentService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<DeviceRequest>();
    const h = authHeader(req);
    if (!h) {
      if (!simulatorEnabled()) throw new UnauthorizedException('Cihaz token gerekli');
      await this.enrollment.assertTokenless(req.body); // kayıtlı/kaldırılmış cihaz token'sız gönderemez
      return true;
    }
    req.device = await this.enrollment.authenticate(h);
    return true;
  }
}
