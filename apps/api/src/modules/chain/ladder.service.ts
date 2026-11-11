import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit, Optional } from '@nestjs/common';
import {
  type EventState,
  type KafkaEnvelope,
  type NotifyRequest,
  type SupervisorAlert,
  TOPICS,
} from '@yanimda/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { bus as globalBus, type LocalBus } from '../../common/bus';
import { OutboxBus } from '../../common/outbox';
import { safeError } from '../../common/safe-error';
import { DB, type Db } from '../../db/client';
import { auditLog, event, supervisorAlert } from '../../db/schema';
import { DeviceService } from '../device/device.service';
import { deviceSummaries } from '../event/coverage.service';
import { ladderOf, loadRulePack, RULES, type RulesProvider, staticRules } from '../event/rules.loader';
import { ringTargets } from './ladder';

type Rows<T> = { rows: T[] };

/**
 * T-087 (docs/07 S5.2, S5.3) merdivenin sistem adımları — operatör beklenmeden:
 *  - T+0 (P1 kuyruğa ilk düştüğünde): çevrimiçi, şarjda olmayan, çıkarılmamış A sınıfı giyilebilirler ve yaşlının
 *    telefonu çaldırılır (yüksek öncelikli push; telefona kritik bildirim). Cihaz durumu T-085 kapsama olgularından.
 *    Aile bildirimi (F-EVT + SMS) notify modülünde zaten bu geçişte.
 *  - 90 sn üstlenilmeyen P1 → amir çağrılır (O-P1-UNCLAIMED; amir web push + konsol).
 *  - 180 sn üstlenilmeyen P1 → 1. yakına sesli mesaj (V-NO-OPERATOR) — yalnız kural paketi bayrağı açıksa
 *    (sahip kararı, varsayılan kapalı).
 * Sistem 112'yi, komşuyu veya anahtar sahibini asla aramaz, P1'i kapatmaz (S5.8).
 */
