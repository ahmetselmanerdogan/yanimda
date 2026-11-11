import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';

import { alarmBatch, RateLimit } from '../../common/rate-limit';
import { CompanionService } from '../device/companion.service';
import { type DeviceRequest, SignalAuthGuard } from '../device/device-token.guard';
import { SignalService } from './signal.service';

/**
 * Token'lı cihaz kendi adına sinyal gönderir: her sinyalin deviceId ve protectedPersonId'si token'dakiyle aynı
 * olmalı. Tek istisna köprü (B-03): eşlikçi telefon aynı kişinin etkin saatinin sinyallerini iletir. İzin sinyal
 * başınadır (CompanionService.authorizeBatch): yetkisiz sinyal yazılmaz ve `rejected` içinde döner, partinin geri
 * kalanı yazılır; partide kabul edilebilir sinyal yoksa 403.
 */
@Controller('signals')
export class SignalController {
  // tsx/esbuild emitDecoratorMetadata desteklemez: açık Inject
  constructor(
    @Inject(SignalService) private readonly signals: SignalService,
    @Inject(CompanionService) private readonly companion: Pick<CompanionService, 'authorizeBatch'>,
  ) {}

  /** POST /v1/signals — D-01. T-041: cihaz token'ı (SignalAuthGuard; token'sız yalnız simülatör açıkken). */
  @Post()
  @RateLimit({
    name: 'signals',
    limit: 600,
    windowSec: 60,
    by: 'device',
    exempt: (r) => alarmBatch((r as { body?: unknown }).body),
  })
  @HttpCode(202)
  @UseGuards(SignalAuthGuard)
  async post(@Body() body: unknown[], @Req() req: DeviceRequest) {
    const denied = await this.companion.authorizeBatch(req.device, body); // kendi sinyali veya köprülenen saat
    return this.signals.accept(body, denied);
  }
}
