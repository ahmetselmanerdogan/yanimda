import { Body, Controller, Get, Inject, Module, Param, Put, Req, UseGuards } from '@nestjs/common';

import type { UserRequest } from '../identity/oidc.guard';
import type { Actor } from '../profile/contacts';
import { ProfileGuard } from '../profile/profile.controller';
import { ProfileModule } from '../profile/profile.module';
import { LearningService } from './learning.service';

/** T-070 aile uçları (ProfileGuard: aile kendi kişisi, yönetici hepsi; başka ailenin kişisi 404). */
@Controller('protected-persons/:id')
@UseGuards(ProfileGuard)
export class LearningController {
  constructor(@Inject(LearningService) private readonly learning: LearningService) {}

  /** GET /v1/protected-persons/{id}/learning — öğrenme modu ve kişiye özel eşikler (profil raporu özeti). */
  @Get('learning')
  summary(@Param('id') id: string, @Req() req: UserRequest & { actor?: Actor }) {
    return this.learning.summary(req.actor!, id);
  }

  /** PUT /v1/protected-persons/{id}/thresholds — aile ayarı (öğrenme bu alana dokunmaz; null → varsayılan). */
  @Put('thresholds')
  set(@Param('id') id: string, @Body() body: unknown, @Req() req: UserRequest & { actor?: Actor }) {
    return this.learning.setThresholds(req.actor!, id, body);
  }
}

/** T-070 (D-06) öğrenme modu: günlük eşik öğrenme, dönem sonu profil raporu, aile eşik ayarı. */
@Module({
  imports: [ProfileModule],
  providers: [LearningService],
  controllers: [LearningController],
  exports: [LearningService],
})
export class LearningModule {}
