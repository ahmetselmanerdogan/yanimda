import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { DataExport, DataExportPerson, DataExportWithheld } from '@yanimda/contracts';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';

import { DB, type Db } from '../../db/client';
import {
  auditLog,
  dailySummary,
  device,
  event,
  familyFeedback,
  familyMember,
  medicalSummary,
  memberInvite,
  notification,
  pushTarget,
  subscription,
  vendorLink,
} from '../../db/schema';
import type { Actor } from '../profile/contacts';
import { ProfileService } from '../profile/profile.service';

/** Olay ve bildirim listelerinin üst sınırı (en yeni önce). Saklama süresiyle birlikte dosyayı sınırlı tutar. */
export const EXPORT_LIST_MAX = 1000;

const WITHHELD: DataExportWithheld[] = [
  'MEDICAL_CONTENT',
  'CONTACT_PHONE_FULL',
  'HEALTH_VITALS',
  'CALL_RECORDINGS',
  'AUDIT_LOG',
  'OPERATOR_DATA',
  'LOCATION_HISTORY',
];

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

/**
 * T-081 ASVS 8.3.2 / KVKK m.11 erişim hakkı: aile hesabının (consumers FAMILY) kendi verisi ve üyesi olduğu korunan
 * kişilerin verisi, tek JSON. İlke: dışa aktarma yeni bir okuma yetkisi açmaz; her kişi bölümü, aynı hesabın mevcut
 * aile uçlarından (profil, üyeler, rehber, cihazlar, olaylar, günlük özet, abonelik) zaten okuyabildiğinin toplamıdır.
 * Bu yüzden tıbbi özet içeriği verilmez (CLAUDE.md: sağlık verisi yalnız olay anında, olayı yürüten operatöre
 * çözülür; aile ucu da yalnız var/yok + rıza zamanı döner), rehberde numaranın son 2 hanesi, olayda konum / operatör /
 * not yoktur. Bilerek verilmeyenler `withheld` kodlarıyla listelenir (docs/security/saklama.md "Dışa aktarma").
 * Her indirme audit.log'a yazılır: yalnız hesap ve kişi kimlikleri + sayılar.
 */
