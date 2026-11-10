import { Module } from '@nestjs/common';

import { EventModule } from '../event/event.module';
import { ProfileModule } from '../profile/profile.module';
import { WellnessController } from './wellness.controller';
import { WellnessService } from './wellness.service';

/** Düzenli "yanınızdayız" aramaları ve bildirimleri. */
@Module({
  imports: [EventModule, ProfileModule],
  providers: [WellnessService],
  controllers: [WellnessController],
  exports: [WellnessService],
})
export class WellnessModule {}
