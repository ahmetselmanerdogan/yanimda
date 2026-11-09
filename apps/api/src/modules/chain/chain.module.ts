import { Module } from '@nestjs/common';

import { EventModule } from '../event/event.module';
import { ChainController } from './chain.controller';
import { ChainService } from './chain.service';

/** T-021 prosedür zinciri ve operatör işlemleri (D-03, D-04). */
@Module({ imports: [EventModule], providers: [ChainService], controllers: [ChainController], exports: [ChainService] })
export class ChainModule {}
