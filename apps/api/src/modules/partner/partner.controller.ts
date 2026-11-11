import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';

import { RateLimit, WEBHOOK_LIMIT } from '../../common/rate-limit';
import { OidcGuard, Roles, userOf, type UserRequest } from '../identity/oidc.guard';
import { PartnerHealthService } from './partner-health.service';
import { PartnerWebhookService } from './partner-webhook.service';
import { PendantMaintenanceService } from './pendant-maintenance.service';
import { VendorLinkService } from './vendor-link.service';

interface RawRequest {
  rawBody?: Buffer;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * T-085 OEM ortak webhook'u (docs/07 S2.5, S2.6, S8.3): girişsiz, imza doğrulamalı. İmza ham gövde üzerinden
 * (main.ts `rawBody: true`). 202 `{ accepted, duplicates, rejected }`.
 */
@Controller('webhooks/partners')
export class PartnerWebhookController {
  constructor(@Inject(PartnerWebhookService) private readonly webhooks: PartnerWebhookService) {}

  @Post(':partner')
  @RateLimit(WEBHOOK_LIMIT)
  @HttpCode(202)
  ingest(@Param('partner') partner: string, @Req() req: RawRequest) {
    const raw = req.rawBody ?? Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}));
    return this.webhooks.ingest(partner, { rawBody: raw, headers: req.headers });
  }
}

/** T-085 OEM: ortak cihazını kişiye bağlama (kurulum ekibi: amir / yönetici). Kaldırma DELETE /devices/{id}. */
@Controller()
@UseGuards(OidcGuard)
@Roles('SUPERVISOR', 'ADMIN')
export class VendorLinkController {
  constructor(@Inject(VendorLinkService) private readonly links: VendorLinkService) {}

  @Post('vendor-links')
  @HttpCode(201)
  create(@Body() body: unknown, @Req() req: UserRequest) {
    return this.links.create(body, userOf(req).sub);
  }

  @Get('protected-persons/:id/vendor-links')
  list(@Param('id') id: string) {
    return this.links.list(id);
  }
}

/** T-085 OEM amir uçları (S2.7, S4.9, S7.2): ortak gecikmesi ve kolye pili iş emirleri. */
@Controller('supervisor')
@UseGuards(OidcGuard)
@Roles('SUPERVISOR', 'ADMIN')
export class PartnerOpsController {
  constructor(
    @Inject(PartnerHealthService) private readonly health: PartnerHealthService,
    @Inject(PendantMaintenanceService) private readonly maintenance: PendantMaintenanceService,
  ) {}

  /** GET /v1/supervisor/partners — ortak başına son 1 saatin p95 / p99 gecikmesi ve bozulma. */
  @Get('partners')
  partners() {
    return this.health.list();
  }

  /** GET /v1/supervisor/work-orders?status=OPEN|DONE — kolye pili iş emirleri (son tarihe göre). */
  @Get('work-orders')
  workOrders(@Query('status') status?: string) {
    return this.maintenance.list({ status });
  }

  /** POST /v1/supervisor/work-orders/{id}/done — yerinde değişim yapıldı (denetimde). */
  @Post('work-orders/:id/done')
  @HttpCode(200)
  done(@Param('id') id: string, @Req() req: UserRequest) {
    return this.maintenance.done(id, userOf(req).sub);
  }
}
