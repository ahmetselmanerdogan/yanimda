import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { EventState, EventType, StepAssessment, StepResult } from '@yanimda/contracts';
import { and, asc, desc, eq } from 'drizzle-orm';

import { DB, type Db } from '../../db/client';
import { chainRun, chainStep, dispatch, event, familyFeedback, familyMember } from '../../db/schema';
import type { Actor } from '../profile/contacts';
import { ProfileService } from '../profile/profile.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Aile ekranındaki aşama (C-06): olay durumunun aileye anlatılan karşılığı. Metin uygulamada `F-UI-STAGE-<stage>`.
 */
export type FamilyStage =
  | 'DETECTED'
  | 'ASKING'
  | 'CANCELLED'
  | 'QUEUED'
  | 'OPERATOR'
  | 'CALLING'
  | 'SAFE'
  | 'EMERGENCY'
  | 'DISPATCH'
  | 'FOLLOW_UP'
  | 'CLOSED';

const STAGE: Record<EventState, FamilyStage> = {
  CREATED: 'DETECTED',
  DEVICE_PROMPT: 'ASKING',
  CANCELLED_BY_USER: 'CANCELLED',
  ESCALATED: 'QUEUED',
  OPERATOR_QUEUE: 'QUEUED',
  OPERATOR_ASSIGNED: 'OPERATOR',
  CONTACT_CHAIN: 'CALLING',
  CONFIRMED_OK: 'SAFE',
  CONFIRMED_EMERGENCY: 'EMERGENCY',
  DISPATCH: 'DISPATCH',
  FOLLOW_UP: 'FOLLOW_UP',
  CLOSED: 'CLOSED',
};

/** Zincir adımı aile görünümü: kimin arandığı yalnız tür + rehber sırası; numara, ad, operatör yok. */
export interface FamilyStep {
  n: number;
  /** CALL_WATCH, CALL_PHONE, CALL_CONTACT, CALL_NEIGHBOR, CALL_112 */
  kind: string;
  contactIndex: number | null;
  status: 'PENDING' | 'CALLING' | 'DONE';
  result: StepResult | null;
  assessment: StepAssessment | null;
  at: string | null;
}

export interface FamilyEventSummary {
  id: string;
  protectedPersonId: string;
  type: EventType;
  priority: number;
  isTest: boolean;
  state: EventState;
  stage: FamilyStage;
  createdAt: string;
  closedAt: string | null;
  outcome: string | null;
}

export interface FamilyEventView extends FamilyEventSummary {
  /** Cihaz sorusu bekleniyorsa bitiş anı (kişinin "İyiyim" demesi için). */
  devicePromptUntil: string | null;
  steps: FamilyStep[];
  /** Yalnız kapanmış test olayında operatörün kapanış notu (kurulum görüşmesi, C-05). */
  operatorNote: string | null;
  /** Bu aile üyesinin "Gerçek miydi?" cevabı (C-12). */
  feedback: { real: boolean } | null;
  canFeedback: boolean;
  /** 112 süreci (varsa): aşama, aşama zamanları, hastane — vaka no, operatör ve notlar yok. */
  dispatch: { status: string; stages: Record<string, string>; hospital: string | null } | null;
}

type EventRow = typeof event.$inferSelect;

/**
 * T-061 aile uygulaması olay uçları (C-06, C-12): liste ve ayrıntı. Erişim ProfileService ile (başka ailenin kişisi
 * veya olayı 404). Kişisel veri yok: rehber numarası/adı, operatör kimliği, konum, kapanış notu (test dışı) dönmez.
 */
