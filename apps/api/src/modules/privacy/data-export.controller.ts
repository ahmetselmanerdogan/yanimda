import { Controller, ForbiddenException, Get, Header, Inject, Req, UseGuards } from '@nestjs/common';
import type { DataExport } from '@yanimda/contracts';

import { RateLimit } from '../../common/rate-limit';
import type { Actor } from '../profile/contacts';
import { ProfileGuard } from '../profile/profile.controller';
import { DataExportService } from './data-export.service';

/** Dosya adı teknik tanımlayıcıdır (metin değil); tarayıcı indirmesinde kullanılır. */
export const DATA_EXPORT_FILENAME = 'yanimda-data-export.json';

/**
 * T-081 (ASVS 8.3.2, KVKK m.11) GET /v1/family/data-export — aile hesabı (consumers FAMILY) kendi verisini indirir.
 * ProfileGuard kimliği doğrular; burada yalnız FAMILY kabul edilir (OIDC ADMIN / `x-admin-token` 403). Ağır sorgu:
 * kullanıcı başına saatte 5.
 */
@Controller('family')
@UseGuards(ProfileGuard)
export class DataExportController {
  constructor(@Inject(DataExportService) private readonly exporter: DataExportService) {}

  @Get('data-export')
  @RateLimit({ name: 'data-export', limit: 5, windowSec: 3600, by: 'user' })
  @Header('Content-Disposition', `attachment; filename="${DATA_EXPORT_FILENAME}"`)
  export(@Req() req: { actor?: Actor }): Promise<DataExport> {
    const actor = req.actor;
    if (!actor || actor.kind !== 'FAMILY') return Promise.reject(new ForbiddenException('Yalnız aile hesabı'));
    return this.exporter.export(actor);
  }
}
