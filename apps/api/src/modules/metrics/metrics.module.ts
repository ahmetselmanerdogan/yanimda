import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { EventModule } from '../event/event.module';
import { ProtectionService } from '../event/protection.service';
import { OidcGuard, Roles, userOf, type UserRequest } from '../identity/oidc.guard';
import { AlertsService } from './alerts.service';
import { CoverageBoardService } from './coverage-board.service';
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
  constructor(
    @Inject(SupervisorService) private readonly supervisor: SupervisorService,
    @Inject(AlertsService) private readonly alerts: AlertsService,
    @Inject(ProtectionService) private readonly protection: ProtectionService,
    @Inject(CoverageBoardService) private readonly board: CoverageBoardService,
  ) {}

  /** GET /v1/supervisor/coverage — seviye başına kişi sayısı ve akşam planlı şarj (T-085, S4.11). */
  @Get('coverage')
  coverage() {
    return this.protection.coverage.supervisorSummary();
  }

  /**
   * GET /v1/supervisor/coverage/board — T-089 (S7.2) amir kapsama panosu: uyanıkken 20 dk+ YOK, kronik boşluk,
   * çevrimdışı telefon köprüleri, merdiven adımı başına ulaşılamama oranı, üstlenilmeyen P1 ve 112 bildirimleri.
   */
  @Get('coverage/board')
  coverageBoard() {
    return this.board.board();
  }

  /** GET /v1/supervisor/alerts?open=1 — kalıcı amir uyarıları (en yeni önce). */
  @Get('alerts')
  alertList(@Query('open') open?: string) {
    return this.alerts.list({ open: open === '1' || open === 'true' });
  }

  /** POST /v1/supervisor/alerts/{id}/ack — "gördüm" (audit). */
  @Post('alerts/:id/ack')
  @HttpCode(200)
  ack(@Param('id') id: string, @Req() req: UserRequest) {
    return this.alerts.ack(id, userOf(req).sub);
  }

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
  providers: [MetricsService, SupervisorService, AlertsService, CoverageBoardService],
  controllers: [SupervisorController],
  exports: [MetricsService, SupervisorService, AlertsService, CoverageBoardService],
})
export class MetricsModule {}
