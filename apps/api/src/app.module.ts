import { Module } from '@nestjs/common';

import { EventModule } from './modules/event/event.module';
import { SignalModule } from './modules/signal/signal.module';

// 03-teknik-mimari.md "Servis haritası": modüler monolit. Diğer modüller (identity, profile, health, device,
// chain, notify, telephony, report) ilgili görevlerde (docs/TASKS.md) eklenir.
@Module({ imports: [SignalModule, EventModule] })
export class AppModule {}
