import { Module } from '@nestjs/common';

import { EventModule } from '../event/event.module';
import { MetricsModule } from '../metrics/metrics.module';
import { QueueController } from './queue.controller';
import { QueueGateway } from './queue.gateway';

/** T-022 canlı kuyruk: REST (sayfalı) + WebSocket. */
@Module({ imports: [EventModule, MetricsModule], providers: [QueueGateway], controllers: [QueueController] })
export class QueueModule {}
