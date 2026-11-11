import { Module } from '@nestjs/common';

import { AbsorbedSourceService } from './absorbed-source.service';
import { EventService } from './event.service';
import { ProtectionController } from './protection.controller';
import { ProtectionService } from './protection.service';

@Module({
  providers: [EventService, ProtectionService, AbsorbedSourceService],
  controllers: [ProtectionController],
  exports: [EventService, ProtectionService],
})
export class EventModule {}
