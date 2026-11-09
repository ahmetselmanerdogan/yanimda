import { Controller, Get, Inject, UseGuards } from '@nestjs/common';

import { OidcGuard, Roles } from '../identity/oidc.guard';
import { EventService } from './event.service';

/** E-02 kuyruk. Üstlenme, zincir ve kapatma: chain modülü (T-021). Operatör kimliği token'dan (T-020). */
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
}
