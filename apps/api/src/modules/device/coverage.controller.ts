import {
  BadRequestException,
  Body,
  type CanActivate,
  Controller,
  Delete,
  type ExecutionContext,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { DeviceSummary } from '@yanimda/contracts';
import { and, eq, isNull } from 'drizzle-orm';

import { DB, type Db } from '../../db/client';
import { auditLog, device } from '../../db/schema';
import { isBodyLocation } from '../event/coverage.service';
import { ProtectionService } from '../event/protection.service';
import { authenticate, type UserRequest } from '../identity/oidc.guard';
import { OidcVerifier } from '../identity/oidc-verifier';
import { AdminTokenGuard } from '../rules/admin-token.guard';
import { EnrollmentService } from './enrollment.service';

/**
 * T-085 / T-086 kapsama ve cihaz uçlarının çağıranı: kişinin kendi cihaz token'ı, operasyon (OIDC operations
 * OPERATOR / SUPERVISOR / ADMIN), aile (consumers FAMILY; kişiye OWNER veya MEMBER olarak bağlı) veya betikler için
 * `x-admin-token`. Bearer önce cihaz token'ı olarak denenir (HMAC; Keycloak token'ı imzayı geçemez), olmazsa OIDC.
 */
export type CoverageActor =
  | { kind: 'DEVICE'; personId: string; deviceId: string }
  | { kind: 'OPS'; sub: string; supervisor: boolean }
  | { kind: 'FAMILY'; sub: string }
  | { kind: 'ADMIN'; sub?: string };

interface ActorRequest extends UserRequest {
  coverageActor?: CoverageActor;
}
const actorOf = (req: ActorRequest) => req.coverageActor!;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class CoverageAccessGuard implements CanActivate {
  private readonly shared = new AdminTokenGuard();
  constructor(
    @Inject(EnrollmentService) private readonly enrollment: Pick<EnrollmentService, 'authenticate'>,
    @Inject(OidcVerifier) private readonly verifier: OidcVerifier,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<ActorRequest>();
    const h = req.headers.authorization;
    const auth = Array.isArray(h) ? h[0] : h;
    if (!auth) {
      if (!req.headers['x-admin-token']) throw new UnauthorizedException('Giriş gerekli');
      this.shared.canActivate(ctx);
      req.coverageActor = { kind: 'ADMIN' };
      return true;
    }
    try {
      const d = await this.enrollment.authenticate(auth);
      req.coverageActor = { kind: 'DEVICE', personId: d.protectedPersonId, deviceId: d.deviceId };
      return true;
    } catch (e) {
      if (!(e instanceof UnauthorizedException)) throw e;
    }
    const u = await authenticate(this.verifier, req);
    req.user = u;
    if (u.roles.includes('ADMIN')) req.coverageActor = { kind: 'ADMIN', sub: u.sub };
    else if (u.realm === 'operations' && u.roles.some((r) => r === 'OPERATOR' || r === 'SUPERVISOR'))
      req.coverageActor = { kind: 'OPS', sub: u.sub, supervisor: u.roles.includes('SUPERVISOR') };
    else if (u.realm === 'consumers' && u.roles.includes('FAMILY')) req.coverageActor = { kind: 'FAMILY', sub: u.sub };
    else throw new ForbiddenException('Yetki yok');
    return true;
  }
}

type PersonOp = 'read' | 'plan';
type DeviceOp = 'patch' | 'delete' | 'intent';

/** Yetki kuralları (erişimi olmayan kişi / cihaz 404, rolü yetmeyen 403). */
@Injectable()
export class CoverageAccess {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ProtectionService) private readonly protection: Pick<ProtectionService, 'canFamilySee'>,
  ) {}

  async person(a: CoverageActor, personId: string, op: PersonOp): Promise<void> {
    switch (a.kind) {
      case 'ADMIN':
        return;
      case 'OPS':
        if (op === 'plan') throw new ForbiddenException('Şarj planını aile değiştirir');
        return;
      case 'DEVICE':
        if (a.personId !== personId) throw new NotFoundException('Kişi bulunamadı');
        if (op === 'plan') throw new ForbiddenException('Şarj planını aile değiştirir');
        return;
      case 'FAMILY':
        if (!(await this.protection.canFamilySee(a.sub, personId))) throw new NotFoundException('Kişi bulunamadı');
    }
  }

  /** Cihazın kişisi (etkin cihaz; kaldırma için kaldırılmış da bulunur). */
  async device(a: CoverageActor, deviceId: string, op: DeviceOp): Promise<string> {
    if (!UUID.test(deviceId)) throw new NotFoundException('Cihaz bulunamadı');
    const [d] = await this.db
      .select({ personId: device.protectedPersonId })
      .from(device)
      .where(op === 'delete' ? eq(device.id, deviceId) : and(eq(device.id, deviceId), isNull(device.revokedAt)));
    if (!d) throw new NotFoundException('Cihaz bulunamadı');
    switch (a.kind) {
      case 'ADMIN':
        break;
      case 'OPS':
        if (op === 'intent') throw new ForbiddenException('Yetki yok');
        if (op === 'delete' && !a.supervisor) throw new ForbiddenException('Cihazı aile veya amir kaldırır');
        break;
      case 'DEVICE':
        if (a.personId !== d.personId) throw new NotFoundException('Cihaz bulunamadı');
        if (op !== 'intent') throw new ForbiddenException('Yetki yok');
        break;
      case 'FAMILY':
        if (!(await this.protection.canFamilySee(a.sub, d.personId))) throw new NotFoundException('Cihaz bulunamadı');
    }
    return d.personId;
  }
}

