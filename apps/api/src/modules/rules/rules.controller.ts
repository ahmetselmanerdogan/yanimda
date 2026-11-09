import { Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';

import { AdminGuard } from '../identity/oidc.guard';
import { RulesService } from './rules.service';

/** D-02 kural paketi sıcak yükleme (yönetici). */
@Controller('admin/rules')
@UseGuards(AdminGuard)
export class RulesController {
  constructor(@Inject(RulesService) private readonly rules: RulesService) {}

  /** POST /v1/admin/rules/reload — packages/rules/<ülke>.yaml'ı doğrular, sürümler, uygular. */
  @Post('reload')
  @HttpCode(200)
  reload() {
    return this.rules.reload('admin');
  }
}
