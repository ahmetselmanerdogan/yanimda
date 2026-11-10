import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { t } from '@yanimda/messages';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { FieldCipher } from '../../common/field-cipher';
import { safeError } from '../../common/safe-error';
import { DB, type Db, type Tx } from '../../db/client';
import { auditLog, event, familyMember, medicalSummary, protectedPerson, subscription } from '../../db/schema';
import { EnrollmentService } from '../device/enrollment.service';
import { EventService } from '../event/event.service';
import { learningOf, loadRulePack, RULES, type RulesProvider, staticRules } from '../event/rules.loader';
import { type Actor, listContacts, replaceContacts } from './contacts';
import { GEOCODER, type Geocoder } from './geocoder';

export const FIELD_CIPHER = Symbol('FIELD_CIPHER');

export interface Address {
  line: string;
  district: string | null;
  city: string;
  postalCode: string | null;
  lat: number | null;
  lng: number | null;
}
export interface PersonView {
  id: string;
  displayName: string;
  birthYear: number | null;
  language: string;
  timezone: string;
  status: string;
  /** D-06 (T-070): bu ana kadar öğrenme modu; geçmişse null değil ama aktif değil. */
  learningModeUntil: string | null;
  address: Address | null;
  doorAccessNote: string | null;
  myRole: 'OWNER' | 'MEMBER' | null;
  /** F-DAILY günlük bildirimi açık mı (C-07). */
  dailySummary: boolean;
  /** T-061 (C-09): aile uygulaması son konumu görür mü. */
  locationSharing: boolean;
  medical: { present: boolean; consentAt: string | null; updatedAt: string | null };
  createdAt: string;
}
export const BLOOD_TYPES = ['0+', '0-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-'] as const;
export interface Medical {
  conditions: string[];
  medications: string[];
  allergies: string[];
  bloodType: (typeof BLOOD_TYPES)[number] | null;
  notes: string | null;
}
/** Olay anında operatöre: kişi + çözülmüş tıbbi özet + kapı notu (T-040, E-03/E-06). */
export interface EventPersonCard {
  displayName: string;
  age: number | null;
  address: string | null;
  location: { lat: number; lng: number } | null;
  doorAccessNote: string | null;
  medical: Medical | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONSENT_SKEW_MS = 5 * 60_000;
const ctxDoor = (id: string) => `door:${id}`;
const ctxMedical = (id: string) => `medical:${id}`;

type Row = typeof protectedPerson.$inferSelect;
type Patch = Partial<Omit<typeof protectedPerson.$inferInsert, 'id'>>;

/**
 * T-040 profil (C-02, C-03, C-04). Yetki: ADMIN hepsini; FAMILY yalnız family_member kaydı olan kişileri görür,
 * diğerleri 404 (varlığı sızdırılmaz). Kapı notu ve tıbbi özet AES-256-GCM ile şifreli; tıbbi özet aileye de geri
 * okunmaz (yalnız var/yok ve rıza zamanı), yalnız olay anında olayı yürüten operatöre çözülür (`eventCard`).
 */
@Injectable()
export class ProfileService {
  private readonly log = new Logger('Profile');

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Optional() @Inject(EnrollmentService) private readonly enrollment?: Pick<EnrollmentService, 'createInvite'>,
    @Optional() @Inject(GEOCODER) private readonly geocoder?: Geocoder | null,
    @Optional() @Inject(EventService) private readonly events?: Pick<EventService, 'requestTest'>,
    @Optional() @Inject(RULES) rules?: RulesProvider,
  ) {
    this.rules = rules ?? staticRules(loadRulePack());
  }
  private readonly rules: RulesProvider;

  // ---- kişi ----

