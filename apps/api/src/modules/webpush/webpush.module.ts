import { Module } from '@nestjs/common';

import { WebPushController } from './webpush.controller';
import { PUSH_SENDER, vapidSenderFromEnv, WebPushService } from './webpush.service';

/** Personel web push (amir uyarıları). VAPID yoksa kapalı. */
@Module({
  providers: [{ provide: PUSH_SENDER, useFactory: () => vapidSenderFromEnv() }, WebPushService],
  controllers: [WebPushController],
  exports: [WebPushService],
})
export class WebPushModule {}
