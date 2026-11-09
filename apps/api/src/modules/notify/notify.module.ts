import { Module } from '@nestjs/common';

import { TelephonyModule } from '../telephony/telephony.module';
import { NotifyController, NotifyWebhookController } from './notify.controller';
import { NotifyService } from './notify.service';

/**
 * T-053 (D-08) bildirimler: aile push (FCM), SMS ve sesli (CPaaS), kişinin cihazına push (PUSH, DeviceModule).
 * FCM ve PUSH global DeviceModule'den, CPAAS TelephonyModule'den.
 */
@Module({
  imports: [TelephonyModule],
  controllers: [NotifyController, NotifyWebhookController],
  providers: [NotifyService],
  exports: [NotifyService],
})
export class NotifyModule {}
