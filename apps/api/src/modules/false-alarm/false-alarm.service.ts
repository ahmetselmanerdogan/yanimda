import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { type EventType, type FalseAlarm, type KafkaEnvelope, type NotifyRequest, TOPICS } from '@yanimda/contracts';
import { eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { bus as globalBus, type LocalBus } from '../../common/bus';
import { OutboxBus } from '../../common/outbox';
import { DB, type Db, type Tx } from '../../db/client';
import { auditLog, event, falseAlarm, familyFeedback } from '../../db/schema';
import { EventService } from '../event/event.service';
import { falseAlarmOf, loadRulePack, RULES, type RulesProvider, staticRules } from '../event/rules.loader';
import type { Actor } from '../profile/contacts';
import { ProfileService } from '../profile/profile.service';
import { type FalseAlarmStats, falseAlarmStats } from './stats';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Rows<T> = { rows: T[] };

export interface FeedbackResult {
  eventId: string;
  real: boolean;
  /** Olay yanlış alarm sayılıyor mu (bu geri bildirimle veya önceden). */
  falseAlarm: boolean;
}

/**
 * T-071 (D-07, C-12) yanlış alarm yönetimi.
 *  - `event.false_alarm` (outbox): EventService FALSE_ALARM kapanışında (USER_CANCEL / OPERATOR) aynı transaction'da
 *    yayınlar; aile "gerçek değildi" dediğinde (FAMILY_FEEDBACK) bu servis yayınlar. Tüketici olay başına bir kayıt
 *    yazar (ilk neden kalır).
 *  - Kişi bazlı `falseAlarm.windowDays` (30) günde `reviewAfter`. (3.) kayıtta, pencerede başka görüşme yoksa: aileye
 *    F-EVT-OK + F-FA-REVIEW (eşik önerisi) ve konsolda "eşik görüşmesi" CALLBACK olayı (P4).
 *  - Oran: kişi ucu ve amir panosu (stats.ts).
 * Test olayları sayılmaz. Log'da yalnız kimlikler.
 */
@Injectable()
export class FalseAlarmService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('FalseAlarm');
  private readonly rules: RulesProvider;
  private unsub?: () => void;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OutboxBus) private readonly outbox: OutboxBus,
    @Inject(EventService) private readonly events: Pick<EventService, 'raiseCallback'>,
    @Optional() @Inject(ProfileService) private readonly profile?: Pick<ProfileService, 'authorize'>,
    @Optional() @Inject(RULES) rules?: RulesProvider,
  ) {
    this.rules = rules ?? staticRules(loadRulePack());
  }

  onModuleInit() {
    this.subscribe();
  }

  onModuleDestroy() {
    this.unsub?.();
  }

  /** Testler için ayrı bus. */
  subscribe(bus: LocalBus = globalBus) {
    this.unsub?.();
    this.unsub = bus.subscribe<FalseAlarm>(TOPICS.eventFalseAlarm, (e) => this.record(e.payload).then(() => undefined));
  }

  /**
   * Kaydı yazar ve eşik görüşmesine karar verir (idempotent: outbox tekrar teslim edebilir). Görüşme kararı kayıtla
   * aynı transaction'da işaretlenir ve aile bildirimleri outbox'a yazılır; CALLBACK olayı commit'ten sonra
   * kaynak kimliğiyle (tekrarda aynı olay) açılır.
   */
  async record(fa: FalseAlarm, now = new Date()): Promise<{ recorded: boolean; review: boolean }> {
    const { windowDays, reviewAfter } = falseAlarmOf(this.rules.current());
    const since = new Date(now.getTime() - windowDays * 86_400_000);
    const result = await this.db.transaction(async (tx) => {
      // Aynı kişinin eş zamanlı kayıtları sıraya girsin (iki görüşme açılmasın).
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`false-alarm:${fa.protectedPersonId}`}))`);
      const inserted = await tx
        .insert(falseAlarm)
        .values({
          id: uuidv7(),
          eventId: fa.eventId,
          protectedPersonId: fa.protectedPersonId,
          eventType: fa.eventType,
          cause: fa.cause,
          at: new Date(fa.at),
        })
        .onConflictDoNothing({ target: falseAlarm.eventId })
        .returning({ id: falseAlarm.id });
      const [row] = await tx
        .select({ reviewAt: falseAlarm.reviewAt })
        .from(falseAlarm)
        .where(eq(falseAlarm.eventId, fa.eventId));
      const [c] = (
        (await tx.execute(sql`
          SELECT count(*)::int AS n,
                 count(*) FILTER (WHERE review_at IS NOT NULL AND event_id <> ${fa.eventId}::uuid)::int AS reviews
          FROM event.false_alarm
          WHERE protected_person_id = ${fa.protectedPersonId} AND at > ${since}`)) as unknown as Rows<{
          n: number;
          reviews: number;
        }>
      ).rows;
      const review = !!row?.reviewAt || (inserted.length > 0 && c!.n >= reviewAfter && c!.reviews === 0);
      if (review) {
        if (!row?.reviewAt)
          await tx.update(falseAlarm).set({ reviewAt: now }).where(eq(falseAlarm.eventId, fa.eventId));
        await this.notify(tx, fa, 'F-EVT-OK', `event:${fa.eventId}:F-EVT-OK`); // olay bildirimiyle aynı anahtar
        await this.notify(tx, fa, 'F-FA-REVIEW', `false-alarm-review:${fa.eventId}`, {
          count: c!.n,
          windowDays,
        });
      }
      return { recorded: inserted.length > 0, review, count: c!.n };
    });
    if (result.review) {
      await this.events.raiseCallback(
        fa.protectedPersonId,
        `false-alarm-review:${fa.eventId}`,
        `eşik görüşmesi: ${windowDays} günde ${result.count} yanlış alarm`,
      );
      this.log.log(`Eşik görüşmesi açıldı (kişi=${fa.protectedPersonId})`);
    }
    return { recorded: result.recorded, review: result.review };
  }

  /** C-12 POST /v1/events/{id}/feedback — aile "Gerçek miydi?" cevabı ({ real }). Yalnız kapanmış olay. */
  async feedback(actor: Actor, eventId: string, body: unknown, now = new Date()): Promise<FeedbackResult> {
    if (actor.kind !== 'FAMILY' || !actor.id) throw new ForbiddenException('Yalnız aile üyesi geri bildirim verir');
    const real = (body as { real?: unknown } | null)?.real;
    if (typeof real !== 'boolean') throw new BadRequestException('real (true/false) gerekli');
    if (!UUID.test(eventId)) throw new NotFoundException('Olay yok');
    const [ev] = await this.db
      .select({
        id: event.id,
        protectedPersonId: event.protectedPersonId,
        type: event.type,
        state: event.state,
        isTest: event.isTest,
      })
      .from(event)
      .where(eq(event.id, eventId));
    if (!ev) throw new NotFoundException('Olay yok');
    await this.authorize(actor, ev.protectedPersonId); // başka ailenin olayı: 404
    if (ev.state !== 'CLOSED') throw new ConflictException('Olay henüz kapanmadı');
    await this.db.transaction(async (tx) => {
      await tx
        .insert(familyFeedback)
        .values({ eventId, subject: actor.id!, real, at: now })
        .onConflictDoUpdate({ target: [familyFeedback.eventId, familyFeedback.subject], set: { real, at: now } });
      await tx.insert(auditLog).values({
        actorKind: 'FAMILY',
        actorId: actor.id!,
        action: 'event.family_feedback',
        entityType: 'event',
        entityId: eventId,
        data: { real },
      });
      if (!real && !ev.isTest) {
        const fa: FalseAlarm = {
          protectedPersonId: ev.protectedPersonId,
          eventId,
          eventType: ev.type as EventType,
          cause: 'FAMILY_FEEDBACK',
          at: now.toISOString(),
        };
        await this.outbox.publish(TOPICS.eventFalseAlarm, this.envelope(TOPICS.eventFalseAlarm, fa, now), tx);
      }
    });
    const [existing] = await this.db
      .select({ cause: falseAlarm.cause })
      .from(falseAlarm)
      .where(eq(falseAlarm.eventId, eventId));
    return { eventId, real, falseAlarm: !!existing || (!real && !ev.isTest) };
  }

  /** GET /v1/protected-persons/{id}/false-alarms — kişinin pencere (30 gün) oranı. */
  async personStats(
    actor: Actor,
    id: string,
    now = new Date(),
  ): Promise<FalseAlarmStats & { protectedPersonId: string }> {
    await this.authorize(actor, id);
    const { windowDays, reviewAfter } = falseAlarmOf(this.rules.current());
    return { protectedPersonId: id, ...(await falseAlarmStats(this.db, now, windowDays, reviewAfter, id)) };
  }

  // ---- iç ----

  private async authorize(actor: Actor, personId: string) {
    if (!this.profile) throw new Error('ProfileService yok');
    await this.profile.authorize(actor, personId);
  }

  private async notify(tx: Tx, fa: FalseAlarm, code: string, dedupeKey: string, vars?: NotifyRequest['vars']) {
    const payload: NotifyRequest = {
      code,
      audience: 'FAMILY',
      protectedPersonId: fa.protectedPersonId,
      dedupeKey,
      eventId: fa.eventId,
      ...(vars ? { vars } : {}),
    };
    await this.outbox.publish(TOPICS.notifyRequested, this.envelope(TOPICS.notifyRequested, payload), tx);
  }

  private envelope<T extends { protectedPersonId: string }>(
    topic: string,
    payload: T,
    at = new Date(),
  ): KafkaEnvelope<T> {
    return {
      eventId: uuidv7(),
      type: topic,
      version: 1,
      occurredAt: at.toISOString(),
      countryCode: this.rules.current().country,
      subjectUserId: payload.protectedPersonId,
      payload,
    };
  }
}
