import { Global, Logger, Module } from '@nestjs/common';

import type { Db } from '../../db/client';
import { DB } from '../../db/client';
import { ApnsClient, apnsConfigFromEnv } from './apns/apns-client';
import { DeviceService } from './device.service';
import { DevicePush } from './device-push';
import { PUSH } from './push.port';
import { PushWakeService } from './push-wake.service';

/**
 * T-015 cihaz adaptörleri + T-053 (cihaz tarafı) push. PUSH: cihazın token'ına göre APNs (APNS_* tanımlıysa);
 * yapılandırılmamış kanallar (geliştirme, FCM) kaydedilir.
 */
@Global()
@Module({
  providers: [
    DeviceService,
    {
      provide: PUSH,
      inject: [DB],
      useFactory: (db: Db) => {
        const cfg = apnsConfigFromEnv();
        if (!cfg && process.env.NODE_ENV === 'production')
          new Logger('DevicePush').warn('APNS_* tanımlı değil: iPhone uyandırma ve bildirimleri gönderilmeyecek');
        return new DevicePush(db, cfg ? new ApnsClient(cfg) : null);
      },
    },
    PushWakeService,
  ],
  exports: [DeviceService, PUSH, PushWakeService],
})
export class DeviceModule {}
