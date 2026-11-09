import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';

import { OidcGuard, Roles, userOf, type UserRequest } from '../identity/oidc.guard';
import { EventService } from './event.service';

/** E-02 kuyruk/üstlen, E-07 kapatma. T-020: operatör kimliği token'dan (`sub`); X-Operator-Id kaldırıldı. */
@Controller()
@UseGuards(OidcGuard)
@Roles('OPERATOR', 'SUPERVISOR')
export class EventController {
  constructor(@Inject(EventService) private readonly events: EventService) {}
  @Get('queue') async queue() {
    return (await this.events.queue()).map((e) => ({
      eventId: e.id,
      type: e.type,
      priority: e.priority,
      state: e.state,
      createdAt: e.createdAt,
      lockedBy: e.operatorId ?? null,
    }));
  }
  @Get('events/:id') get(@Param('id') id: string) {
    return this.events.get(id);
  }
  @Post('events/:id/claim') claim(@Param('id') id: string, @Req() req: UserRequest) {
    return this.events.claim(id, userOf(req).sub);
  }
  @Post('events/:id/close')
  @HttpCode(204)
  async close(@Param('id') id: string, @Req() req: UserRequest, @Body() body: { outcome: string; note?: string }) {
    await this.events.closeByOperator(id, userOf(req).sub, body.outcome, body.note);
  }
}
