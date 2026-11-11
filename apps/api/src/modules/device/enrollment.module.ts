import { Module } from '@nestjs/common';

import { EventModule } from '../event/event.module';
import { BridgedDeviceController } from './bridged.controller';
import { BridgedDeviceService } from './bridged.service';
import { CompanionController } from './companion.controller';
import { CompanionService } from './companion.service';
import { CoverageAccess, CoverageAccessGuard, CoverageController, DeviceManageController } from './coverage.controller';
import { DeviceTokenGuard, SignalAuthGuard } from './device-token.guard';
import { EnrollmentController } from './enrollment.controller';
import { EnrollmentService } from './enrollment.service';

/**
 * T-041 cihaz kaydı + eşlikçi telefon uçları (T-042/T-043: saat kaydı, köprü yetkisi, kurulum durumu).
 * Uyku penceresi ve koruma durumu için EventModule'ün ProtectionService'ini kullanır. T-085/T-086: kapsama, cihaz
 * listesi / düzenleme / kaldırma, şarj penceresi ve "şarj ediyorum" uçları (cihaz token'ı, aile veya operasyon).
 */
@Module({
  imports: [EventModule],
  controllers: [
    EnrollmentController,
    CompanionController,
    BridgedDeviceController,
    CoverageController,
    DeviceManageController,
  ],
  providers: [
    EnrollmentService,
    CompanionService,
    BridgedDeviceService,
    DeviceTokenGuard,
    SignalAuthGuard,
    CoverageAccessGuard,
    CoverageAccess,
  ],
  exports: [EnrollmentService, CompanionService, BridgedDeviceService, DeviceTokenGuard, SignalAuthGuard],
})
export class EnrollmentModule {}
