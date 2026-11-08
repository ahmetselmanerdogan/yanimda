import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';

import { SignalService } from './signal.service';

@Controller('signals')
export class SignalController {
  constructor(@Inject(SignalService) private readonly signals: SignalService) {} // tsx/esbuild emitDecoratorMetadata desteklemez: açık Inject
  /** POST /v1/signals — D-01. TODO T-041: cihaz token doğrulama guard'ı. */
  @Post()
  @HttpCode(202)
  post(@Body() body: unknown[]) {
    return this.signals.accept(body);
  }
}
