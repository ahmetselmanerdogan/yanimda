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
import { OidcGuard, Roles, userOf, type UserRequest } from '../identity/oidc.guard';
import type { Actor } from '../profile/contacts';
import { ProfileGuard } from '../profile/profile.controller';
import { ProfileModule } from '../profile/profile.module';
import { ProfileService } from '../profile/profile.service';
import { VitalsService } from './vitals.service';

type ActorRequest = UserRequest & { actor?: Actor };
const actorId = (a: Actor) => ('id' in a && a.id ? a.id : 'admin');

/**
 * T-092 (docs/07 S6.8) operatör değer görünümü: yalnız açık olayda (kapalı 403), değer olayı veya değer kuralı / vurgu
 * eklenmiş olayda (yoksa 404). Özellik kapalıyken 404.
 */
@Controller('events')
@UseGuards(OidcGuard)
@Roles('OPERATOR', 'SUPERVISOR')
export class VitalsEventController {
  constructor(@Inject(VitalsService) private readonly vitals: VitalsService) {}

  /** GET /v1/events/{id}/vitals — son 2 saatin 5 dk ortancaları, taban çizgisi, kalite rozeti. */
  @Get(':id/vitals')
  get(@Param('id') id: string, @Req() req: UserRequest) {
    const u = userOf(req);
    return this.vitals.eventVitals(id, { sub: u.sub, supervisor: u.roles.includes('SUPERVISOR') });
  }
}

/** T-092 aile uçları (ProfileGuard: aile kendi kişisi; başka ailenin kişisi 404). Özellik kapalıyken eğilimler 404. */
@Controller('protected-persons/:id')
@UseGuards(ProfileGuard)
export class VitalsFamilyController {
  constructor(
    @Inject(VitalsService) private readonly vitals: VitalsService,
    @Inject(ProfileService) private readonly profile: ProfileService,
  ) {}

  /** GET /v1/protected-persons/{id}/trends/weekly?weeks=4 — haftalık eğilim (sağlık-amaçlı not kodu ile). */
  @Get('trends/weekly')
  async weekly(@Param('id') id: string, @Query('weeks') weeks: string | undefined, @Req() req: ActorRequest) {
    await this.profile.authorize(req.actor!, id);
    return this.vitals.weeklyTrends(id, Number(weeks ?? 4));
  }

  /** GET /v1/protected-persons/{id}/vital-settings */
  @Get('vital-settings')
  async settings(@Param('id') id: string, @Req() req: ActorRequest) {
    await this.profile.authorize(req.actor!, id);
    return this.vitals.settings(id);
  }

  /** PUT /v1/protected-persons/{id}/vital-settings — hesap sahibi (OWNER) veya yönetici. */
  @Put('vital-settings')
  async setSettings(@Param('id') id: string, @Body() body: unknown, @Req() req: ActorRequest) {
    await this.profile.authorizeOwner(req.actor!, id);
    return this.vitals.setSettings(id, body, actorId(req.actor!));
  }
}

/** T-092 (S6.7) amirin eşik incelemesi kuyruğu (haftalık sınır, değerlerde tekrarlayan yanlış alarm). */
@Controller('supervisor/vital-reviews')
@UseGuards(OidcGuard)
@Roles('SUPERVISOR', 'ADMIN')
export class VitalsReviewController {
  constructor(@Inject(VitalsService) private readonly vitals: VitalsService) {}

  /** GET /v1/supervisor/vital-reviews?open=1 */
  @Get()
  list(@Query('open') open?: string) {
    return this.vitals.reviews(open !== '0' && open !== 'false');
  }

  /** POST /v1/supervisor/vital-reviews/{id}/resolve — { note? } */
  @Post(':id/resolve')
  @HttpCode(200)
  resolve(@Param('id') id: string, @Body() body: unknown, @Req() req: UserRequest) {
    return this.vitals.resolveReview(id, userOf(req).sub, body);
  }
}

/**
 * T-092 (docs/07 S6) değer kuralları — bayrakla kapalı (kural paketi `vitals.enabled`, ortam VITALS_ENABLED); yazılı
 * mevzuat görüşü olmadan açılmaz.
 */
@Module({
  imports: [EventModule, ProfileModule],
  providers: [VitalsService],
  controllers: [VitalsEventController, VitalsFamilyController, VitalsReviewController],
  exports: [VitalsService],
})
export class VitalsModule {}