/** T-085 (S8.3) kapsama, cihaz listesi; T-086 şarj penceresi. */
@Controller('protected-persons')
@UseGuards(CoverageAccessGuard)
export class CoverageController {
  constructor(
    @Inject(ProtectionService) private readonly protection: ProtectionService,
    @Inject(CoverageAccess) private readonly access: CoverageAccess,
  ) {}

  /** GET /v1/protected-persons/{id}/coverage */
  @Get(':id/coverage')
  async coverage(@Param('id') id: string, @Req() req: ActorRequest) {
    await this.access.person(actorOf(req), id, 'read');
    return this.protection.coverage.view(id);
  }

  /** GET /v1/protected-persons/{id}/devices */
  @Get(':id/devices')
  async devices(@Param('id') id: string, @Req() req: ActorRequest) {
    await this.access.person(actorOf(req), id, 'read');
    return this.protection.coverage.devices(id);
  }

  /** GET /v1/protected-persons/{id}/charging-plan */
  @Get(':id/charging-plan')
  async plan(@Param('id') id: string, @Req() req: ActorRequest) {
    await this.access.person(actorOf(req), id, 'read');
    return this.protection.coverage.chargingPlan(id);
  }

  /** PUT /v1/protected-persons/{id}/charging-plan — aile (OWNER/MEMBER) veya yönetici. */
  @Put(':id/charging-plan')
  async setPlan(@Param('id') id: string, @Body() body: unknown, @Req() req: ActorRequest) {
    const a = actorOf(req);
    await this.access.person(a, id, 'plan');
    return this.protection.coverage.setChargingPlan(id, body, 'sub' in a && a.sub ? a.sub : 'admin');
  }
}