  async create(actor: Actor, body: unknown, now = new Date()): Promise<PersonView> {
    const b = obj(body);
    const displayName = str(b.displayName, 'displayName', 100);
    if (!displayName) throw new BadRequestException('displayName gerekli');
    const patch = await this.patchOf(b, now);
    const id = uuidv7();
    const doorAccessNoteEnc = this.door(id, b.doorAccessNote);
    // D-06 (T-070): yeni kişi öğrenme modunda başlar (kural paketi `learning.days`, varsayılan 30 gün).
    const learningModeUntil = new Date(now.getTime() + learningOf(this.rules.current()).days * 86_400_000);
    await this.db.transaction(async (tx) => {
      // İnceleme bulgusu 4: abonelik yalnız aile (tüketici) kişisine açılır. Yönetici/kurum eklediği kişi abonelik
      // dışıdır (koruma her zaman açık, subscriptionProtection → null); zorla denemeye sokulup askıya düşmez.
      const consumer = actor.kind === 'FAMILY';
      await tx.insert(protectedPerson).values({
        id,
        displayName,
        ...patch,
        doorAccessNoteEnc,
        learningModeUntil,
        status: consumer ? 'TRIAL' : 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });
      if (actor.kind === 'FAMILY')
        await tx.insert(familyMember).values({
          id: uuidv7(),
          protectedPersonId: id,
          subject: actor.id!,
          role: 'OWNER',
          relation: optStr(b.relation, 'relation', 50),
        });
      if (consumer)
        await tx
          .insert(subscription)
          .values({ id: uuidv7(), protectedPersonId: id, plan: 'STANDARD', status: 'TRIAL', startedAt: now });
      await this.audit(tx, actor, 'profile.person_created', id, {
        fields: Object.keys(patch),
        doorNote: !!doorAccessNoteEnc,
      });
    });
    return this.get(actor, id);
  }

  async list(actor: Actor, limit = 50, offset = 0): Promise<{ items: PersonView[]; total: number }> {
    const where = actor.kind === 'FAMILY' ? eq(familyMember.subject, actor.id!) : undefined;
    const base = this.db
      .selectDistinct({ id: protectedPerson.id, createdAt: protectedPerson.createdAt })
      .from(protectedPerson)
      .leftJoin(familyMember, eq(familyMember.protectedPersonId, protectedPerson.id));
    const ids = await base.where(where).orderBy(asc(protectedPerson.createdAt)).limit(limit).offset(offset);
    const [{ n }] = await this.db
      .select({ n: count(sql`DISTINCT ${protectedPerson.id}`) })
      .from(protectedPerson)
      .leftJoin(familyMember, eq(familyMember.protectedPersonId, protectedPerson.id))
      .where(where);
    return { items: await Promise.all(ids.map((r) => this.get(actor, r.id))), total: Number(n) };
  }

  async get(actor: Actor, id: string): Promise<PersonView> {
    const { row, role } = await this.access(actor, id);
    const [med] = await this.db
      .select({ consentAt: medicalSummary.consentAt, updatedAt: medicalSummary.updatedAt })
      .from(medicalSummary)
      .where(eq(medicalSummary.protectedPersonId, id));
    return {
      id: row.id,
      displayName: row.displayName,
      birthYear: row.birthYear,
      language: row.language,
      timezone: row.timezone,
      status: row.status,
      learningModeUntil: row.learningModeUntil?.toISOString() ?? null,
      address: row.addressLine
        ? {
            line: row.addressLine,
            district: row.district,
            city: row.city ?? '',
            postalCode: row.postalCode,
            lat: row.lat,
            lng: row.lng,
          }
        : null,
      doorAccessNote: row.doorAccessNoteEnc ? this.cipher.decrypt(row.doorAccessNoteEnc, ctxDoor(id)) : null,
      myRole: role,
      dailySummary: row.dailySummaryEnabled,
      locationSharing: row.locationSharing,
      medical: {
        present: !!med,
        consentAt: med?.consentAt.toISOString() ?? null,
        updatedAt: med?.updatedAt.toISOString() ?? null,
      },
      createdAt: row.createdAt.toISOString(),
    };
  }

  async update(actor: Actor, id: string, body: unknown, now = new Date()): Promise<PersonView> {
    await this.access(actor, id);
    const b = obj(body);
    const patch = await this.patchOf(b, now);
    if (b.displayName !== undefined) {
      const n = str(b.displayName, 'displayName', 100);
      if (!n) throw new BadRequestException('displayName boş olamaz');
      patch.displayName = n;
    }
    if ('doorAccessNote' in b) patch.doorAccessNoteEnc = this.door(id, b.doorAccessNote);
    await this.db.transaction(async (tx) => {
      await tx
        .update(protectedPerson)
        .set({ ...patch, updatedAt: now })
        .where(eq(protectedPerson.id, id));
      await this.audit(tx, actor, 'profile.person_updated', id, { fields: Object.keys(patch) });
    });
    return this.get(actor, id);
  }

