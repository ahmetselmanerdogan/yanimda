import { Module } from '@nestjs/common';

import { CoreModule } from './core.module';
import { DeviceModule } from './modules/device/device.module';
import { EnrollmentModule } from './modules/device/enrollment.module';
import { EventModule } from './modules/event/event.module';
import { IdentityModule } from './modules/identity/identity.module';
import { RulesModule } from './modules/rules/rules.module';
import { SignalModule } from './modules/signal/signal.module';

// 03-teknik-mimari.md "Servis haritası": modüler monolit. Diğer modüller (identity, profile, health, device,
// chain, notify, telephony, report) ilgili görevlerde (docs/TASKS.md) eklenir.
@Module({
  imports: [CoreModule, IdentityModule, RulesModule, DeviceModule, EventModule, EnrollmentModule, SignalModule],
})
export class AppModule {}
