import { Body, Controller, Get, Inject, Module, Param, Post, Req, UseGuards } from '@nestjs/common';

import { EventModule } from '../event/event.module';
import type { UserRequest } from '../identity/oidc.guard';
import type { Actor } from '../profile/contacts';
import { ProfileGuard } from '../profile/profile.controller';
import { ProfileModule } from '../profile/profile.module';
import { FalseAlarmService } from './false-alarm.service';

type ActorRequest = UserRequest & { actor?: Actor };

/** T-071 aile uçları (ProfileGuard: aile yalnız kendi kişisinin olayları; başka ailenin olayı 404). */
@Controller()
@UseGuards(ProfileGuard)
export class FalseAlarmController {
  constructor(@Inject(FalseAlarmService) private readonly falseAlarms: FalseAlarmService) {}

  /** C-12 POST /v1/events/{id}/feedback — { real: boolean } ("Gerçek miydi?"). */
  @Post('events/:id/feedback')
  feedback(@Param('id') id: string, @Body() body: unknown, @Req() req: ActorRequest) {
    return this.falseAlarms.feedback(req.actor!, id, body);
  }

  /** GET /v1/protected-persons/{id}/false-alarms — son 30 günün yanlış alarm oranı. */
  @Get('protected-persons/:id/false-alarms')
  stats(@Param('id') id: string, @Req() req: ActorRequest) {
    return this.falseAlarms.personStats(req.actor!, id);
  }
}

/** T-071 (D-07, C-12) yanlış alarm sayacı, aile geri bildirimi ve eşik görüşmesi. */
@Module({
  imports: [EventModule, ProfileModule],
  providers: [FalseAlarmService],
  controllers: [FalseAlarmController],
})
export class FalseAlarmModule {}
