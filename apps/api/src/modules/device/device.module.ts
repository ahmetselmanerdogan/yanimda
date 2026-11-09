import { Global, Logger, Module } from '@nestjs/common';

import type { Db } from '../../db/client';
import { DB } from '../../db/client';
import { FCM, FcmClient, fcmConfigFromEnv } from '../notify/fcm-client';
import { ApnsClient, apnsConfigFromEnv } from './apns/apns-client';
import { DeviceService } from './device.service';
import { DevicePush } from './device-push';
import { PUSH } from './push.port';
import { PushWakeService } from './push-wake.service';

/**
 * T-015 cihaz adaptörleri + T-053 (cihaz tarafı) push. PUSH: cihazın token'ına göre APNs (APNS_* tanımlıysa);
 * FCM_* tanımlıysa FCM; yapılandırılmamış kanallar (geliştirme) kaydedilir.
 */
@Global()
@Module({
  providers: [
    DeviceService,
    {
      provide: FCM,
      useFactory: () => {
        const cfg = fcmConfigFromEnv();
        if (!cfg && process.env.NODE_ENV === 'production')
          new Logger('Push').warn(
            'FCM_* tanımlı değil: Android ve aile push bildirimleri gönderilmeyecek (SMS yedeği)',
          );
        return cfg ? new FcmClient(cfg) : null;
      },
    },
    {
      provide: PUSH,
      inject: [DB, FCM],
      useFactory: (db: Db, fcm: FcmClient | null) => {
        const cfg = apnsConfigFromEnv();
        if (!cfg && process.env.NODE_ENV === 'production')
          new Logger('DevicePush').warn('APNS_* tanımlı değil: iPhone uyandırma ve bildirimleri gönderilmeyecek');
        return new DevicePush(db, cfg ? new ApnsClient(cfg) : null, undefined, fcm);
      },
    },
    PushWakeService,
  ],
  exports: [DeviceService, PUSH, FCM, PushWakeService],
})
export class DeviceModule {}
