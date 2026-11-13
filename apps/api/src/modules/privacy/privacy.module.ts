import { Module } from '@nestjs/common';

import { ProfileModule } from '../profile/profile.module';
import { DataExportController } from './data-export.controller';
import { DataExportService } from './data-export.service';
import { RETENTION_CONFIG, retentionConfigFromEnv, RetentionService } from './retention.service';

/**
 * T-081 kişisel veri yaşam döngüsü: dışa aktarma (ASVS 8.3.2, KVKK m.11) ve saklama süreleri temizliği (8.3.8).
 * docs/security/saklama.md.
 */
@Module({
  imports: [ProfileModule],
  controllers: [DataExportController],
  providers: [
    DataExportService,
    RetentionService,
    // Geçersiz süre açılışı durdurur (sessizce kısa süreyle veri silinmesin).
    { provide: RETENTION_CONFIG, useFactory: () => retentionConfigFromEnv() },
  ],
  exports: [RetentionService],
})
export class PrivacyModule {}
