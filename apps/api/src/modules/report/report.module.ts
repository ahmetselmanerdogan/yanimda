import { Module } from '@nestjs/common';

import { EnrollmentModule } from '../device/enrollment.module';
import { NotifyModule } from '../notify/notify.module';
import { ProfileModule } from '../profile/profile.module';
import { DailySummaryService } from './daily-summary.service';
import { DailySummaryController, DeviceSummaryController, SetupStateController } from './report.controller';

/** T-062 günlük özet ve F-DAILY. */
@Module({
  imports: [NotifyModule, ProfileModule, EnrollmentModule],
  controllers: [DailySummaryController, DeviceSummaryController, SetupStateController],
  providers: [DailySummaryService],
  exports: [DailySummaryService],
})
export class ReportModule {}
