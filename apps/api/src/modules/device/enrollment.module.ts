import { Module } from '@nestjs/common';

import { EventModule } from '../event/event.module';
import { CompanionController } from './companion.controller';
import { CompanionService } from './companion.service';
import { DeviceTokenGuard, SignalAuthGuard } from './device-token.guard';
import { EnrollmentController } from './enrollment.controller';
import { EnrollmentService } from './enrollment.service';

/**
 * T-041 cihaz kaydı + eşlikçi telefon uçları (T-042/T-043: saat kaydı, köprü yetkisi, kurulum durumu).
 * Uyku penceresi ve koruma durumu için EventModule'ün ProtectionService'ini kullanır.
 */
@Module({
  imports: [EventModule],
  controllers: [EnrollmentController, CompanionController],
  providers: [EnrollmentService, CompanionService, DeviceTokenGuard, SignalAuthGuard],
  exports: [EnrollmentService, CompanionService, DeviceTokenGuard, SignalAuthGuard],
})
export class EnrollmentModule {}