@Injectable()
export class FamilyService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ProfileService) private readonly profile: Pick<ProfileService, 'authorize'>,
  ) {}

  /** GET /v1/protected-persons/{id}/events — yeniden eskiye. */
  async events(actor: Actor, personId: string, limit = 20): Promise<{ items: FamilyEventSummary[] }> {
    await this.profile.authorize(actor, personId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) limit = 20;
    const rows = await this.db
      .select()
      .from(event)
      .where(eq(event.protectedPersonId, personId))
      .orderBy(desc(event.createdAt))
      .limit(limit);
    return { items: rows.map(summary) };
  }

  /** GET /v1/protected-persons/{id}/events/{eventId} */
  async event(actor: Actor, personId: string, eventId: string): Promise<FamilyEventView> {
    await this.profile.authorize(actor, personId);
    const view = UUID.test(eventId) ? await this.view(eventId, actor.kind === 'FAMILY' ? actor.id : undefined) : null;
    if (!view || view.protectedPersonId !== personId) throw new NotFoundException('Olay bulunamadı');
    return view;
  }

  /** Yetki denetimi olmadan görünüm (canlı yayın kendi denetimini yapar). */
  async view(eventId: string, subject?: string): Promise<FamilyEventView | null> {
    const [ev] = await this.db.select().from(event).where(eq(event.id, eventId));
    if (!ev) return null;
    const [run] = await this.db.select({ id: chainRun.id }).from(chainRun).where(eq(chainRun.eventId, eventId));
    const steps = run
      ? await this.db.select().from(chainStep).where(eq(chainStep.runId, run.id)).orderBy(asc(chainStep.n))
      : [];
    const [fb] = subject
      ? await this.db
          .select({ real: familyFeedback.real })
          .from(familyFeedback)
          .where(and(eq(familyFeedback.eventId, eventId), eq(familyFeedback.subject, subject)))
      : [];
    const closed = ev.state === 'CLOSED';
    const [d] = await this.db.select().from(dispatch).where(eq(dispatch.eventId, eventId));
    const stage = (k: string, v: Date | null) => (v ? [[k, v.toISOString()] as const] : []);
    const dispatchView = d
      ? {
          status: d.status,
          hospital: d.hospital,
          stages: Object.fromEntries([
            ...stage('NOTIFIED', d.notifiedAt),
            ...stage('ACCEPTED', d.acceptedAt),
            ...stage('EN_ROUTE', d.enRouteAt),
            ...stage('ON_SCENE', d.onSceneAt),
            ...stage('TRANSPORTING', d.transportingAt),
            ...stage('AT_HOSPITAL', d.atHospitalAt),
            ...stage('COMPLETED', d.completedAt),
            ...stage('CANCELLED', d.cancelledAt),
          ]),
        }
      : null;
    return {
      ...summary(ev),
      devicePromptUntil: ev.state === 'DEVICE_PROMPT' ? (ev.devicePromptUntil?.toISOString() ?? null) : null,
      steps: steps.map((s) => ({
        n: s.n,
        kind: s.kind,
        contactIndex: s.contactIndex,
        status: s.result || s.completedAt ? 'DONE' : s.calledAt ? 'CALLING' : 'PENDING',
        result: (s.result as StepResult | null) ?? null,
        assessment: (s.assessment as StepAssessment | null) ?? null,
        at: (s.completedAt ?? s.calledAt)?.toISOString() ?? null,
      })),
      operatorNote: closed && ev.isTest && ev.closeReason ? ev.closeReason : null,
      feedback: fb ? { real: fb.real } : null,
      canFeedback: closed && !ev.isTest && ev.confirmedOutcome !== 'EMERGENCY' && !!subject && !fb,
      dispatch: dispatchView,
    };
  }

  /** Aile üyesinin bağlı olduğu kişiler (canlı yayın aboneliği). */
  async personsOf(subject: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: familyMember.protectedPersonId })
      .from(familyMember)
      .where(eq(familyMember.subject, subject));
    return rows.map((r) => r.id);
  }
}

function summary(ev: EventRow): FamilyEventSummary {
  const state = ev.state as EventState;
  return {
    id: ev.id,
    protectedPersonId: ev.protectedPersonId,
    type: ev.type as EventType,
    priority: ev.priority,
    isTest: ev.isTest,
    state,
    stage: STAGE[state] ?? 'DETECTED',
    createdAt: ev.createdAt.toISOString(),
    closedAt: ev.closedAt?.toISOString() ?? null,
    outcome: ev.confirmedOutcome,
  };
}