  // ---- tıbbi özet (C-03) ----

  async setMedical(actor: Actor, id: string, body: unknown, now = new Date()) {
    await this.access(actor, id);
    const b = obj(body);
    const consentAt = typeof b.consentAt === 'string' ? new Date(b.consentAt) : null;
    if (!consentAt || Number.isNaN(consentAt.getTime()) || consentAt.getTime() > now.getTime() + CONSENT_SKEW_MS)
      throw new BadRequestException('consentAt (rıza zamanı) gerekli');
    const medical: Medical = {
      conditions: list(b.conditions, 'conditions'),
      medications: list(b.medications, 'medications'),
      allergies: list(b.allergies, 'allergies'),
      bloodType: b.bloodType == null ? null : oneOf(b.bloodType, BLOOD_TYPES, 'bloodType'),
      notes: optStr(b.notes, 'notes', 1000),
    };
    const ciphertext = this.cipher.encrypt(JSON.stringify(medical), ctxMedical(id));
    const values = { ciphertext, consentAt, consentBy: actor.id ?? actor.kind, updatedAt: now };
    await this.db.transaction(async (tx) => {
      await tx
        .insert(medicalSummary)
        .values({ protectedPersonId: id, ...values })
        .onConflictDoUpdate({ target: medicalSummary.protectedPersonId, set: values });
      // İçerik yazılmaz; yalnız hangi alanların dolu olduğu.
      await this.audit(tx, actor, 'health.medical_set', id, {
        consentAt: consentAt.toISOString(),
        filled: Object.entries(medical)
          .filter(([, v]) => (Array.isArray(v) ? v.length : v))
          .map(([k]) => k),
      });
    });
    return { present: true, consentAt: consentAt.toISOString(), updatedAt: now.toISOString() };
  }

  /** Rızanın geri alınması: tıbbi özet silinir (KVKK). */
  async deleteMedical(actor: Actor, id: string) {
    await this.access(actor, id);
    await this.db.transaction(async (tx) => {
      await tx.delete(medicalSummary).where(eq(medicalSummary.protectedPersonId, id));
      await this.audit(tx, actor, 'health.medical_deleted', id, {});
    });
  }

  // ---- rehber ve davet ----

  async setContacts(actor: Actor, id: string, body: unknown) {
    // Yönetici: simülatör kişileri (uuid olmayan kimlik) için de yazabilir; aile yalnız kendi kişisine.
    if (actor.kind !== 'ADMIN') await this.access(actor, id);
    return replaceContacts(this.db, id, body, actor);
  }

  async contacts(actor: Actor, id: string) {
    if (actor.kind !== 'ADMIN') await this.access(actor, id);
    return listContacts(this.db, id);
  }

  /** C-02 davet: 6 haneli kod, 15 dk; SMS metni katalogdan (gönderim T-053). */
  async invite(actor: Actor, id: string, now = new Date()) {
    await this.access(actor, id);
    if (!this.enrollment) throw new Error('EnrollmentService yok');
    const r = await this.enrollment.createInvite(id, now);
    await this.db.insert(auditLog).values({
      actorKind: actor.kind,
      actorId: actor.id ?? null,
      action: 'profile.invite_created',
      entityType: 'protected_person',
      entityId: id,
      data: { expiresAt: r.expiresAt },
    });
    return { ...r, smsText: t('S-INVITE', 'tr', { code: r.code }) };
  }

  // ---- test çağrısı (C-05, T-063) ----

  /** Aile "Test et": TEST olayı açılır, operatör kurulum metniyle arar. Aynı anahtar aynı olayı döner. */
  async testSos(actor: Actor, id: string, key: string | undefined, now = new Date()) {
    await this.access(actor, id);
    if (!this.events) throw new Error('EventService yok');
    const requestKey = key && /^[A-Za-z0-9_.:-]{8,100}$/.test(key) ? `${actor.id ?? actor.kind}:${key}` : uuidv7();
    const r = await this.events.requestTest(id, requestKey, now);
    await this.db.insert(auditLog).values({
      actorKind: actor.kind,
      actorId: actor.id ?? null,
      action: 'profile.test_requested',
      entityType: 'event',
      entityId: r.eventId,
      data: {},
    });
    return this.testStatus(actor, id, r.eventId);
  }

