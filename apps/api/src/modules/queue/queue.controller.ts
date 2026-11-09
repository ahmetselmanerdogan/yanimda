import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { EventService } from '../event/event.service';
import { OidcGuard, Roles, userOf, type UserRequest } from '../identity/oidc.guard';

const intParam = (v: string | undefined, def: number, min: number, max: number) => {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new BadRequestException(`${min}–${max} arası tamsayı`);
  return n;
};

/** E-02 canlı kuyruk (T-022). Canlı değişiklikler: WebSocket /v1/ws/queue (QueueGateway). */
@Controller()
@UseGuards(OidcGuard)
@Roles('OPERATOR', 'SUPERVISOR')
export class QueueController {
  constructor(@Inject(EventService) private readonly events: EventService) {}

  /** GET /v1/queue?limit=50&offset=0 — öncelik → yaş; operatördeki olaylar `lockedBy` ile. */
  @Get('queue')
  async queue(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    const page = { limit: intParam(limit, 50, 1, 200), offset: intParam(offset, 0, 0, 100_000) };
    const { items, total } = await this.events.queuePage(page);
    return { items, total, ...page };
  }

  /** POST /v1/events/{id}/unclaim — amir: olayı kuyruğa döndür (zincir kaldığı yerden sürer). */
  @Post('events/:id/unclaim')
  @HttpCode(200)
  @Roles('SUPERVISOR')
  async unclaim(@Param('id') id: string, @Req() req: UserRequest, @Body() body: { reason?: unknown } = {}) {
    const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 500) || undefined : undefined;
    const ev = await this.events.unclaim(id, userOf(req).sub, reason);
    return { eventId: ev.id, state: ev.state };
  }
}
