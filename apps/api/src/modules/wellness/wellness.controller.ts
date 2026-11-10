import { Body, Controller, Get, Inject, Param, Put, Query, Req, UseGuards } from '@nestjs/common';

import { OidcGuard, Roles, userOf, type UserRequest } from '../identity/oidc.guard';
import type { Actor } from '../profile/contacts';
import { type CheckStatus, WellnessService } from './wellness.service';

const actorOf = (req: UserRequest): Actor => {
  const u = userOf(req);
  return u.roles.includes('FAMILY') && u.realm === 'consumers'
    ? { kind: 'FAMILY', id: u.sub }
    : { kind: 'ADMIN', id: u.sub };
};
const STATUSES: CheckStatus[] = ['SCHEDULED', 'IN_PROGRESS', 'DONE_OK', 'DONE_HELP', 'NOTIFIED', 'MISSED', 'SKIPPED'];

/** Düzenli "yanınızdayız" aramaları: plan (aile sahibi / operasyon), dönemler ve uyum (çağrı merkezi, yönetim). */
@Controller()
@UseGuards(OidcGuard)
export class WellnessController {
  constructor(@Inject(WellnessService) private readonly wellness: WellnessService) {}

  @Get('protected-persons/:id/check-plan')
  @Roles('FAMILY', 'SUPERVISOR', 'ADMIN')
  plan(@Param('id') id: string, @Req() req: UserRequest) {
    return this.wellness.plan(actorOf(req), id);
  }

  @Put('protected-persons/:id/check-plan')
  @Roles('FAMILY', 'SUPERVISOR', 'ADMIN')
  setPlan(@Param('id') id: string, @Req() req: UserRequest, @Body() body: unknown) {
    return this.wellness.setPlan(actorOf(req), id, body);
  }

  @Get('wellness/checks')
  @Roles('OPERATOR', 'SUPERVISOR', 'ADMIN')
  checks(@Query('personId') personId?: string, @Query('status') status?: string, @Query('days') days?: string) {
    const st = (status ?? '').split(',').filter((s): s is CheckStatus => STATUSES.includes(s as CheckStatus));
    const d = Math.min(Math.max(Number(days) || 30, 1), 365);
    return this.wellness.checks({
      ...(personId ? { personId } : {}),
      ...(st.length ? { status: st } : {}),
      from: new Date(Date.now() - d * 86_400_000),
      to: new Date(Date.now() + 14 * 86_400_000),
    });
  }

  @Get('wellness/compliance')
  @Roles('SUPERVISOR', 'ADMIN')
  compliance(@Query('personId') personId?: string, @Query('days') days?: string) {
    return this.wellness.compliance(personId || undefined, Math.min(Math.max(Number(days) || 30, 1), 365));
  }
}
