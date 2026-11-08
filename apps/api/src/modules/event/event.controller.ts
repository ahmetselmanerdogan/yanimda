import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post } from '@nestjs/common';

import { EventService } from './event.service';

/** E-02 kuyruk/üstlen, E-07 kapatma. TODO T-020: OIDC guard; operatör kimliği token'dan. S0: X-Operator-Id başlığı. */
@Controller()
export class EventController {
  constructor(@Inject(EventService) private readonly events: EventService) {}
  @Get('queue') queue() {
    return this.events.queue().map((e) => ({
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
  @Post('events/:id/claim') claim(@Param('id') id: string, @Headers('x-operator-id') op = 'op-dev') {
    return this.events.claim(id, op);
  }
  @Post('events/:id/close')
  @HttpCode(204)
  close(
    @Param('id') id: string,
    @Headers('x-operator-id') op = 'op-dev',
    @Body() body: { outcome: string; note?: string },
  ) {
    this.events.closeByOperator(id, op, body.outcome, body.note);
  }
}
