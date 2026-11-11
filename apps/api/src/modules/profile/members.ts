import { createHash, randomInt } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  type HttpException,
  NotFoundException,
} from '@nestjs/common';
import { t } from '@yanimda/messages';
import { and, asc, count, eq, gt, isNull, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import type { Db, Tx } from '../../db/client';
import { auditLog, familyMember, memberInvite, protectedPerson } from '../../db/schema';
import type { Actor } from './contacts';

/**
 * T-040 aile üyesi (MEMBER) daveti (C-02, C-04). Hesap sahibi (OWNER) kod üretir; ikinci aile hesabı kodu girer ve
 * MEMBER olur (olayları ve bildirimleri görür; güvenlik ayarlarını değiştiremez). Kod 10 karakter Crockford base32
 * (~50 bit; 72 saat açık kaldığı için cihaz davetinin 6 hanesinden uzun), tek kullanımlık; yalnız sha256 özeti
 * saklanır. Denetim kaydına yalnız kimlikler yazılır (kod, ilişki, e-posta, telefon yok).
 */
export const MEMBER_INVITE_TTL_MS = 72 * 3_600_000;
export const MAX_ACTIVE_MEMBER_INVITES = 5;
/** Kişi başına aile hesabı (OWNER dahil). */
export const MAX_FAMILY_MEMBERS = 10;

export type MemberRole = 'OWNER' | 'MEMBER';
export interface MemberView {
  id: string;
  role: MemberRole;
  relation: string | null;
  createdAt: string;
  /** Bu kayıt isteği yapan hesaba mı ait (başka üyenin kimliği/iletişim bilgisi dönmez). */
  isMe: boolean;
}

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: I, L, O, U yok
const CODE = /^[0-9A-HJKMNP-TV-Z]{10}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function newMemberCode(): string {
  let s = '';
  for (let i = 0; i < 10; i++) s += ALPHABET[randomInt(0, ALPHABET.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

/** Kullanıcı girişi → kanonik kod: büyük harf, boşluk/tire yok; O→0, I/L→1 (Crockford). Biçimsizse null. */
export function normalizeMemberCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 40) return null;
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return CODE.test(s) ? s : null;
}

const hashCode = (canonical: string) => createHash('sha256').update(`yanimda-member-invite:${canonical}`).digest('hex');

/** Katalog kodlu hata: `detail` katalog metni, `code` istemcinin kendi kataloğu için (ProblemFilter). */
function fail(Ex: new (body: object) => HttpException, code: string): HttpException {
  return new Ex({ message: t(code, 'tr'), code });
}

function relationOf(body: unknown): string | null {
  if (body === undefined || body === null) return null;
  if (typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Nesne bekleniyor');
  const v = (body as Record<string, unknown>).relation;
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new BadRequestException('relation metin olmalı');
  const s = v.trim();
  if (s.length > 50) throw new BadRequestException('relation en fazla 50 karakter');
  return s || null;
}

/** Kişi satırını kilitler (sayım sınırları yarışsız) ve aile hesabı sayısını döner. */
async function lockAndCountMembers(tx: Tx, personId: string): Promise<number> {
  await tx
    .select({ id: protectedPerson.id })
    .from(protectedPerson)
    .where(eq(protectedPerson.id, personId))
    .for('update');
  const [{ n }] = await tx
    .select({ n: count() })
    .from(familyMember)
    .where(eq(familyMember.protectedPersonId, personId));
  return Number(n);
}

function audit(tx: Tx, actor: Actor, action: string, personId: string, data: Record<string, unknown>) {
  return tx.insert(auditLog).values({
    actorKind: actor.kind,
    actorId: actor.id ?? null,
    action,
    entityType: 'protected_person',
    entityId: personId,
    data,
  });
}

/** Çağıran yetkiyi (OWNER/ADMIN) denetlemiş olmalı. */
export async function createMemberInvite(db: Db, actor: Actor, personId: string, body: unknown, now = new Date()) {
  const relation = relationOf(body);
  const expiresAt = new Date(now.getTime() + MEMBER_INVITE_TTL_MS);
  return db.transaction(async (tx) => {
    if ((await lockAndCountMembers(tx, personId)) >= MAX_FAMILY_MEMBERS)
      throw fail(ConflictException, 'F-MEMBER-LIMIT');
    const [{ open }] = await tx
      .select({ open: count() })
      .from(memberInvite)
      .where(
        and(eq(memberInvite.protectedPersonId, personId), isNull(memberInvite.usedAt), gt(memberInvite.expiresAt, now)),
      );
    if (Number(open) >= MAX_ACTIVE_MEMBER_INVITES) throw fail(ConflictException, 'F-MEMBER-INVITE-LIMIT');
    let code = newMemberCode();
    // ~50 bit: çakışma pratikte olmaz; yine de benzersiz indekse çarpıp 500 vermesin.
    for (let i = 0; i < 3; i++) {
      const [clash] = await tx
        .select({ id: memberInvite.id })
        .from(memberInvite)
        .where(eq(memberInvite.codeHash, hashCode(code.replace('-', ''))));
      if (!clash) break;
      code = newMemberCode();
    }
    const id = uuidv7();
    await tx.insert(memberInvite).values({
      id,
      protectedPersonId: personId,
      codeHash: hashCode(code.replace('-', '')),
      createdBy: actor.id ?? actor.kind,
      relation,
      expiresAt,
      createdAt: now,
    });
    await audit(tx, actor, 'profile.member_invite_created', personId, {
      inviteId: id,
      expiresAt: expiresAt.toISOString(),
    });
    return { code, expiresAt: expiresAt.toISOString(), relation };
  });
}

/** POST /v1/family/members/accept — yalnız aile hesabı (consumers FAMILY). */
export async function acceptMemberInvite(db: Db, actor: Actor, body: unknown, now = new Date()) {
  if (actor.kind !== 'FAMILY' || !actor.id) throw new ForbiddenException('Yalnız aile hesabı');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Nesne bekleniyor');
  const canonical = normalizeMemberCode((body as Record<string, unknown>).code);
  if (!canonical) throw fail(BadRequestException, 'F-MEMBER-CODE-INVALID');
  const subject = actor.id;
  return db.transaction(async (tx) => {
    const [inv] = await tx
      .select()
      .from(memberInvite)
      .where(eq(memberInvite.codeHash, hashCode(canonical)))
      .for('update');
    if (!inv) throw fail(BadRequestException, 'F-MEMBER-CODE-INVALID');
    const [mine] = await tx
      .select({ id: familyMember.id })
      .from(familyMember)
      .where(and(eq(familyMember.protectedPersonId, inv.protectedPersonId), eq(familyMember.subject, subject)));
    // Zaten üye (sahip kendi kodunu denedi ya da çift tıklama): 409; kod harcanmaz.
    if (mine) throw fail(ConflictException, 'F-MEMBER-ALREADY');
    if (inv.usedAt) throw fail(BadRequestException, 'F-MEMBER-CODE-USED');
    if (inv.expiresAt.getTime() <= now.getTime()) throw fail(BadRequestException, 'F-MEMBER-CODE-EXPIRED');
    if ((await lockAndCountMembers(tx, inv.protectedPersonId)) >= MAX_FAMILY_MEMBERS)
      throw fail(ConflictException, 'F-MEMBER-LIMIT');
    const memberId = uuidv7();
    await tx.insert(familyMember).values({
      id: memberId,
      protectedPersonId: inv.protectedPersonId,
      subject,
      role: 'MEMBER',
      relation: inv.relation,
      createdAt: now,
    });
    await tx.update(memberInvite).set({ usedAt: now, usedBy: subject }).where(eq(memberInvite.id, inv.id));
    await audit(tx, actor, 'profile.member_added', inv.protectedPersonId, {
      memberId,
      inviteId: inv.id,
      role: 'MEMBER',
    });
    return { protectedPersonId: inv.protectedPersonId, memberId, role: 'MEMBER' as const };
  });
}

/** Çağıran erişimi (OWNER/MEMBER/ADMIN) denetlemiş olmalı. Sahipler önce, sonra katılma sırası. */
export async function listMembers(db: Db, actor: Actor, personId: string): Promise<{ items: MemberView[] }> {
  const rows = await db
    .select()
    .from(familyMember)
    .where(eq(familyMember.protectedPersonId, personId))
    .orderBy(
      sql`CASE WHEN ${familyMember.role} = 'OWNER' THEN 0 ELSE 1 END`,
      asc(familyMember.createdAt),
      asc(familyMember.id),
    );
  return {
    items: rows.map((r) => ({
      id: r.id,
      role: r.role as MemberRole,
      relation: r.relation,
      createdAt: r.createdAt.toISOString(),
      isMe: actor.kind === 'FAMILY' && r.subject === actor.id,
    })),
  };
}

/**
 * Üyeyi çıkar: OWNER (veya yönetici) herkesi, MEMBER yalnız kendini. Son hesap sahibi çıkarılamaz (409).
 * `role`: çağıranın bu kişideki rolü (erişim denetiminden).
 */
export async function removeMember(db: Db, actor: Actor, role: MemberRole | null, personId: string, memberId: string) {
  if (!UUID.test(memberId)) throw new NotFoundException('Üye bulunamadı');
  await db.transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(familyMember)
      .where(and(eq(familyMember.id, memberId), eq(familyMember.protectedPersonId, personId)))
      .for('update');
    if (!target) throw new NotFoundException('Üye bulunamadı');
    const self = actor.kind === 'FAMILY' && target.subject === actor.id;
    if (actor.kind === 'FAMILY' && role !== 'OWNER' && !self) throw fail(ForbiddenException, 'F-MEMBER-OWNER-ONLY');
    if (target.role === 'OWNER') {
      const owners = await tx
        .select({ id: familyMember.id })
        .from(familyMember)
        .where(and(eq(familyMember.protectedPersonId, personId), eq(familyMember.role, 'OWNER')))
        .for('update');
      if (owners.length <= 1) throw fail(ConflictException, 'F-MEMBER-LAST-OWNER');
    }
    await tx.delete(familyMember).where(eq(familyMember.id, memberId));
    await audit(tx, actor, 'profile.member_removed', personId, { memberId, role: target.role, self });
  });
}
