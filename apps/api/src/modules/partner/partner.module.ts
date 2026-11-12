import { Module } from '@nestjs/common';

import { FieldCipher } from '../../common/field-cipher';
import { SignalModule } from '../signal/signal.module';
import { PartnerOpsController, PartnerWebhookController, VendorLinkController } from './partner.controller';
import { PartnerHealthService } from './partner-health.service';
import { PartnerWebhookService } from './partner-webhook.service';
import { PendantMaintenanceService } from './pendant-maintenance.service';
import { VENDOR_CIPHER, VendorLinkService } from './vendor-link.service';

/**
 * T-085 OEM ortak cihazları (docs/07 Bölüm 2, S4.9): imzalı ortak webhook'u, üretici bağlantısı, ortak gecikmesi
 * (O-OEM-LATENCY) ve 12 ay pilli kolye bakımı (iş emri, aylık test hatırlatması). Ortak adaptörleri cihaz modülünün
 * adaptör kaydındadır (DeviceService); sinyaller SignalService'ten (aynı outbox hattı) geçer.
 */
@Module({
  imports: [SignalModule],
  controllers: [PartnerWebhookController, VendorLinkController, PartnerOpsController],
  providers: [
    PartnerWebhookService,
    VendorLinkService,
    PartnerHealthService,
    PendantMaintenanceService,
    { provide: VENDOR_CIPHER, useFactory: () => FieldCipher.fromEnv() },
  ],
})
export class PartnerModule {}
