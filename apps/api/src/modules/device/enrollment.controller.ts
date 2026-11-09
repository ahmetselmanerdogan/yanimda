import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Ip,
  Param,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';

import { AdminTokenGuard } from '../rules/admin-token.guard';
import { type DeviceRequest, DeviceTokenGuard } from './device-token.guard';
import { type DevicePrincipal, EnrollmentService, etagMatches } from './enrollment.service';

interface Res304 {
  status(code: number): Res304;
  setHeader(name: string, value: string): void;
  end(): void;
}

const principal = (req: DeviceRequest): DevicePrincipal => req.device!; // DeviceTokenGuard doldurur

/** T-041 cihaz kaydı, token, yapılandırma, push token. */
@Controller('devices')
export class EnrollmentController {
  constructor(@Inject(EnrollmentService) private readonly enrollment: EnrollmentService) {}

  /** POST /v1/devices/enroll — davet kodu + cihaz bilgisi → cihaz token'ı. Yeni 201, yeniden deneme 200. */
  @Post('enroll')
  async enroll(@Body() body: unknown, @Ip() ip: string, @Res({ passthrough: true }) res: Res304) {
    const r = await this.enrollment.enroll(body, ip);
    res.status(r.created ? 201 : 200);
    return r.body;
  }

  /** POST /v1/devices/{id}/token — geçerli token ile yeni token (bitişe 30 günden az kala). */
  @Post(':id/token')
  @HttpCode(200)
  @UseGuards(DeviceTokenGuard)
  token(@Param('id') id: string, @Req() req: DeviceRequest) {
    EnrollmentService.assertSelf(principal(req), id);
    return this.enrollment.refresh(principal(req));
  }

  /** GET /v1/devices/{id}/config — eşikler, uyku penceresi, katalog metinleri. ETag / If-None-Match → 304. */
  @Get(':id/config')
  @UseGuards(DeviceTokenGuard)
  async config(
    @Param('id') id: string,
    @Req() req: DeviceRequest,
    @Headers('if-none-match') inm: string | undefined,
    @Res({ passthrough: true }) res: Res304,
  ) {
    EnrollmentService.assertSelf(principal(req), id);
    const { etag, body } = await this.enrollment.config(principal(req));
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, no-cache');
    if (etagMatches(inm, etag)) {
      res.status(304);
      return undefined;
    }
    return body;
  }

  /** PUT /v1/devices/{id}/push-token — APNS/FCM token (T-053 kullanır). */
  @Put(':id/push-token')
  @HttpCode(204)
  @UseGuards(DeviceTokenGuard)
  async pushToken(@Param('id') id: string, @Req() req: DeviceRequest, @Body() body: unknown) {
    EnrollmentService.assertSelf(principal(req), id);
    await this.enrollment.setPushToken(principal(req), body);
  }

  /** DELETE /v1/devices/{id} — cihazı kaldır; token'ı iptal olur (401). TODO T-020: FAMILY sahiplik kontrolü. */
  @Delete(':id')
  @HttpCode(204)
  @UseGuards(AdminTokenGuard)
  async revoke(@Param('id') id: string) {
    await this.enrollment.revoke(id);
  }
}

/** T-040 parçası: davet kodu. TODO T-020/T-040: FAMILY yalnız kendi kişisine davet üretir; SMS katalog metniyle. */
@Controller('protected-persons')
export class InviteController {
  constructor(@Inject(EnrollmentService) private readonly enrollment: EnrollmentService) {}

  /** POST /v1/protected-persons/{id}/invite → { code, expiresAt } (6 hane, 15 dk, tek kullanım). */
  @Post(':id/invite')
  @UseGuards(AdminTokenGuard)
  invite(@Param('id') id: string) {
    return this.enrollment.createInvite(id);
  }
}
