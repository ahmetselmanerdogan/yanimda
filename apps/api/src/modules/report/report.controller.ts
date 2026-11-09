import { Controller, Get, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';

import { DeviceTokenGuard } from '../device/device-token.guard';
import type { DevicePrincipal } from '../device/enrollment.service';
import { EnrollmentService } from '../device/enrollment.service';
import type { Actor } from '../profile/contacts';
import { ProfileGuard } from '../profile/profile.controller';
import { ProfileService } from '../profile/profile.service';
import { DailySummaryService } from './daily-summary.service';

/** T-062 aile ekranı (C-07): son günlerin özeti. Başka ailenin kişisi 404 (ProfileService erişim denetimi). */
@Controller('protected-persons')
@UseGuards(ProfileGuard)
export class DailySummaryController {
  constructor(
    @Inject(DailySummaryService) private readonly daily: DailySummaryService,
    @Inject(ProfileService) private readonly profile: ProfileService,
  ) {}

  /** GET /v1/protected-persons/{id}/daily-summaries?days=7 — ilk öğe bugün (kısmi). */
  @Get(':id/daily-summaries')
  async list(@Param('id') id: string, @Query('days') days: string | undefined, @Req() req: { actor?: Actor }) {
    await this.profile.get(req.actor!, id);
    return this.daily.recent(id, Number(days ?? 7));
  }
}

/** T-062 telefon ana ekranı (B-10): bugünün özet satırı (cihaz token'ı). */
@Controller('devices')
@UseGuards(DeviceTokenGuard)
export class DeviceSummaryController {
  constructor(@Inject(DailySummaryService) private readonly daily: DailySummaryService) {}

  /** GET /v1/devices/{id}/summary/today */
  @Get(':id/summary/today')
  async today(@Param('id') id: string, @Req() req: { device?: DevicePrincipal }) {
    EnrollmentService.assertSelf(req.device!, id);
    const [today] = await this.daily.recent(req.device!.protectedPersonId, 1);
    return today;
  }
}
