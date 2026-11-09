import { Module } from '@nestjs/common';

import { EventModule } from '../event/event.module';
import { DeviceTokenGuard, SignalAuthGuard } from './device-token.guard';
import { EnrollmentController } from './enrollment.controller';
import { EnrollmentService } from './enrollment.service';

/** T-041 cihaz kaydı. Uyku penceresi için EventModule'ün ProtectionService'ini kullanır. */
@Module({
  imports: [EventModule],
  controllers: [EnrollmentController],
  providers: [EnrollmentService, DeviceTokenGuard, SignalAuthGuard],
  exports: [EnrollmentService, DeviceTokenGuard, SignalAuthGuard],
})
export class EnrollmentModule {}
