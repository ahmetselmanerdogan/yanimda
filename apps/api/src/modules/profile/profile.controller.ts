import {
  Body,
  type CanActivate,
  Controller,
  Delete,
  type ExecutionContext,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Inject,
  Injectable,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';

import { authenticate, type UserRequest } from '../identity/oidc.guard';
import { OidcVerifier } from '../identity/oidc-verifier';
import { AdminTokenGuard } from '../rules/admin-token.guard';
import type { Actor } from './contacts';
import { ProfileService } from './profile.service';

interface ActorRequest extends UserRequest {
  actor?: Actor;
}
const actorOf = (req: ActorRequest) => req.actor!;

/**
 * Profil uçları: aile (consumers realm, FAMILY) kendi kişileri için; yönetici (OIDC ADMIN veya betikler için
 * `x-admin-token`) hepsi için. Bearer gelirse yalnız OIDC denenir. Operatör profil düzenlemez (olay kartı ayrı).
 */
@Injectable()
export class ProfileGuard implements CanActivate {
  private readonly shared = new AdminTokenGuard();
  constructor(@Inject(OidcVerifier) private readonly verifier: OidcVerifier) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<ActorRequest>();
    if (!req.headers.authorization) {
      if (!req.headers['x-admin-token']) throw new UnauthorizedException('Giriş gerekli');
      const ok = this.shared.canActivate(ctx);
      req.actor = { kind: 'ADMIN' };
      return ok;
    }
    const user = await authenticate(this.verifier, req);
    req.user = user;
    if (user.roles.includes('ADMIN')) req.actor = { kind: 'ADMIN', id: user.sub };
    else if (user.realm === 'consumers' && user.roles.includes('FAMILY')) req.actor = { kind: 'FAMILY', id: user.sub };
    else throw new ForbiddenException('Yetki yok');
    return true;
  }
}

/** T-040 profil (C-02, C-03, C-04). Başka ailenin kişisi 404. */
@Controller('protected-persons')
@UseGuards(ProfileGuard)
export class ProfileController {
  constructor(@Inject(ProfileService) private readonly profile: ProfileService) {}

  @Post()
  create(@Body() body: unknown, @Req() req: ActorRequest) {
    return this.profile.create(actorOf(req), body);
  }

  @Get()
  list(
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
    @Req() req: ActorRequest,
  ) {
    const l = Math.min(Math.max(Number(limit ?? 50) || 50, 1), 200);
    const o = Math.max(Number(offset ?? 0) || 0, 0);
    return this.profile.list(actorOf(req), l, o).then((r) => ({ ...r, limit: l, offset: o }));
  }

  @Get(':id')
  get(@Param('id') id: string, @Req() req: ActorRequest) {
    return this.profile.get(actorOf(req), id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown, @Req() req: ActorRequest) {
    return this.profile.update(actorOf(req), id, body);
  }

  /** PUT /v1/protected-persons/{id}/medical — rıza zamanı zorunlu; içerik geri okunmaz. */
  @Put(':id/medical')
  medical(@Param('id') id: string, @Body() body: unknown, @Req() req: ActorRequest) {
    return this.profile.setMedical(actorOf(req), id, body);
  }

  @Delete(':id/medical')
  @HttpCode(204)
  async deleteMedical(@Param('id') id: string, @Req() req: ActorRequest) {
    await this.profile.deleteMedical(actorOf(req), id);
  }

  /** PUT /v1/protected-persons/{id}/contacts — [{role, priority?, displayName?, phone}]; CONTACT sıralı 1–5. */
  @Put(':id/contacts')
  contacts(@Param('id') id: string, @Body() body: unknown, @Req() req: ActorRequest) {
    return this.profile.setContacts(actorOf(req), id, body);
  }

  @Get(':id/contacts')
  listContacts(@Param('id') id: string, @Req() req: ActorRequest) {
    return this.profile.contacts(actorOf(req), id);
  }

  /** POST /v1/protected-persons/{id}/test-sos — TEST olayı (C-05). `Idempotency-Key` aynı isteği tekrarlar. */
  @Post(':id/test-sos')
  @HttpCode(202)
  testSos(@Param('id') id: string, @Headers('idempotency-key') key: string | undefined, @Req() req: ActorRequest) {
    return this.profile.testSos(actorOf(req), id, key);
  }

  @Get(':id/test-sos/:eventId')
  testStatus(@Param('id') id: string, @Param('eventId') eventId: string, @Req() req: ActorRequest) {
    return this.profile.testStatus(actorOf(req), id, eventId);
  }

  /** POST /v1/protected-persons/{id}/invite → { code, expiresAt, smsText } (6 hane, 15 dk, tek kullanım). */
  @Post(':id/invite')
  invite(@Param('id') id: string, @Req() req: ActorRequest) {
    return this.profile.invite(actorOf(req), id);
  }

  /** POST /v1/protected-persons/{id}/members/invite → { code, expiresAt, relation } (72 sa, tek kullanım; OWNER). */
  @Post(':id/members/invite')
  memberInvite(@Param('id') id: string, @Body() body: unknown, @Req() req: ActorRequest) {
    return this.profile.createMemberInvite(actorOf(req), id, body ?? {});
  }

  @Get(':id/members')
  members(@Param('id') id: string, @Req() req: ActorRequest) {
    return this.profile.members(actorOf(req), id);
  }

  @Delete(':id/members/:memberId')
  @HttpCode(204)
  async removeMember(@Param('id') id: string, @Param('memberId') memberId: string, @Req() req: ActorRequest) {
    await this.profile.removeMember(actorOf(req), id, memberId);
  }
}

/** T-040 aile üyesi daveti kabulü: kodu giren aile hesabı (consumers FAMILY) MEMBER olur. */
@Controller('family/members')
@UseGuards(ProfileGuard)
export class FamilyMembersController {
  constructor(@Inject(ProfileService) private readonly profile: ProfileService) {}

  @Post('accept')
  accept(@Body() body: unknown, @Req() req: ActorRequest) {
    return this.profile.acceptMemberInvite(actorOf(req), body);
  }
}
