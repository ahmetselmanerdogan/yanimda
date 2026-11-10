import { Module } from '@nestjs/common';

import { EventModule } from '../event/event.module';
import { TelephonyModule } from '../telephony/telephony.module';
import { ScreeningController, ScreeningWebhookController } from './screening.controller';
import { ScreeningService } from './screening.service';

/**
 * T-072 (D-12) otomatik sesli ön eleme: INACTIVITY ve WATCH_OFF'ta (asla SOS/FALL) operatörden önce kişiye sesli
 * arama. Açılışta olay motoruna `VoiceScreener` olarak bağlanır; telefoni kapalıysa (CPAAS_PROVIDER=off) ön eleme
 * yapılmaz, olay eskisi gibi kuyruğa düşer.
 */
@Module({
  imports: [EventModule, TelephonyModule],
  providers: [ScreeningService],
  controllers: [ScreeningWebhookController, ScreeningController],
})
export class ScreeningModule {}
