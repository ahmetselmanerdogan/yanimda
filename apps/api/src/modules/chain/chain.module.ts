import { Module } from '@nestjs/common';

import { EventModule } from '../event/event.module';
import { ProfileModule } from '../profile/profile.module';
import { TelephonyModule } from '../telephony/telephony.module';
import { ChainController } from './chain.controller';
import { ChainService } from './chain.service';

/** T-021 prosedür zinciri ve operatör işlemleri (D-03, D-04). */
@Module({
  imports: [EventModule, TelephonyModule, ProfileModule],
  providers: [ChainService],
  controllers: [ChainController],
  exports: [ChainService],
})
export class ChainModule {}
