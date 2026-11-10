import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { validate as isUuid } from 'uuid';

import { OidcGuard, Roles } from '../identity/oidc.guard';
import { TelephonyService } from '../telephony/telephony.service';
import {
  SCREENING_WEBHOOK_KINDS,
  ScreeningService,
  type ScreeningStats,
  type ScreeningWebhookKind,
} from './screening.service';

/**
 * T-072 ön eleme webhook'ları (herkese açık; yalnız imzalı istek): `POST /v1/webhooks/screening/{gather|status}?s=<id>`.
 * İmza Twilio şeması (CPAAS_WEBHOOK_BASE + yol); bozuksa 403. Yanıt TwiML.
 */
@Controller('webhooks/screening')
export class ScreeningWebhookController {
  constructor(
    @Inject(ScreeningService) private readonly screening: ScreeningService,
    @Inject(TelephonyService) private readonly telephony: TelephonyService,
  ) {}

  @Post(':kind')
  @HttpCode(200)
  async webhook(
    @Param('kind') kind: string,
    @Query('s') id: string,
    @Body() body: Record<string, unknown>,
    @Headers('x-twilio-signature') signature: string | undefined,
    @Req() req: { originalUrl: string },
    @Res({ passthrough: true }) res: { setHeader(name: string, value: string): void },
  ): Promise<string> {
    const provider = this.telephony.provider;
    if (!provider || !SCREENING_WEBHOOK_KINDS.includes(kind as ScreeningWebhookKind)) throw new NotFoundException();
    const params = Object.fromEntries(
      Object.entries(body ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string'),
    );
    if (!provider.verify(`${this.telephony.webhookBase()}${req.originalUrl}`, params, signature))
      throw new ForbiddenException('İmza geçersiz');
    if (!isUuid(id ?? '')) throw new NotFoundException();
    res.setHeader('content-type', 'text/xml; charset=utf-8');
    return this.screening.webhook(kind as ScreeningWebhookKind, id, params);
  }
}

/** T-072 adım 3: ön eleme sonuçları ve operatör örnekleminden yanlış pozitif oranı (amir). */
@Controller('screening')
@UseGuards(OidcGuard)
@Roles('SUPERVISOR', 'ADMIN')
export class ScreeningController {
  constructor(@Inject(ScreeningService) private readonly screening: ScreeningService) {}

  /** GET /v1/screening/stats?days=30 (1–90). */
  @Get('stats')
  stats(@Query('days') days?: string): Promise<ScreeningStats> {
    const n = days === undefined ? 30 : Number(days);
    if (!Number.isInteger(n) || n < 1 || n > 90) throw new BadRequestException('days 1–90 olmalı');
    return this.screening.stats(new Date(Date.now() - n * 86_400_000));
  }
}
