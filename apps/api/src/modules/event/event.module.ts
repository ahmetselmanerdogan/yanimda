import { Module } from '@nestjs/common';

import { EventService } from './event.service';
import { ProtectionController } from './protection.controller';
import { ProtectionService } from './protection.service';

@Module({
  providers: [EventService, ProtectionService],
  controllers: [ProtectionController],
  exports: [EventService, ProtectionService],
})
export class EventModule {}
