import { Controller, Get, Inject, Param } from '@nestjs/common';

import { ProtectionService } from './protection.service';

/**
 * D-05 koruma durumu. TODO T-020/T-040: OIDC + FAMILY yalnız kendi kişisini görür (başkasınınki 404).
 */
@Controller('protected-persons')
export class ProtectionController {
  constructor(@Inject(ProtectionService) private readonly protection: ProtectionService) {}

  /** GET /v1/protected-persons/{id}/status */
  @Get(':id/status')
  status(@Param('id') id: string) {
    return this.protection.status(id);
  }
}
