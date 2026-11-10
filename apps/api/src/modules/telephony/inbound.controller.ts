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
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { validate as isUuid } from 'uuid';

import { OidcGuard, Roles, userOf, type UserRequest } from '../identity/oidc.guard';
import { SupervisorService } from '../metrics/supervisor.service';
import {
  BY_CALL_SID,
  INBOUND_KINDS,
  type InboundKind,
  InboundService,
  type MyStatus,
  type TelephonyConfig,
} from './inbound.service';
import { TelephonyService } from './telephony.service';

interface RawRes {
  setHeader(name: string, value: string): void;
}

/**
 * T-051 kalan: gelen arama webhook'ları (herkese açık; yalnız imzalı istek) `POST /v1/webhooks/cpaas-inbound/{kind}`.
 * Twilio numarasının (ya da BYOC trunk'ın) Voice URL'i `.../call`, durum geri çağrısı `.../status`; diğerleri
 * yönlendirme TwiML'inde `?call=<kimlik>` ile verilir. İmza giden aramadakiyle aynı şema; bozuksa 403.
 */
@Controller('webhooks/cpaas-inbound')
export class InboundWebhookController {
  constructor(
    @Inject(InboundService) private readonly inbound: InboundService,
    @Inject(TelephonyService) private readonly telephony: TelephonyService,
  ) {}

  @Post(':kind')
  @HttpCode(200)
  async webhook(
    @Param('kind') kind: string,
    @Query('call') callId: string,
    @Body() body: Record<string, unknown>,
    @Headers('x-twilio-signature') signature: string | undefined,
    @Req() req: { originalUrl: string },
    @Res({ passthrough: true }) res: RawRes,
  ) {
    const provider = this.telephony.provider;
    if (!provider || !INBOUND_KINDS.includes(kind as InboundKind)) throw new NotFoundException();
    const params = Object.fromEntries(
      Object.entries(body ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string'),
    );
    if (!provider.verify(`${this.telephony.webhookBase()}${req.originalUrl}`, params, signature))
      throw new ForbiddenException('İmza geçersiz');
    const bySid = BY_CALL_SID.includes(kind as InboundKind);
    if (!bySid && !isUuid(callId ?? '')) throw new NotFoundException();
    res.setHeader('content-type', 'text/xml; charset=utf-8');
    return this.inbound.webhook(kind as InboundKind, bySid ? undefined : callId, params);
  }
}

/** T-052: konsolun 112 adımı ve telefon barı için telefoni yapılandırması (masa hattı, 112; sır yok). */
@Controller('telephony')
@UseGuards(OidcGuard)
@Roles('OPERATOR', 'SUPERVISOR')
export class TelephonyConfigController {
  constructor(@Inject(InboundService) private readonly inbound: InboundService) {}

  /** GET /v1/telephony/config */
  @Get('config')
  config(): TelephonyConfig {
    return this.inbound.config();
  }
}

const SELF_STATUSES = ['AVAILABLE', 'BREAK'] as const;

/**
 * Operatörün kendi durumu (konsol üst barı "Müsait / Molada"). Gelen SOS aramaları yalnız bağlı ve AVAILABLE
 * operatörlere çalar. Çevrim dışı (OFFLINE) amir işidir (`PUT /v1/supervisor/operators/{sub}/status`).
 */
@Controller('operators')
@UseGuards(OidcGuard)
@Roles('OPERATOR', 'SUPERVISOR')
export class OperatorsController {
  constructor(
    @Inject(SupervisorService) private readonly supervisor: SupervisorService,
    @Inject(InboundService) private readonly inbound: InboundService,
  ) {}

  /** GET /v1/operators/me */
  @Get('me')
  mine(@Req() req: UserRequest): Promise<MyStatus> {
    return this.inbound.operatorStatus(userOf(req).sub);
  }

  /** PUT /v1/operators/me/status — `{ status: AVAILABLE | BREAK }` (audit). */
  @Put('me/status')
  async setMine(@Body() body: { status?: unknown } | null, @Req() req: UserRequest) {
    const status = body?.status;
    if (!SELF_STATUSES.includes(status as (typeof SELF_STATUSES)[number]))
      throw new BadRequestException(`status: ${SELF_STATUSES.join(' | ')}`);
    const sub = userOf(req).sub;
    return this.supervisor.setStatus(sub, status, sub);
  }
}
