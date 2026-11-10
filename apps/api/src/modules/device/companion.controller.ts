import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';

import { ProtectionService } from '../event/protection.service';
import { CompanionService } from './companion.service';
import { type DeviceRequest, DeviceTokenGuard } from './device-token.guard';
import { EnrollmentService } from './enrollment.service';

interface ResStatus {
  status(code: number): ResStatus;
}

/** Eşlikçi telefonun uçları (T-042, T-043, T-044): saat kaydı, kurulum durumu, koruma durumu. */
@Controller('devices')
@UseGuards(DeviceTokenGuard)
export class CompanionController {
  constructor(
    @Inject(CompanionService) private readonly companion: CompanionService,
    @Inject(ProtectionService) private readonly protection: ProtectionService,
  ) {}

  /** POST /v1/devices/{telefonId}/companions — eşleşik saati aynı kişiye kaydeder. Yeni 201, yeniden 200. */
  @Post(':id/companions')
  async enrollCompanion(
    @Param('id') id: string,
    @Req() req: DeviceRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: ResStatus,
  ) {
    EnrollmentService.assertSelf(req.device!, id);
    const r = await this.companion.enrollCompanion(req.device!, body);
    res.status(r.created ? 201 : 200);
    return r.body;
  }

  /** PATCH /v1/devices/{id}/setup-state — kurulum sihirbazı ilerlemesi; eksik izin → aileye F-PERM. */
  @Patch(':id/setup-state')
  @HttpCode(204)
  async setupState(@Param('id') id: string, @Req() req: DeviceRequest, @Body() body: unknown) {
    EnrollmentService.assertSelf(req.device!, id);
    await this.companion.setSetupState(req.device!, body);
  }

  /** GET /v1/devices/{id}/status — kişinin koruma durumu (D-05), cihaz token'ıyla (ana ekran senkronu). */
  @Get(':id/status')
  status(@Param('id') id: string, @Req() req: DeviceRequest) {
    EnrollmentService.assertSelf(req.device!, id);
    return this.protection.status(req.device!.protectedPersonId);
  }
}
