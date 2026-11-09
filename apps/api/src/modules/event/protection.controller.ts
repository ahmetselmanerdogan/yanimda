import { Controller, Get, Inject, Param, UseGuards } from '@nestjs/common';

import { OidcGuard, Roles } from '../identity/oidc.guard';
import { ProtectionService } from './protection.service';

/**
 * D-05 koruma durumu. Şimdilik yalnız operasyon rolleri. TODO T-040: FAMILY yalnız kendi kişisini görür
 * (başkasınınki 404); aile–kişi bağı T-040'ta gelir.
 */
@Controller('protected-persons')
@UseGuards(OidcGuard)
@Roles('OPERATOR', 'SUPERVISOR', 'ADMIN')
export class ProtectionController {
  constructor(@Inject(ProtectionService) private readonly protection: ProtectionService) {}

  /** GET /v1/protected-persons/{id}/status */
  @Get(':id/status')
  status(@Param('id') id: string) {
    return this.protection.status(id);
  }
}
