import { Controller, Get, Inject, Module, Param, Query, Req, UseGuards } from '@nestjs/common';

import type { Actor } from '../profile/contacts';
import { ProfileGuard } from '../profile/profile.controller';
import { ProfileModule } from '../profile/profile.module';
import { FamilyGateway } from './family.gateway';
import { FamilyService } from './family.service';

/** T-061 aile olay uçları (ProfileGuard: aile kendi kişisi, yönetici hepsi; başka ailenin kişisi/olayı 404). */
@Controller('protected-persons/:id/events')
@UseGuards(ProfileGuard)
export class FamilyEventsController {
  constructor(@Inject(FamilyService) private readonly family: FamilyService) {}

  @Get()
  list(@Param('id') id: string, @Query('limit') limit: string | undefined, @Req() req: { actor?: Actor }) {
    return this.family.events(req.actor!, id, limit ? Number(limit) : 20);
  }

  @Get(':eventId')
  get(@Param('id') id: string, @Param('eventId') eventId: string, @Req() req: { actor?: Actor }) {
    return this.family.event(req.actor!, id, eventId);
  }
}

/** T-061 aile uygulaması: olay listesi/ayrıntısı ve canlı akış (`/v1/ws/family`). */
@Module({
  imports: [ProfileModule],
  providers: [FamilyService, FamilyGateway],
  controllers: [FamilyEventsController],
  exports: [FamilyService],
})
export class FamilyModule {}
