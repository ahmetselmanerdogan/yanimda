import { Body, Controller, ForbiddenException, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';

import { type DeviceRequest, SignalAuthGuard } from '../device/device-token.guard';
import type { DevicePrincipal } from '../device/enrollment.service';
import { SignalService } from './signal.service';

/**
 * Token'lı cihaz yalnız kendi adına sinyal gönderebilir: partideki her sinyalin deviceId ve protectedPersonId'si
 * token'dakiyle aynı olmalı (değilse tüm parti 403, hiçbir şey yazılmaz).
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
  constructor(@Inject(SignalService) private readonly signals: SignalService) {} // tsx/esbuild emitDecoratorMetadata desteklemez: açık Inject
  /** POST /v1/signals — D-01. T-041: cihaz token'ı (SignalAuthGuard; token'sız yalnız simülatör açıkken). */
  @Post()
  @HttpCode(202)
  @UseGuards(SignalAuthGuard)
  post(@Body() body: unknown[], @Req() req: DeviceRequest) {
    assertOwnBatch(req.device, body);
    return this.signals.accept(body);
  }
}
