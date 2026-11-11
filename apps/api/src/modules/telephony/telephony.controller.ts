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

import { RateLimit, WEBHOOK_LIMIT } from '../../common/rate-limit';
import { OidcGuard, Roles, userOf, type UserRequest } from '../identity/oidc.guard';
import { type CallView, TelephonyService, type VoiceToken, WEBHOOK_KINDS, type WebhookKind } from './telephony.service';

interface RawRes {
  setHeader(name: string, value: string): void;
}

/**
 * T-050 CPaaS webhook'ları (herkese açık; yalnız imzalı istek): `POST /v1/webhooks/cpaas/{kind}?call=<id>`.
 * İmza Twilio şeması (X-Twilio-Signature, CPAAS_WEBHOOK_BASE + yol); bozuksa 403. Yanıt TwiML.
 */
@Controller('webhooks/cpaas')
export class CpaasWebhookController {
  constructor(@Inject(TelephonyService) private readonly telephony: TelephonyService) {}

  @Post(':kind')
  @RateLimit(WEBHOOK_LIMIT)
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
    if (!provider || !WEBHOOK_KINDS.includes(kind as WebhookKind)) throw new NotFoundException();
    const params = Object.fromEntries(
      Object.entries(body ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string'),
    );
    if (!provider.verify(`${this.telephony.webhookBase()}${req.originalUrl}`, params, signature))
      throw new ForbiddenException('İmza geçersiz');
    if (!isUuid(callId ?? '')) throw new NotFoundException();
    res.setHeader('content-type', 'text/xml; charset=utf-8');
    return this.telephony.webhook(kind as WebhookKind, callId, params);
  }
}

const callId = (id: string) => {
  if (!isUuid(id ?? '')) throw new NotFoundException('Arama yok');
  return id;
};

/**
 * T-051 konsol yazılım telefonu (E-05): Voice token'ı ve süren görüşmede bekletme, konferansa aile ekleme, kapatma.
 * Yalnız OPERATOR/SUPERVISOR; arama işlemlerini yalnız aramayı başlatan operatör yapar (başkası 403).
 */
@Controller('telephony')
@UseGuards(OidcGuard)
@Roles('OPERATOR', 'SUPERVISOR')
export class TelephonyController {
  constructor(@Inject(TelephonyService) private readonly telephony: TelephonyService) {}

  /** GET /v1/telephony/token — kısa ömürlü Twilio Voice token'ı (kimlik `client:<sub>`); sahte sağlayıcıda sahte. */
  @Get('token')
  token(@Req() req: UserRequest): VoiceToken {
    return this.telephony.voiceToken(userOf(req).sub);
  }

  /** POST /v1/telephony/calls/{callId}/hold — `{ on: boolean }`. */
  @Post('calls/:callId/hold')
  @HttpCode(200)
  hold(@Param('callId') id: string, @Body() body: unknown, @Req() req: UserRequest): Promise<CallView> {
    const on = (body as { on?: unknown } | null)?.on;
    if (typeof on !== 'boolean') throw new BadRequestException('on: boolean gerekli');
    return this.telephony.hold(callId(id), userOf(req).sub, on);
  }

  /** POST /v1/telephony/calls/{callId}/conference — `{ contactIndex?: 1..5 }` (varsayılan 1. yakın). */
  @Post('calls/:callId/conference')
  @HttpCode(200)
  conference(@Param('callId') id: string, @Body() body: unknown, @Req() req: UserRequest): Promise<CallView> {
    const n = (body as { contactIndex?: unknown } | null)?.contactIndex ?? 1;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 5)
      throw new BadRequestException('contactIndex 1–5 olmalı');
    return this.telephony.addFamily(callId(id), userOf(req).sub, n);
  }

  /** POST /v1/telephony/calls/{callId}/hangup — operatör bacağını kapatır; bitmiş aramada etkisiz. */
  @Post('calls/:callId/hangup')
  @HttpCode(200)
  hangup(@Param('callId') id: string, @Req() req: UserRequest): Promise<CallView> {
    return this.telephony.hangup(callId(id), userOf(req).sub);
  }
}
