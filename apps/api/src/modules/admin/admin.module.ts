import { Module } from '@nestjs/common';

import { TelephonyModule } from '../telephony/telephony.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

/** Yönetim ve çağrı merkezi paneli (okuma, ses kaydı dinleme denetimli). */
@Module({
  imports: [TelephonyModule],
  providers: [AdminService],
  controllers: [AdminController],
  exports: [AdminService],
})
export class AdminModule {}
