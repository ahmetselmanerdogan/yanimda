import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { OidcGuard, Roles, userOf, type UserRequest } from '../identity/oidc.guard';
import { ChainService } from './chain.service';
import { DispatchService } from './dispatch.service';

/** E-02 üstlenme, E-03/E-04 zincir adımları, E-06 112 kısayolu, E-07 kapatma (T-021). */
@Controller('events')
@UseGuards(OidcGuard)
@Roles('OPERATOR', 'SUPERVISOR')
export class ChainController {
  constructor(
    @Inject(ChainService) private readonly chain: ChainService,
    @Inject(DispatchService) private readonly dispatch: DispatchService,
  ) {}

  /** GET /v1/events/dispatches?open=1 — 112 süreçleri (süren veya son 30 gün). Amir panosu ve yönetim. */
  @Get('dispatches')
  dispatches(@Query('open') open?: string) {
    return this.dispatch.list({ open: open === '1' || open === 'true' });
  }

  /** GET /v1/events/{id}/dispatch — 112 süreci ve zaman çizelgesi (yoksa 404). */
  @Get(':id/dispatch')
  async dispatchOf(@Param('id') id: string) {
    const v = await this.dispatch.get(id);
    if (!v) throw new NotFoundException('Süreç yok');
    return v;
  }

  /** POST /v1/events/{id}/dispatch — 112 aşaması / vaka no / tahmini varış / hastane / not (olay kapalıyken de). */
  @Post(':id/dispatch')
  @HttpCode(200)
  updateDispatch(@Param('id') id: string, @Req() req: UserRequest, @Body() body: unknown) {
    const u = userOf(req);
    const kind = u.roles.includes('SUPERVISOR') ? 'SUPERVISOR' : 'OPERATOR';
    return this.dispatch.update(id, { kind, id: u.sub }, body);
  }

  /** GET /v1/events/{id} — olay + zincir. */
  @Get(':id')
  get(@Param('id') id: string) {
    return this.chain.get(id);
  }

  /** GET /v1/events/{id}/person — kişi kartı + tıbbi özet (yalnız olayı yürüten operatör; T-040). */
  @Get(':id/person')
  person(@Param('id') id: string, @Req() req: UserRequest) {
    return this.chain.personCard(id, userOf(req).sub);
  }

  /** GET /v1/events/{id}/script?kind=dispatch112 — 112 şablonu (yalnız olayı yürüten operatör). */
  @Get(':id/script')
  script(@Param('id') id: string, @Query('kind') kind: string, @Req() req: UserRequest) {
    return this.chain.dispatchScript(id, userOf(req).sub, kind);
  }

  /** POST /v1/events/{id}/claim — üstlen; zincir oluşur. Başka operatörde 409. */
  @Post(':id/claim')
  @HttpCode(200)
  claim(@Param('id') id: string, @Req() req: UserRequest) {
    return this.chain.claim(id, userOf(req).sub);
  }

  /** POST /v1/events/{id}/heartbeat — operatör kilidini uzatır. */
  @Post(':id/heartbeat')
  @HttpCode(200)
  heartbeat(@Param('id') id: string, @Req() req: UserRequest) {
    return this.chain.heartbeat(id, userOf(req).sub);
  }

  @Post(':id/chain/steps/:n/call')
  @HttpCode(200)
  call(@Param('id') id: string, @Param('n', ParseIntPipe) n: number, @Req() req: UserRequest) {
    return this.chain.call(id, n, userOf(req).sub);
  }

  @Post(':id/chain/steps/:n/script-read')
  @HttpCode(200)
  scriptRead(@Param('id') id: string, @Param('n', ParseIntPipe) n: number, @Req() req: UserRequest) {
    return this.chain.scriptRead(id, n, userOf(req).sub);
  }

  /** POST /v1/events/{id}/chain/steps/{n}/result — sıra zorunlu (409), SKIPPED gerekçe ister. */
  @Post(':id/chain/steps/:n/result')
  @HttpCode(200)
  result(@Param('id') id: string, @Param('n', ParseIntPipe) n: number, @Req() req: UserRequest, @Body() body: unknown) {
    return this.chain.stepResult(id, n, userOf(req).sub, body);
  }

  /** POST /v1/events/{id}/escalate-112 — gerekçe zorunlu; kalan adımlar atlanır. */
  @Post(':id/escalate-112')
  @HttpCode(200)
  escalate(@Param('id') id: string, @Req() req: UserRequest, @Body() body: unknown) {
    return this.chain.escalate112(id, userOf(req).sub, body);
  }

  /** POST /v1/events/{id}/close — sonuç zorunlu, not ≤ 2000. */
  @Post(':id/close')
  @HttpCode(204)
  async close(@Param('id') id: string, @Req() req: UserRequest, @Body() body: unknown) {
    await this.chain.close(id, userOf(req).sub, body);
  }
}
