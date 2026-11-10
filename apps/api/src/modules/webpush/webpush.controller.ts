import { Body, Controller, Delete, Get, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';

import { OidcGuard, Roles, userOf, type UserRequest } from '../identity/oidc.guard';
import { WebPushService } from './webpush.service';

/** Personel web push (PWA): VAPID açık anahtarı, abone ol / bırak. */
@Controller('push/web')
@UseGuards(OidcGuard)
@Roles('OPERATOR', 'SUPERVISOR', 'ADMIN')
export class WebPushController {
  constructor(@Inject(WebPushService) private readonly push: WebPushService) {}

  @Get('config')
  config() {
    return { enabled: this.push.enabled, publicKey: this.push.publicKey };
  }

  @Post('subscriptions')
  @HttpCode(200)
  subscribe(@Req() req: UserRequest, @Body() body: unknown) {
    const u = userOf(req);
    return this.push.register(u.sub, u.roles, body);
  }

  @Delete('subscriptions')
  @HttpCode(204)
  async unsubscribe(@Req() req: UserRequest, @Body() body: { endpoint?: unknown }) {
    await this.push.unregister(userOf(req).sub, body?.endpoint);
  }
}
