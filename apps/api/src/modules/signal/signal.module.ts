import { Module } from '@nestjs/common';

import { SignalController } from './signal.controller';
import { SignalService } from './signal.service';
@Module({ controllers: [SignalController], providers: [SignalService] })
export class SignalModule {}
