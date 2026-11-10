import { Module } from '@nestjs/common';

import { MetricsModule } from '../metrics/metrics.module';
import { InboundWebhookController, OperatorsController, TelephonyConfigController } from './inbound.controller';
import { InboundService } from './inbound.service';
import { TelephonyModule } from './telephony.module';

/**
 * T-051 kalan + T-052 (E-05): gelen SOS aramalarının müsait operatöre yönlendirilmesi, operatörün kendi durumu,
 * telefoni yapılandırması (masa hattı, 112). Telefoni modülünden ayrı tutulur (giden arama dokunulmaz).
 */
@Module({
  imports: [TelephonyModule, MetricsModule],
  providers: [InboundService],
  controllers: [InboundWebhookController, TelephonyConfigController, OperatorsController],
  exports: [InboundService],
})
export class InboundModule {}