  /** Aile uygulamasında ilerleme: durum, sonuç ve operatör notu (yalnız bu kişinin TEST olayları). */
  async testStatus(actor: Actor, id: string, eventId: string) {
    await this.access(actor, id);
    if (!UUID.test(eventId)) throw new NotFoundException('Test bulunamadı');
    const [e] = await this.db
      .select({
        id: event.id,
        state: event.state,
        createdAt: event.createdAt,
        closedAt: event.closedAt,
        outcome: event.confirmedOutcome,
        note: event.closeReason,
      })
      .from(event)
      .where(and(eq(event.id, eventId), eq(event.protectedPersonId, id), eq(event.isTest, true)));
    if (!e) throw new NotFoundException('Test bulunamadı');
    return {
      eventId: e.id,
      state: e.state,
      completed: e.state === 'CLOSED',
      outcome: e.outcome,
      operatorNote: e.state === 'CLOSED' && e.note ? e.note : null,
      createdAt: e.createdAt.toISOString(),
      closedAt: e.closedAt?.toISOString() ?? null,
    };
  }

  // ---- olay anı (operatör) ----

  /**
   * Olayı yürüten operatöre kişi kartı: tıbbi özet ve kapı notu yalnız burada çözülür; her çözüm denetim kaydına
   * (operatör, olay) yazılır. Kişi profili yoksa (simülatör kimliği) null.
   */
  async eventCard(
    tx: Tx,
    personId: string,
    audit: { eventId: string; operatorId: string; purpose: string },
    now: Date,
  ) {
    if (!UUID.test(personId)) return null;
    const [row] = await tx.select().from(protectedPerson).where(eq(protectedPerson.id, personId));
    if (!row) return null;
    const [med] = await tx.select().from(medicalSummary).where(eq(medicalSummary.protectedPersonId, personId));
    let medical: Medical | null = null;
    try {
      medical = med ? (JSON.parse(this.cipher.decrypt(med.ciphertext, ctxMedical(personId))) as Medical) : null;
    } catch (e) {
      this.log.error(`Tıbbi özet çözülemedi: ${safeError(e)}`); // anahtar eksik/döndürülmüş: operatör "kayıtlı değil" görür
    }
    let doorAccessNote: string | null = null;
    try {
      doorAccessNote = row.doorAccessNoteEnc ? this.cipher.decrypt(row.doorAccessNoteEnc, ctxDoor(personId)) : null;
    } catch (e) {
      this.log.error(`Kapı notu çözülemedi: ${safeError(e)}`);
    }
    await tx.insert(auditLog).values({
      actorKind: 'OPERATOR',
      actorId: audit.operatorId,
      action: 'health.medical_viewed',
      entityType: 'event',
      entityId: audit.eventId,
      data: { purpose: audit.purpose, medical: !!medical, doorNote: !!doorAccessNote },
    });
    const card: EventPersonCard = {
      displayName: row.displayName,
      age: row.birthYear ? now.getUTCFullYear() - row.birthYear : null,
      address: row.addressLine ? [row.addressLine, row.district, row.city].filter(Boolean).join(', ') : null,
      location: row.lat != null && row.lng != null ? { lat: row.lat, lng: row.lng } : null,
      doorAccessNote,
      medical,
    };
    return card;
  }

  // ---- iç ----

  /** Diğer modüller (T-070/T-071 aile uçları) için erişim denetimi: yoksa veya yetki yoksa 404. */
  async authorize(actor: Actor, id: string): Promise<void> {
    await this.access(actor, id);
  }

  /** Erişim: ADMIN her kişiyi; FAMILY yalnız üyesi olduğu kişiyi. Diğer her durum 404. */
  private async access(actor: Actor, id: string): Promise<{ row: Row; role: 'OWNER' | 'MEMBER' | null }> {
    if (!UUID.test(id)) throw new NotFoundException('Kişi bulunamadı');
    const [r] = await this.db
      .select({ row: protectedPerson, role: familyMember.role })
      .from(protectedPerson)
      .leftJoin(
        familyMember,
        and(eq(familyMember.protectedPersonId, protectedPerson.id), eq(familyMember.subject, actor.id ?? '')),
      )
      .where(eq(protectedPerson.id, id));
    if (!r || (actor.kind === 'FAMILY' && !r.role)) throw new NotFoundException('Kişi bulunamadı');
    return { row: r.row, role: (r.role as 'OWNER' | 'MEMBER' | null) ?? null };
  }

