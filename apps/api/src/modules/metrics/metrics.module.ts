import { Controller, Get, Inject, Module, UseGuards } from '@nestjs/common';

import { EventModule } from '../event/event.module';
import { OidcGuard, Roles } from '../identity/oidc.guard';
import { MetricsService } from './metrics.service';
import { SupervisorService } from './supervisor.service';

/** GET /v1/supervisor/dashboard — amir özeti (T-025). */
@Controller('supervisor')
@UseGuards(OidcGuard)
@Roles('SUPERVISOR', 'ADMIN')
export class SupervisorController {
  constructor(@Inject(SupervisorService) private readonly supervisor: SupervisorService) {}

  @Get('dashboard')
  dashboard() {
    return this.supervisor.dashboard();
  }
}

/** T-025 SLA ve metrikler (E-09, D-11). */
@Module({
  imports: [EventModule],
  providers: [MetricsService, SupervisorService],
  controllers: [SupervisorController],
  exports: [MetricsService],
})
export class MetricsModule {}