/** T-085 (S1.8, S1.9, S9.4) cihaz düzenleme ve kaldırma; T-086 (S4.5) "şarj ediyorum". */
@Controller('devices')
@UseGuards(CoverageAccessGuard)
export class DeviceManageController {
  private readonly log = new Logger('Devices');
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(EnrollmentService) private readonly enrollment: EnrollmentService,
    @Inject(ProtectionService) private readonly protection: ProtectionService,
    @Inject(CoverageAccess) private readonly access: CoverageAccess,
  ) {}

  /** PATCH /v1/devices/{id} — vücut konumu, takma ad, sesli arama sırası (aile / operasyon). */
  @Patch(':id')
  async patch(@Param('id') id: string, @Body() body: unknown, @Req() req: ActorRequest): Promise<DeviceSummary> {
    const personId = await this.access.device(actorOf(req), id, 'patch');
    const set = parsePatch(body);
    await this.db.transaction(async (tx) => {
      await tx.update(device).set(set).where(eq(device.id, id));
      await tx.insert(auditLog).values({
        actorKind: actorKindOf(actorOf(req)),
        actorId: subOf(actorOf(req)),
        action: 'device.updated',
        entityType: 'device',
        entityId: id,
        data: { fields: Object.keys(set) },
      });
    });
    const s = (await this.protection.coverage.devices(personId)).find((d) => d.id === id.toLowerCase());
    if (!s) throw new NotFoundException('Cihaz bulunamadı');
    return s;
  }

  /**
   * DELETE /v1/devices/{id} — kayıp / çalıntı / değişim: token anında iptal (401), cihaz emekli, kapsama hemen
   * yeniden hesaplanır. Aile, amir veya yönetici.
   */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @Req() req: ActorRequest) {
    await this.access.device(actorOf(req), id, 'delete');
    const { protectedPersonId } = await this.enrollment.revoke(id);
    await this.db.insert(auditLog).values({
      actorKind: actorKindOf(actorOf(req)),
      actorId: subOf(actorOf(req)),
      action: 'device.revoked',
      entityType: 'device',
      entityId: id,
      data: null,
    });
    await this.protection.coverage.removeDevice(protectedPersonId, id.toLowerCase());
    this.log.log('Cihaz kaldırıldı; kapsama yeniden hesaplandı');
  }

  /** POST /v1/devices/{id}/charging-intent — kişinin kendi cihazı veya aile. 202 { until }. */
  @Post(':id/charging-intent')
  @HttpCode(202)
  async chargingIntent(@Param('id') id: string, @Body() body: unknown, @Req() req: ActorRequest) {
    const a = actorOf(req);
    const personId = await this.access.device(a, id, 'intent');
    const b = (body ?? {}) as { minutes?: unknown };
    if (b.minutes !== undefined && typeof b.minutes !== 'number') throw new BadRequestException('minutes sayı olmalı');
    const r = await this.protection.coverage.chargingIntent(personId, b.minutes as number | undefined, a.kind);
    return { until: r.until };
  }
}

const actorKindOf = (a: CoverageActor) => (a.kind === 'DEVICE' ? 'USER' : a.kind === 'FAMILY' ? 'FAMILY' : 'OPERATOR');
const subOf = (a: CoverageActor) => (a.kind === 'DEVICE' ? a.deviceId : 'sub' in a ? (a.sub ?? null) : null);

/** PATCH gövdesi: en az bir alan; null alanı temizler. */
function parsePatch(body: unknown): Partial<typeof device.$inferInsert> {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw new BadRequestException('Nesne bekleniyor');
  const b = body as Record<string, unknown>;
  const set: Partial<typeof device.$inferInsert> = {};
  const unknownKeys = Object.keys(b).filter((k) => !['bodyLocation', 'nickname', 'voiceOrder'].includes(k));
  if (unknownKeys.length) throw new BadRequestException(`Bilinmeyen alan: ${unknownKeys.join(', ')}`);
  if (b.bodyLocation !== undefined) {
    if (b.bodyLocation !== null && !isBodyLocation(b.bodyLocation))
      throw new BadRequestException('bodyLocation geçersiz');
    set.bodyLocation = b.bodyLocation as string | null;
  }
  if (b.nickname !== undefined) {
    const n = typeof b.nickname === 'string' ? b.nickname.trim() : b.nickname;
    if (n !== null && (typeof n !== 'string' || n.length < 1 || n.length > 40))
      throw new BadRequestException('nickname 1–40 karakter olmalı');
    set.nickname = n as string | null;
  }
  if (b.voiceOrder !== undefined) {
    const v = b.voiceOrder;
    if (v !== null && (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 6))
      throw new BadRequestException('voiceOrder 1–6 arası tam sayı olmalı');
    set.voiceOrder = v as number | null;
  }
  if (!Object.keys(set).length) throw new BadRequestException('Değiştirilecek alan yok');
  return set;
}
