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
  /** T-087 (docs/07 S5.6) anahtar sahibi: yakın (CONTACT) veya komşu kaydının özelliği. */
  hasKey?: boolean;
  /** Eve varma süresi (dk, 1–600). */
  arrivalMin?: number | null;
  /** Ulaşılabilir saatler "HH:MM-HH:MM" (kişinin saat diliminde; gece yarısını geçebilir). Yoksa her zaman. */
  reachableHours?: string | null;
}
export interface ContactView {
  id: string;
  role: ContactRole;
  priority: number;
  displayName: string | null;
  /** Son 2 hane: aile ekranında hangisi olduğunu tanımak için; tam numara geri verilmez. */
  phoneLast2: string;
  hasKey: boolean;
  arrivalMin: number | null;
  reachableHours: string | null;
}
export interface Actor {
  kind: 'ADMIN' | 'FAMILY';
  id?: string;
}

const ROLES: ContactRole[] = ['ELDER', 'WATCH', 'CONTACT', 'NEIGHBOR'];
const E164 = /^\+[1-9]\d{6,14}$/;
const HOURS = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
const KEY_ROLES: ContactRole[] = ['CONTACT', 'NEIGHBOR'];
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
    if (x.hasKey !== undefined && typeof x.hasKey !== 'boolean')
      throw new BadRequestException(`#${i}: hasKey true/false`);
    if (x.hasKey && !KEY_ROLES.includes(x.role as ContactRole))
      throw new BadRequestException(`#${i}: anahtar sahibi yalnız yakın veya komşu olabilir`);
    const arrivalMin = x.arrivalMin ?? null;
    if (arrivalMin !== null && (!Number.isInteger(arrivalMin) || arrivalMin < 1 || arrivalMin > 600))
      throw new BadRequestException(`#${i}: arrivalMin 1–600`);
    const reachableHours = x.reachableHours ?? null;
    if (reachableHours !== null && (typeof reachableHours !== 'string' || !HOURS.test(reachableHours)))
      throw new BadRequestException(`#${i}: reachableHours SS:DD-SS:DD`);
    return {
      role: x.role as ContactRole,
      priority,
      displayName: x.displayName?.trim().slice(0, 100) || null,
      phoneE164: x.phone,
      hasKey: x.hasKey ?? false,
      arrivalMin,
      reachableHours,
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
      data: {
        count: rows.length,
        contacts: rows.filter((r) => r.role === 'CONTACT').length,
        keyHolders: rows.filter((r) => r.hasKey).length,
      },
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
      hasKey: r.hasKey,
      arrivalMin: r.arrivalMin,
      reachableHours: r.reachableHours,
    }));
}

/** "HH:MM-HH:MM" penceresi `now` anında (kişinin saat diliminde) açık mı; pencere yoksa her zaman. */
export function reachableAt(hours: string | null, now: Date, timeZone: string): boolean {
  if (!hours || !HOURS.test(hours)) return true;
  const [from, to] = hours.split('-').map((h) => {
    const [a, b] = h.split(':').map(Number);
    return a! * 60 + b!;
  }) as [number, number];
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now)
    .reduce<Record<string, string>>((m, p) => ({ ...m, [p.type]: p.value }), {});
  const cur = Number(parts.hour) * 60 + Number(parts.minute);
  return from <= to ? cur >= from && cur < to : cur >= from || cur < to;
}

/**
 * T-087 (S5.2, S5.6): aranacak anahtar sahibi — anahtarı olan, şu an ulaşılabilir kayıtlar içinde eve varma süresi
 * en kısa olan (süre bilinmeyen sona); yoksa null.
 */
export function pickKeyHolder<T extends { hasKey: boolean; arrivalMin: number | null; reachableHours: string | null }>(
  rows: T[],
  now: Date,
  timeZone: string,
): T | null {
  const ok = rows.filter((r) => r.hasKey && reachableAt(r.reachableHours, now, timeZone));
  ok.sort((a, b) => (a.arrivalMin ?? Infinity) - (b.arrivalMin ?? Infinity));
  return ok[0] ?? null;
}
