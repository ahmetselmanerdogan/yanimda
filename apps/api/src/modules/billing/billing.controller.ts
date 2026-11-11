import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';

import { RateLimit, WEBHOOK_LIMIT } from '../../common/rate-limit';
import type { Actor } from '../profile/contacts';
import { ProfileGuard } from '../profile/profile.controller';
import { BillingService } from './billing.service';

interface RawRequest {
  rawBody?: Buffer;
  body?: unknown;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  actor?: Actor;
}
interface Redirectable {
  redirect(status: number, url: string): void;
}

/**
 * T-060 (C-01) web abonelik uçları — girişsiz (kayıt akışı, `x-signup-token`) ve sağlayıcı uçları.
 * Webhook imzası ham gövde üzerinden doğrulanır (main.ts `rawBody: true`).
 */
@Controller()
export class BillingController {
  constructor(@Inject(BillingService) private readonly billing: BillingService) {}

  /** GET /v1/plans?country=TR|US — adım 1 paketleri. */
  @Get('plans')
  plans(@Query('country') country?: string) {
    return this.billing.plans(country);
  }

  /** POST /v1/signup — adım 2 hesap: Keycloak consumers hesabı + kişi + TRIAL abonelik. */
  @Post('signup')
  @RateLimit({ name: 'signup', limit: 10, windowSec: 3600, by: 'ip' })
  signup(@Body() body: unknown, @Req() req: RawRequest) {
    return this.billing.signup(body, req.ip);
  }

  @Post('signup/:id/phone/code')
  @RateLimit({ name: 'signup-sms', limit: 5, windowSec: 3600, by: 'param:id' })
  @HttpCode(200)
  resend(@Param('id') id: string, @Headers('x-signup-token') token?: string) {
    return this.billing.resendPhoneCode(id, token);
  }

  @Post('signup/:id/phone/verify')
  @RateLimit({ name: 'signup-verify', limit: 10, windowSec: 3600, by: 'param:id' })
  @HttpCode(200)
  verify(@Param('id') id: string, @Body() body: unknown, @Headers('x-signup-token') token?: string) {
    return this.billing.verifyPhone(id, token, body);
  }

  /** POST /v1/signup/{id}/checkout — adım 2 ödeme: sağlayıcının barındırdığı sayfa. */
  @Post('signup/:id/checkout')
  @HttpCode(200)
  checkout(@Param('id') id: string, @Body() body: unknown, @Headers('x-signup-token') token?: string) {
    return this.billing.checkoutWithToken(id, token, body);
  }

  @Get('signup/:id/subscription')
  signupStatus(@Param('id') id: string, @Headers('x-signup-token') token?: string) {
    return this.billing.statusWithToken(id, token);
  }

  /** POST /v1/webhooks/payments — iyzico (X-IYZ-SIGNATURE-V3), Stripe (Stripe-Signature), sahte (X-Fake-Signature). */
  @Post('webhooks/payments')
  @RateLimit(WEBHOOK_LIMIT)
  @HttpCode(200)
  webhook(@Req() req: RawRequest) {
    const raw = req.rawBody ?? Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}));
    return this.billing.webhook({ rawBody: raw, headers: req.headers });
  }

  /** iyzico tarayıcı dönüşü (form POST, token) → web adım 3'e 303. */
  @Post('payments/iyzico/callback')
  @RateLimit(WEBHOOK_LIMIT)
  async iyzicoCallback(@Body() body: { token?: unknown } | undefined, @Res() res: Redirectable) {
    res.redirect(303, await this.billing.iyzicoCallback(body?.token));
  }

  /** Sahte ödeme sayfasının düğmesi (yalnız PAYMENT_PROVIDER=fake). */
  @Post('payments/fake/:ref/pay')
  @HttpCode(200)
  fakePay(@Param('ref') ref: string, @Body() body: unknown) {
    return this.billing.fakePay(ref, body);
  }
}

/** Giriş yapmış aile (consumers FAMILY) veya yönetici: durum, tek tık iptal, sonradan ödeme. */
@Controller('protected-persons')
@UseGuards(ProfileGuard)
export class SubscriptionController {
  constructor(@Inject(BillingService) private readonly billing: BillingService) {}

  @Get(':id/subscription')
  get(@Param('id') id: string, @Req() req: RawRequest) {
    return this.billing.status(req.actor!, id);
  }

  @Post(':id/subscription/cancel')
  @HttpCode(200)
  cancel(@Param('id') id: string, @Req() req: RawRequest) {
    return this.billing.cancel(req.actor!, id);
  }

  @Post(':id/subscription/checkout')
  @HttpCode(200)
  checkout(@Param('id') id: string, @Body() body: unknown, @Req() req: RawRequest) {
    return this.billing.checkoutForPerson(req.actor!, id, body);
  }
}
