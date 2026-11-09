import { BadRequestException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import type { Db } from '../../db/client';
import { auditLog, contact } from '../../db/schema';

export type ContactRole = 'ELDER' | 'WATCH' | 'CONTACT' | 'NEIGHBOR';
export interface ContactInput {
  role: ContactRole;
  priority?: number;
  displayName?: string;
  phone: string;
}
export interface ContactView {
  id: string;
  role: ContactRole;
  priority: number;
  displayName: string | null;
  /** Son 2 hane: aile ekranında hangisi olduğunu tanımak için; tam numara geri verilmez. */
  phoneLast2: string;
}
export interface Actor {
  kind: 'ADMIN' | 'FAMILY';
  id?: string;
}

const ROLES: ContactRole[] = ['ELDER', 'WATCH', 'CONTACT', 'NEIGHBOR'];
const E164 = /^\+[1-9]\d{6,14}$/;
export const MAX_CONTACTS = 5;

/**
 * T-040 (C-03) zincirin arayacağı numaralar. CONTACT sıralı 1–5 (öncelik verilmezse liste sırası); ELDER, WATCH,
 * NEIGHBOR en çok birer. Liste bütün olarak değişir. Numara log'a ve denetim kaydına yazılmaz (yalnız sayılar).
 */
export function parseContacts(input: unknown): Omit<typeof contact.$inferInsert, 'id' | 'protectedPersonId'>[] {
  if (!Array.isArray(input)) throw new BadRequestException('Liste bekleniyor');
  let order = 0;
  const rows = input.map((x: Partial<ContactInput> | null, i) => {
    if (!x || !ROLES.includes(x.role as ContactRole)) throw new BadRequestException(`#${i}: rol geçersiz`);
    if (typeof x.phone !== 'string' || !E164.test(x.phone)) throw new BadRequestException(`#${i}: numara E.164 olmalı`);
    const priority = x.priority ?? (x.role === 'CONTACT' ? ++order : 1);
    if (!Number.isInteger(priority) || priority < 1 || priority > MAX_CONTACTS)
      throw new BadRequestException(`#${i}: öncelik 1–${MAX_CONTACTS}`);
    if (x.displayName !== undefined && typeof x.displayName !== 'string')
      throw new BadRequestException(`#${i}: ad geçersiz`);
    return {
      role: x.role as ContactRole,
      priority,
      displayName: x.displayName?.trim().slice(0, 100) || null,
      phoneE164: x.phone,
    };
  });
  const count = (r: ContactRole) => rows.filter((x) => x.role === r).length;
  if (count('CONTACT') > MAX_CONTACTS) throw new BadRequestException(`En fazla ${MAX_CONTACTS} yakın`);
  for (const r of ['ELDER', 'WATCH', 'NEIGHBOR'] as const)
    if (count(r) > 1) throw new BadRequestException(`${r} en fazla bir numara`);
  const seen = new Set(rows.map((x) => `${x.role}:${x.priority}`));
  if (seen.size !== rows.length) throw new BadRequestException('Aynı rolde aynı öncelik iki kez');
  return rows;
}

export async function replaceContacts(db: Db, personId: string, input: unknown, actor: Actor) {
  const rows = parseContacts(input).map((r) => ({ ...r, id: uuidv7(), protectedPersonId: personId }));
  await db.transaction(async (tx) => {
    await tx.delete(contact).where(eq(contact.protectedPersonId, personId));
    if (rows.length) await tx.insert(contact).values(rows);
    await tx.insert(auditLog).values({
      actorKind: actor.kind,
      actorId: actor.id ?? null,
      action: 'profile.contacts_set',
      entityType: 'protected_person',
      entityId: personId,
      data: { count: rows.length, contacts: rows.filter((r) => r.role === 'CONTACT').length },
    });
  });
  return { count: rows.length };
}

export async function listContacts(db: Db, personId: string): Promise<ContactView[]> {
  const rows = await db.select().from(contact).where(eq(contact.protectedPersonId, personId));
  return rows
    .sort(
      (a, b) => ROLES.indexOf(a.role as ContactRole) - ROLES.indexOf(b.role as ContactRole) || a.priority - b.priority,
    )
    .map((r) => ({
      id: r.id,
      role: r.role as ContactRole,
      priority: r.priority,
      displayName: r.displayName,
      phoneLast2: r.phoneE164.slice(-2),
    }));
}
