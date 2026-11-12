import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';

import { BridgedDeviceService } from './bridged.service';
import { type DeviceRequest, DeviceTokenGuard } from './device-token.guard';

interface ResStatus {
  status(code: number): ResStatus;
}

/**
 * T-092 (docs/07 S2.1, S4.8, S7.5) BLE köprülü cihazlar: yaşlının telefonu (kendi cihaz token'ıyla) kaydeder, listeler,
 * kaldırır. Sinyaller mevcut `POST /v1/signals` yolundan telefon token'ıyla, köprülü cihazın kimliğiyle gelir.
 */
@Controller('devices/bridged')
@UseGuards(DeviceTokenGuard)
export class BridgedDeviceController {
  constructor(@Inject(BridgedDeviceService) private readonly bridged: BridgedDeviceService) {}

  /** POST /v1/devices/bridged — yeni 201, aynı telefon + adres yeniden 200 (aynı deviceId). */
  @Post()
  async register(@Req() req: DeviceRequest, @Body() body: unknown, @Res({ passthrough: true }) res: ResStatus) {
    const r = await this.bridged.register(req.device!, body);
    res.status(r.created ? 201 : 200);
    return r.view;
  }

  /** GET /v1/devices/bridged — bu telefona bağlı etkin köprülü cihazlar. */
  @Get()
  list(@Req() req: DeviceRequest) {
    return this.bridged.list(req.device!);
  }

  /** DELETE /v1/devices/bridged/{deviceId} — köprüyü kaldırır (204; zaten kaldırılmışsa da 204). */
  @Delete(':deviceId')
  @HttpCode(204)
  async remove(@Req() req: DeviceRequest, @Param('deviceId') deviceId: string) {
    await this.bridged.unbridge(req.device!, deviceId);
  }
}
