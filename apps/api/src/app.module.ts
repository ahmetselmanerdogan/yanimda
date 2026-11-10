import { Module } from '@nestjs/common';

import { CoreModule } from './core.module';
import { ChainModule } from './modules/chain/chain.module';
import { DeviceModule } from './modules/device/device.module';
import { EnrollmentModule } from './modules/device/enrollment.module';
import { EventModule } from './modules/event/event.module';
import { FalseAlarmModule } from './modules/false-alarm/false-alarm.module';
import { IdentityModule } from './modules/identity/identity.module';
import { LearningModule } from './modules/learning/learning.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { NotifyModule } from './modules/notify/notify.module';
import { ProfileModule } from './modules/profile/profile.module';
import { QueueModule } from './modules/queue/queue.module';
import { ReportModule } from './modules/report/report.module';
import { RulesModule } from './modules/rules/rules.module';
import { SignalModule } from './modules/signal/signal.module';
import { InboundModule } from './modules/telephony/inbound.module';

// 03-teknik-mimari.md "Servis haritası": modüler monolit. Diğer modüller (identity, profile, health, device,
// chain, notify, telephony, report) ilgili görevlerde (docs/TASKS.md) eklenir.
@Module({
  imports: [
    CoreModule,
    IdentityModule,
    RulesModule,
    DeviceModule,
    EventModule,
    EnrollmentModule,
    SignalModule,
    ProfileModule,
    ChainModule,
    QueueModule,
    MetricsModule,
    NotifyModule,
    ReportModule,
    LearningModule,
    FalseAlarmModule,
    InboundModule,
  ],
})
export class AppModule {}
