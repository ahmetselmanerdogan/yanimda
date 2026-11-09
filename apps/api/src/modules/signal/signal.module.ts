import { Module } from '@nestjs/common';

import { EnrollmentModule } from '../device/enrollment.module';
import { SignalController } from './signal.controller';
import { SignalService } from './signal.service';
@Module({ imports: [EnrollmentModule], controllers: [SignalController], providers: [SignalService] })
export class SignalModule {}
