import { Body, Controller, ForbiddenException, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';

import { alarmBatch, RateLimit } from '../../common/rate-limit';
import { CompanionService } from '../device/companion.service';
import { type DeviceRequest, SignalAuthGuard } from '../device/device-token.guard';
import type { DevicePrincipal } from '../device/enrollment.service';
import { SignalService } from './signal.service';

/**
 * Token'lı cihaz kendi adına sinyal gönderir: partideki her sinyalin deviceId ve protectedPersonId'si token'dakiyle
 * aynı olmalı (değilse tüm parti 403, hiçbir şey yazılmaz). Tek istisna köprü (B-03): eşlikçi telefon aynı kişinin
 * etkin saatinin sinyallerini iletir — bunu CompanionService.assertBatchAllowed denetler (veritabanı gerekir).
 */
export function assertOwnBatch(p: DevicePrincipal | undefined, batch: unknown): void {
  if (!p || !Array.isArray(batch)) return;
  for (const s of batch as { deviceId?: unknown; protectedPersonId?: unknown }[]) {
    // Birebir eşleşme (UUID küçük harf): cihaz türü sorgusu da device.id::text ile birebir eşleşir.
    if (s?.deviceId !== p.deviceId || s?.protectedPersonId !== p.protectedPersonId)
      throw new ForbiddenException('Sinyal token sahibi cihaza ait değil');
  }
}

@Controller('signals')
export class SignalController {
  // tsx/esbuild emitDecoratorMetadata desteklemez: açık Inject
  constructor(
    @Inject(SignalService) private readonly signals: SignalService,
    @Inject(CompanionService) private readonly companion: Pick<CompanionService, 'assertBatchAllowed'>,
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
    await this.companion.assertBatchAllowed(req.device, body); // kendi sinyali veya köprülenen saat sinyali
    return this.signals.accept(body);
  }
}
