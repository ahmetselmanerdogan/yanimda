import { Controller, Get, Header, Inject, Param, Query, Req, StreamableFile, UseGuards } from '@nestjs/common';

import { OidcGuard, Roles, userOf, type UserRequest } from '../identity/oidc.guard';
import { AdminService } from './admin.service';

const DAY = 86_400_000;
const range = (days?: string, from?: string, to?: string) => {
  const end = to && !Number.isNaN(Date.parse(to)) ? new Date(to) : new Date(Date.now() + 60_000);
  const start =
    from && !Number.isNaN(Date.parse(from))
      ? new Date(from)
      : new Date(end.getTime() - Math.min(Math.max(Number(days) || 7, 1), 365) * DAY);
  return { from: start, to: end };
};

/** Yönetim ve çağrı merkezi paneli: çağrı kaydı, ses kaydı, analiz (amir + yönetici); denetim ve sağlık (yönetici + amir). */
@Controller('admin')
@UseGuards(OidcGuard)
@Roles('SUPERVISOR', 'ADMIN')
export class AdminController {
  constructor(@Inject(AdminService) private readonly admin: AdminService) {}

  /** GET /v1/admin/calls — kim kimi aradı, cevap, süre, sonuç, kayıt var mı (numara yok). */
  @Get('calls')
  calls(
    @Query('days') days?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('operatorId') operatorId?: string,
    @Query('eventId') eventId?: string,
    @Query('answered') answered?: string,
  ) {
    return this.admin.calls({
      ...range(days, from, to),
      ...(operatorId ? { operatorId } : {}),
      ...(eventId ? { eventId } : {}),
      ...(answered === 'true' || answered === 'false' ? { answered: answered === 'true' } : {}),
    });
  }

  /** GET /v1/admin/calls/{id}/recording?reason= — ses kaydı (her dinleme denetim kaydına yazılır). */
  @Get('calls/:id/recording')
  @Header('Cache-Control', 'no-store')
  async recording(@Param('id') id: string, @Query('reason') reason: string | undefined, @Req() req: UserRequest) {
    const u = userOf(req);
    const r = await this.admin.recording(
      id,
      { id: u.sub, role: u.roles.includes('ADMIN') ? 'ADMIN' : 'SUPERVISOR' },
      reason,
    );
    return new StreamableFile(r.body, { type: r.contentType, disposition: 'inline' });
  }

  /** GET /v1/admin/events — olay arama (kişi adı parçası veya olay kimliği, tür, sonuç, operatör). */
  @Get('events')
  events(
    @Query('days') days?: string,
    @Query('q') q?: string,
    @Query('type') type?: string,
    @Query('outcome') outcome?: string,
    @Query('operatorId') operatorId?: string,
  ) {
    return this.admin.events({
      ...range(days),
      ...(q ? { q: q.slice(0, 100) } : {}),
      ...(type ? { type } : {}),
      ...(outcome ? { outcome } : {}),
      ...(operatorId ? { operatorId } : {}),
    });
  }

  /** GET /v1/admin/events/{id}/case — vaka dosyası (tüm iz; numara / adres / sağlık yok). */
  @Get('events/:id/case')
  caseFile(@Param('id') id: string) {
    return this.admin.caseFile(id);
  }

  @Get('analytics')
  analytics(@Query('days') days?: string) {
    return this.admin.analytics(Math.min(Math.max(Number(days) || 30, 1), 365));
  }

  @Get('audit')
  @Roles('ADMIN', 'SUPERVISOR')
  audit(
    @Query('days') days?: string,
    @Query('action') action?: string,
    @Query('actorId') actorId?: string,
    @Query('entityId') entityId?: string,
  ) {
    return this.admin.audit({
      ...range(days),
      ...(action ? { action } : {}),
      ...(actorId ? { actorId } : {}),
      ...(entityId ? { entityId } : {}),
    });
  }

  @Get('health')
  health() {
    return this.admin.health();
  }
}