@Injectable()
export class DataExportService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ProfileService) private readonly profile: ProfileService,
  ) {}

  async export(actor: Actor, now = new Date()): Promise<DataExport> {
    // Yönetici "kendi verisi" yoktur; başkası adına KVKK başvurusu operasyon sürecindedir (saklama.md).
    if (actor.kind !== 'FAMILY' || !actor.id) throw new ForbiddenException('Yalnız aile hesabı');
    const subject = actor.id;

    const memberships = await this.db
      .select()
      .from(familyMember)
      .where(eq(familyMember.subject, subject))
      .orderBy(asc(familyMember.createdAt));
    const persons: DataExportPerson[] = [];
    for (const m of memberships) persons.push(await this.person(actor, m.protectedPersonId));

    const targets = await this.db
      .select({ id: pushTarget.id, platform: pushTarget.platform, updatedAt: pushTarget.updatedAt })
      .from(pushTarget)
      .where(eq(pushTarget.subject, subject));
    const notifications = targets.length
      ? await this.db
          .select()
          .from(notification)
          .where(
            and(
              eq(notification.recipientKind, 'PUSH_TARGET'),
              inArray(
                notification.recipientId,
                targets.map((t) => t.id),
              ),
            ),
          )
          .orderBy(desc(notification.createdAt))
          .limit(EXPORT_LIST_MAX)
      : [];
    const invites = await this.db
      .select()
      .from(memberInvite)
      .where(eq(memberInvite.createdBy, subject))
      .orderBy(asc(memberInvite.createdAt));
    const feedback = await this.db
      .select()
      .from(familyFeedback)
      .where(eq(familyFeedback.subject, subject))
      .orderBy(asc(familyFeedback.at));

    const out: DataExport = {
      format: 'yanimda.data-export.v1',
      generatedAt: now.toISOString(),
      account: {
        subject,
        memberships: memberships.map((m) => ({
          protectedPersonId: m.protectedPersonId,
          role: m.role as 'OWNER' | 'MEMBER',
          relation: m.relation,
          since: m.createdAt.toISOString(),
        })),
        pushTargets: targets.map((t) => ({ platform: t.platform, updatedAt: t.updatedAt.toISOString() })),
        memberInvitesCreated: invites.map((i) => ({
          protectedPersonId: i.protectedPersonId,
          createdAt: i.createdAt.toISOString(),
          expiresAt: i.expiresAt.toISOString(),
          usedAt: iso(i.usedAt),
        })),
        feedback: feedback.map((f) => ({ eventId: f.eventId, real: f.real, at: f.at.toISOString() })),
        notifications: notifications.map((n) => ({
          code: n.code,
          channel: n.channel,
          status: n.status,
          protectedPersonId: n.protectedPersonId,
          eventId: n.eventId,
          createdAt: n.createdAt.toISOString(),
          deliveredAt: iso(n.deliveredAt),
        })),
      },
      persons,
      withheld: WITHHELD,
    };

    await this.db.insert(auditLog).values({
      actorKind: actor.kind,
      actorId: subject,
      action: 'privacy.data_exported',
      entityType: 'family_account',
      entityId: subject,
      data: {
        persons: persons.map((p) => p.profile.id),
        counts: {
          events: persons.reduce((a, p) => a + p.events.length, 0),
          devices: persons.reduce((a, p) => a + p.devices.length, 0),
          contacts: persons.reduce((a, p) => a + p.contacts.length, 0),
          notifications: out.account.notifications.length,
        },
      },
    });
    return out;
  }

  /** Erişim denetimi ProfileService'te (FAMILY yalnız üyesi olduğu kişi; değilse 404). */
  private async person(actor: Actor, id: string): Promise<DataExportPerson> {
    const profile = await this.profile.get(actor, id);
    const members = await this.profile.members(actor, id);
    const contacts = await this.profile.contacts(actor, id);
    const devices = await this.db
      .select()
      .from(device)
      .where(eq(device.protectedPersonId, id))
      .orderBy(asc(device.createdAt));
    const events = await this.db
      .select()
      .from(event)
      .where(eq(event.protectedPersonId, id))
      .orderBy(desc(event.createdAt))
      .limit(EXPORT_LIST_MAX);
    const days = await this.db
      .select()
      .from(dailySummary)
      .where(eq(dailySummary.protectedPersonId, id))
      .orderBy(asc(dailySummary.day));
    const subs = await this.db
      .select()
      .from(subscription)
      .where(eq(subscription.protectedPersonId, id))
      .orderBy(asc(subscription.startedAt));
    const [med] = await this.db
      .select({ consentAt: medicalSummary.consentAt })
      .from(medicalSummary)
      .where(eq(medicalSummary.protectedPersonId, id));
    const links = await this.db
      .select()
      .from(vendorLink)
      .where(eq(vendorLink.protectedPersonId, id))
      .orderBy(asc(vendorLink.createdAt));

    return {
      profile,
      members: members.items,
      contacts,
      devices: devices.map((d) => ({
        id: d.id,
        kind: d.kind,
        modelId: d.modelId,
        category: d.category,
        tier: d.tier,
        nickname: d.nickname,
        bodyLocation: d.bodyLocation,
        osVersion: d.osVersion,
        appVersion: d.appVersion,
        enrolledAt: iso(d.enrolledAt),
        lastSeenAt: iso(d.lastSeenAt),
        revokedAt: iso(d.revokedAt),
        retiredAt: iso(d.retiredAt),
      })),
      events: events.map((e) => ({
        id: e.id,
        type: e.type,
        priority: e.priority,
        isTest: e.isTest,
        state: e.state,
        createdAt: e.createdAt.toISOString(),
        closedAt: iso(e.closedAt),
        outcome: e.confirmedOutcome,
      })),
      dailySummaries: days.map((s) => ({
        day: String(s.day).slice(0, 10),
        steps: s.steps,
        hrMin: s.hrMin,
        hrAvg: s.hrAvg,
        hrMax: s.hrMax,
        wristMinutes: s.wristMinutes,
      })),
      subscriptions: subs.map((s) => ({
        plan: s.plan,
        status: s.status,
        countryCode: s.countryCode,
        startedAt: s.startedAt.toISOString(),
        trialEndsAt: iso(s.trialEndsAt),
        renewsAt: iso(s.renewsAt),
        canceledAt: iso(s.canceledAt),
      })),
      consents: {
        kvkk: subs.map((s) => ({ noticeVersion: s.kvkkNoticeVersion, explicitConsentAt: iso(s.explicitConsentAt) })),
        medicalConsentAt: iso(med?.consentAt),
        vendorLinks: links.map((l) => ({
          partner: l.partner,
          dataRegion: l.dataRegion,
          consentBasis: l.consentBasis,
          consentAt: iso(l.consentAt),
          createdAt: l.createdAt.toISOString(),
          revokedAt: iso(l.revokedAt),
        })),
      },
    };
  }
}
