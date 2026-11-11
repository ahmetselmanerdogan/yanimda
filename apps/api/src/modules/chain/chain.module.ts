import { Module } from '@nestjs/common';

import { EventModule } from '../event/event.module';
import { ProfileModule } from '../profile/profile.module';
import { TelephonyModule } from '../telephony/telephony.module';
import { ChainController } from './chain.controller';
import { ChainService } from './chain.service';
import { DevicePromptService } from './device-prompt.service';
import { DispatchService } from './dispatch.service';
import { LadderService } from './ladder.service';

/**
 * T-021 prosedür zinciri ve operatör işlemleri (D-03, D-04); T-087 ulaşılamama merdiveni (sistem adımları); T-090
 * cihaz sorusu (DEVICE_PROMPT → PROMPT push).
 */
@Module({
  imports: [EventModule, TelephonyModule, ProfileModule],
  providers: [ChainService, DispatchService, LadderService, DevicePromptService],
  controllers: [ChainController],
  exports: [ChainService, DispatchService],
})
export class ChainModule {}
