import { Controller, Get, Inject, NotFoundException, Param, Req, UseGuards } from '@nestjs/common';

import { OidcGuard, Roles, userOf, type UserRequest } from '../identity/oidc.guard';
import { ProtectionService } from './protection.service';

/**
 * D-05 koruma durumu. Operasyon rolleri hepsini; aile (consumers FAMILY, T-061) yalnız kendi kişisini görür —
 * başkasınınki 404 — ve konum paylaşımı açıksa son konumu da alır (C-08 harita).
 */
@Controller('protected-persons')
@UseGuards(OidcGuard)
@Roles('OPERATOR', 'SUPERVISOR', 'ADMIN', 'FAMILY')
export class ProtectionController {
  constructor(@Inject(ProtectionService) private readonly protection: ProtectionService) {}

  /** GET /v1/protected-persons/{id}/status */
  @Get(':id/status')
  async status(@Param('id') id: string, @Req() req: UserRequest) {
    const u = userOf(req);
    const ops = u.realm === 'operations' && u.roles.some((r) => r !== 'FAMILY');
    if (ops) return this.protection.status(id);
    if (u.realm !== 'consumers' || !(await this.protection.canFamilySee(u.sub, id)))
      throw new NotFoundException('Kişi bulunamadı');
    return { ...(await this.protection.status(id)), location: await this.protection.locationOf(id) };
  }
}
