import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';

import { OidcGuard, Roles, userOf, type UserRequest } from '../identity/oidc.guard';
import { NotifyService } from './notify.service';

/** T-053 aile/kişi uygulaması: push token'ı ve bildirim teslim onayı (consumers realm). */
@Controller()
@UseGuards(OidcGuard)
@Roles('FAMILY', 'ELDER')
export class NotifyController {
  constructor(@Inject(NotifyService) private readonly notify: NotifyService) {}

  /** PUT /v1/me/push-target — {platform: 'FCM', token}. */
  @Put('me/push-target')
  @HttpCode(204)
  async setTarget(@Body() body: unknown, @Req() req: UserRequest) {
    await this.notify.setPushTarget(userOf(req).sub, body);
  }

  /** DELETE /v1/me/push-target?token=… — çıkışta. */
  @Delete('me/push-target')
  @HttpCode(204)
  async deleteTarget(@Query('token') token: string, @Req() req: UserRequest) {
    if (token) await this.notify.deletePushTarget(userOf(req).sub, token);
  }

  /** POST /v1/notifications/{id}/ack — uygulama bildirimi gösterdi (SMS yedeği iptal). */
  @Post('notifications/:id/ack')
  @HttpCode(204)
  async ack(@Param('id') id: string, @Req() req: UserRequest) {
    await this.notify.ack(userOf(req).sub, id);
  }
}

/** T-053 SMS teslim raporu: `POST /v1/webhooks/notify/sms?n=<bildirim>` (Twilio imzası; bozuksa 403). */
@Controller('webhooks/notify')
export class NotifyWebhookController {
  constructor(@Inject(NotifyService) private readonly notify: NotifyService) {}

  @Post('sms')
  @HttpCode(200)
  async sms(
    @Query('n') id: string,
    @Body() body: Record<string, unknown>,
    @Headers('x-twilio-signature') signature: string | undefined,
    @Req() req: { originalUrl: string },
    @Res({ passthrough: true }) res: { setHeader(name: string, value: string): void },
  ) {
    const params = Object.fromEntries(
      Object.entries(body ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string'),
    );
    const base = (process.env.CPAAS_WEBHOOK_BASE ?? '').replace(/\/+$/, '');
    if (!this.notify.verifyWebhook(`${base}${req.originalUrl}`, params, signature))
      throw new ForbiddenException('İmza geçersiz');
    await this.notify.smsStatus(id ?? '', params);
    res.setHeader('content-type', 'text/xml; charset=utf-8');
    return '<Response/>';
  }
}