  private door(id: string, v: unknown): string | null {
    const note = optStr(v, 'doorAccessNote', 500);
    return note ? this.cipher.encrypt(note, ctxDoor(id)) : null;
  }

  /** Ortak alanlar (oluşturma ve güncelleme). Adres değişirse yeniden konumlanır. */
  private async patchOf(b: Record<string, unknown>, now: Date): Promise<Patch> {
    const p: Patch = {};
    if (b.birthYear !== undefined) {
      const y = b.birthYear;
      if (y !== null && (!Number.isInteger(y) || (y as number) < 1900 || (y as number) > now.getUTCFullYear()))
        throw new BadRequestException('birthYear geçersiz');
      p.birthYear = y as number | null;
    }
    if (b.dailySummary !== undefined) {
      if (typeof b.dailySummary !== 'boolean') throw new BadRequestException('dailySummary true/false');
      p.dailySummaryEnabled = b.dailySummary;
    }
    if (b.locationSharing !== undefined) {
      if (typeof b.locationSharing !== 'boolean') throw new BadRequestException('locationSharing true/false');
      p.locationSharing = b.locationSharing;
    }
    if (b.language !== undefined) p.language = oneOf(b.language, ['tr'] as const, 'language');
    if (b.timezone !== undefined) {
      const tz = str(b.timezone, 'timezone', 64);
      try {
        new Intl.DateTimeFormat('tr', { timeZone: tz });
      } catch {
        throw new BadRequestException('timezone geçersiz');
      }
      p.timezone = tz;
    }
    if (b.address !== undefined) {
      if (b.address === null) {
        Object.assign(p, {
          addressLine: null,
          district: null,
          city: null,
          postalCode: null,
          lat: null,
          lng: null,
          geocodedAt: null,
        });
      } else {
        const a = obj(b.address);
        const line = str(a.line, 'address.line', 200);
        const city = str(a.city, 'address.city', 60);
        if (!line || !city) throw new BadRequestException('address.line ve address.city gerekli');
        const district = optStr(a.district, 'address.district', 60);
        Object.assign(p, {
          addressLine: line,
          district,
          city,
          postalCode: optStr(a.postalCode, 'address.postalCode', 10),
        });
        const pin = coord(a.lat, a.lng);
        const geo = pin ?? (await this.geocode([line, district, city].filter(Boolean).join(', ')));
        Object.assign(p, { lat: geo?.lat ?? null, lng: geo?.lng ?? null, geocodedAt: geo && !pin ? now : null });
      }
    }
    return p;
  }

  private async geocode(address: string) {
    if (!this.geocoder) return null;
    try {
      return await this.geocoder.geocode(address, 'TR');
    } catch (e) {
      this.log.warn(`Adres konumlanamadı: ${safeError(e)}`);
      return null;
    }
  }

  private audit(tx: Tx, actor: Actor, action: string, id: string, data: Record<string, unknown>) {
    return tx.insert(auditLog).values({
      actorKind: actor.kind,
      actorId: actor.id ?? null,
      action,
      entityType: 'protected_person',
      entityId: id,
      data,
    });
  }
}

// ---- doğrulama yardımcıları ----

function obj(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new BadRequestException('Nesne bekleniyor');
  return v as Record<string, unknown>;
}
function str(v: unknown, name: string, max: number): string {
  if (typeof v !== 'string') throw new BadRequestException(`${name} metin olmalı`);
  const s = v.trim();
  if (s.length > max) throw new BadRequestException(`${name} en fazla ${max} karakter`);
  return s;
}
function optStr(v: unknown, name: string, max: number): string | null {
  if (v === undefined || v === null) return null;
  return str(v, name, max) || null;
}
function oneOf<T extends string>(v: unknown, values: readonly T[], name: string): T {
  if (!values.includes(v as T)) throw new BadRequestException(`${name} geçersiz`);
  return v as T;
}
function list(v: unknown, name: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 20) throw new BadRequestException(`${name} en fazla 20 öğe`);
  return v.map((x) => str(x, name, 200)).filter(Boolean);
}
function coord(lat: unknown, lng: unknown) {
  if (lat === undefined && lng === undefined) return null;
  if (typeof lat !== 'number' || typeof lng !== 'number' || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    throw new BadRequestException('address.lat/lng geçersiz');
  return { lat, lng };
}
