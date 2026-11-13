import { Module } from '@nestjs/common';

import { EventModule } from '../event/event.module';
import { MetricsModule } from '../metrics/metrics.module';
import { AssignmentService } from './assignment.service';
import { QueueController } from './queue.controller';
import { QueueGateway } from './queue.gateway';

/** T-022 canlı kuyruk: REST (sayfalı) + WebSocket; 0039 otomatik atama. */
@Module({
  imports: [EventModule, MetricsModule],
  providers: [QueueGateway, AssignmentService],
  controllers: [QueueController],
  exports: [AssignmentService],
})
export class QueueModule {}
