import {
  Body,
  Controller,
  ForbiddenException,
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

import { AdminGuard } from '../identity/oidc.guard';
import { TelephonyService, WEBHOOK_KINDS, type WebhookKind } from './telephony.service';

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

/** Aranacak numaralar (asgari; aile ekranı ve tam profil T-040). Yönetici. */
@Controller('protected-persons')
@UseGuards(AdminGuard)
export class ContactsController {
  constructor(@Inject(TelephonyService) private readonly telephony: TelephonyService) {}

  /** PUT /v1/protected-persons/{id}/contacts — listeyi değiştirir: [{role, priority?, displayName?, phone}]. */
  @Put(':id/contacts')
  contacts(@Param('id') id: string, @Body() body: unknown) {
    return this.telephony.setContacts(id, body);
  }
}
