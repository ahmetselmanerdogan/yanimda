import { Global, Module } from '@nestjs/common';

import { DeviceService } from './device.service';
import { PUSH, RecordingPush } from './push.port';

/** T-015 cihaz adaptörleri. PUSH: geliştirmede kayıt eden sahte; T-053 FCM/APNs ile değiştirir. */
@Global()
@Module({
  providers: [DeviceService, { provide: PUSH, useValue: new RecordingPush() }],
  exports: [DeviceService],
})
export class DeviceModule {}