@Injectable()
export class LadderService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Ladder');
  private readonly rules: RulesProvider;
  private readonly devices: DeviceService;
  private unsub?: () => void;
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OutboxBus) private readonly outbox: OutboxBus,
    @Optional() @Inject(RULES) rules?: RulesProvider,
    @Optional() @Inject(DeviceService) devices?: DeviceService,
  ) {
    this.rules = rules ?? staticRules(loadRulePack());
    this.devices = devices ?? new DeviceService(db);
  }

  onModuleInit() {
    this.subscribe();
    const every = Number(process.env.LADDER_SWEEP_MS ?? 5_000);
    if (every > 0) {
      this.timer = setInterval(() => void this.sweep().catch((e) => this.log.warn(`Tarama: ${safeError(e)}`)), every);
      this.timer.unref();
    }
  }
  onModuleDestroy() {
    this.unsub?.();
    if (this.timer) clearInterval(this.timer);
  }

  /** Yan şerit: cihaz çaldırma olay akışını bekletmez. Testler için ayrı bus. */
  subscribe(bus: LocalBus = globalBus) {
    this.unsub?.();
    this.unsub = bus.subscribe<{ eventId: string; from?: EventState; to: EventState }>(
      TOPICS.eventTransitioned,
      (e) => this.onTransition(e.payload).then(() => undefined),
      { lane: 'side', name: 'ladder.ring' },
    );
  }

  /** P1 kuyruğa ilk kez düştü (ESCALATED → OPERATOR_QUEUE): T+0 tüm cihazları çaldır. Olay başına bir kez. */
  async onTransition(t: { eventId: string; from?: EventState; to: EventState }, now = new Date()): Promise<number> {
    if (t.to !== 'OPERATOR_QUEUE' || t.from !== 'ESCALATED') return 0;
    const [ev] = await this.db
      .select({ id: event.id, personId: event.protectedPersonId, priority: event.priority, isTest: event.isTest })
      .from(event)
      .where(eq(event.id, t.eventId));
    if (!ev || ev.priority !== 1 || ev.isTest) return 0;
    const [done] = await this.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, ev.id), eq(auditLog.action, 'ladder.ring_all')))
      .limit(1);
    if (done) return 0; // tekrar teslim
    const targets = ringTargets(await deviceSummaries(this.db, this.rules.current(), ev.personId, now));
    let rung = 0;
    for (const d of targets) {
      try {
        if (await this.devices.ring(d.id, { eventId: ev.id })) rung++;
      } catch (e) {
        this.log.warn(`Cihaz çaldırılamadı (olay=${ev.id}): ${safeError(e)}`);
      }
    }
    await this.db.insert(auditLog).values({
      actorKind: 'SYSTEM',
      action: 'ladder.ring_all',
      entityType: 'event',
      entityId: ev.id,
      data: { devices: targets.length, rung },
    });
    return rung;
  }

  /**
   * Kuyrukta bekleyen gerçek P1'ler: kuyruğa girişten `unclaimedSupervisorSec` sonra amir uyarısı (girişe bir kez),
   * bayrak açıksa `unclaimedVoiceContact.afterSec` sonra 1. yakına sesli mesaj (olaya bir kez). Yapılan iş sayısı.
   */
  async sweep(now = new Date()): Promise<number> {
    const p = ladderOf(this.rules.current());
    const rows = (
      (await this.db.execute(sql`
        SELECT e.id::text AS id, e.type, e.protected_person_id AS person,
               (SELECT max(t.at) FROM event.transition t WHERE t.event_id = e.id AND t.to_state = 'OPERATOR_QUEUE') AS queued
        FROM event.event e
        WHERE e.state = 'OPERATOR_QUEUE' AND e.priority = 1 AND NOT e.is_test`)) as unknown as Rows<{
        id: string;
        type: string;
        person: string;
        queued: Date | string | null;
      }>
    ).rows;
    let n = 0;
    for (const r of rows) {
      if (!r.queued) continue;
      const entered = new Date(r.queued);
      const waitedSec = (now.getTime() - entered.getTime()) / 1000;
      if (waitedSec >= p.unclaimedSupervisorSec && (await this.alertSupervisor(r, entered, now))) n++;
      const v = p.unclaimedVoiceContact;
      if (v.enabled && waitedSec >= v.afterSec && (await this.voiceContact(r, v.phrase, now))) n++;
    }
    if (n) this.outbox.notifyCommitted();
    return n;
  }

  private async alertSupervisor(r: { id: string; type: string }, entered: Date, now: Date): Promise<boolean> {
    const dedupeKey = `p1-unclaimed:${r.id}:${entered.toISOString()}`;
    const alert: SupervisorAlert & { dedupeKey: string } = {
      code: 'O-P1-UNCLAIMED',
      eventId: r.id,
      eventType: r.type as SupervisorAlert['eventType'],
      at: now.toISOString(),
      dedupeKey,
    };
    return this.db.transaction(async (tx) => {
      // Önce kalıcı kayıt (tekilleştirme); yalnız ilk kez yazılırsa yayınlanır.
      const ins = await tx
        .insert(supervisorAlert)
        .values({ id: uuidv7(), dedupeKey, code: alert.code, eventId: r.id, eventType: r.type, at: now })
        .onConflictDoNothing()
        .returning({ id: supervisorAlert.id });
      if (!ins.length) return false;
      await this.outbox.publish(TOPICS.supervisorAlert, this.envelope(TOPICS.supervisorAlert, r.id, alert, now), tx);
      return true;
    });
  }

  private async voiceContact(r: { id: string; person: string }, code: string, now: Date): Promise<boolean> {
    const dedupeKey = `no-operator:${r.id}`;
    return this.db.transaction(async (tx) => {
      const [seen] = await tx
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(and(eq(auditLog.entityId, r.id), eq(auditLog.action, 'ladder.no_operator_voice')))
        .limit(1);
      if (seen) return false;
      const req: NotifyRequest = { code, audience: 'FAMILY', protectedPersonId: r.person, dedupeKey, eventId: r.id };
      await this.outbox.publish(TOPICS.notifyRequested, this.envelope(TOPICS.notifyRequested, r.person, req, now), tx);
      await tx.insert(auditLog).values({
        actorKind: 'SYSTEM',
        action: 'ladder.no_operator_voice',
        entityType: 'event',
        entityId: r.id,
        data: { code },
      });
      return true;
    });
  }

  private envelope<T>(topic: string, subject: string, payload: T, now: Date): KafkaEnvelope<T> {
    return {
      eventId: uuidv7(),
      type: topic,
      version: 1,
      occurredAt: now.toISOString(),
      countryCode: this.rules.current().country,
      subjectUserId: subject,
      payload,
    };
  }
}
