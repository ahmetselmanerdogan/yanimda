import { Body, Controller, Get, Inject, Module, Param, Put, Req, UseGuards } from '@nestjs/common';

import { EventModule } from '../event/event.module';
import { OidcGuard, Roles, userOf, type UserRequest } from '../identity/oidc.guard';
import { MetricsService } from './metrics.service';
import { SupervisorService } from './supervisor.service';

/**
 * E-11 amir panosu (T-025, T-074). Konsol panoyu WS'den 5 sn'de bir alır; bu uçlar ilk yükleme ve eylemler içindir.
 * Olayı kuyruğa döndürme: `POST /v1/events/{id}/unclaim` (queue modülü).
 */
@Controller('supervisor')
@UseGuards(OidcGuard)
@Roles('SUPERVISOR', 'ADMIN')
export class SupervisorController {
  constructor(@Inject(SupervisorService) private readonly supervisor: SupervisorService) {}

  @Get('dashboard')
  dashboard() {
    return this.supervisor.dashboard();
  }

  /** Operatör durumu: AVAILABLE / BREAK / OFFLINE (audit). */
  @Put('operators/:sub/status')
  status(@Param('sub') sub: string, @Body() body: { status?: unknown } = {}, @Req() req: UserRequest) {
    return this.supervisor.setStatus(sub, body?.status, userOf(req).sub);
  }

  /** Yedek merkeze taşma bayrağı (v1.0'da işaret; yönlendirme v2.0). */
  @Put('overflow')
  overflow(@Body() body: { enabled?: unknown } = {}, @Req() req: UserRequest) {
    return this.supervisor.setOverflow(body?.enabled, userOf(req).sub);
  }
}

/** T-025 SLA ve metrikler (E-09, D-11), T-074 amir panosu. */
@Module({
  imports: [EventModule],
  providers: [MetricsService, SupervisorService],
  controllers: [SupervisorController],
  exports: [MetricsService, SupervisorService],
})
export class MetricsModule {}
