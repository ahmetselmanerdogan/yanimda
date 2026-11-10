import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { type KafkaEnvelope, type SupervisorAlert, TOPICS } from '@yanimda/contracts';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { bus as globalBus, type LocalBus } from '../../common/bus';
import { OutboxBus } from '../../common/outbox';
import { safeError } from '../../common/safe-error';
import { DB, type Db } from '../../db/client';
import { auditLog, supervisorAlert } from '../../db/schema';
import { claimSlaSec } from './sla';

/**
 * Kalıcı amir uyarıları (gece karar listesi 2).
 *  - Her `supervisor.alert` çekirdek şeritten `event.supervisor_alert`'e yazılır (tekrar teslim tekilleştirilir:
 *    yükteki `dedupeKey` ya da outbox zarf kimliği). Amir "gördüm" der (kim/ne zaman; audit `supervisor.alert_acked`).
 *  - Üstlenme SLA taraması (`ALERT_SWEEP_MS`, 5 sn): kuyrukta önceliğinin hedefini (P1 10 sn … P4 10 dk) aşan gerçek
 *    olay için kuyruğa her girişte bir kez `O-QUEUE-UNCLAIMED`.
 */
export interface AlertView {
  id: string;
  code: string;
  eventId: string;
  eventType: string;
  operatorId: string | null;
  at: string;
  ackedAt: string | null;
  ackedBy: string | null;
}
type Rows<T> = { rows: T[] };

@Injectable()
export class AlertsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Alerts');
  private unsub?: () => void;
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OutboxBus) private readonly outbox: OutboxBus,
  ) {}

  onModuleInit() {
    this.subscribe();
    const every = Number(process.env.ALERT_SWEEP_MS ?? 5_000);
    if (every > 0) {
      this.timer = setInterval(() => void this.sweep().catch((e) => this.log.warn(`Tarama: ${safeError(e)}`)), every);
      this.timer.unref();
    }
  }
  onModuleDestroy() {
    this.unsub?.();
    if (this.timer) clearInterval(this.timer);
  }

  /** Çekirdek şerit: uyarı kaybolmasın (yazma hatasında outbox yeniden dener). Testler için ayrı bus. */
  subscribe(bus: LocalBus = globalBus) {
    this.unsub?.();
    this.unsub = bus.subscribe<SupervisorAlert & { dedupeKey?: string }>(TOPICS.supervisorAlert, (e) => this.record(e));
  }

  async record(e: KafkaEnvelope<SupervisorAlert & { dedupeKey?: string }>): Promise<void> {
    const a = e.payload;
    await this.db
      .insert(supervisorAlert)
      .values({
        id: uuidv7(),
        dedupeKey: a.dedupeKey ?? e.eventId,
        code: a.code,
        eventId: a.eventId,
        eventType: a.eventType,
        operatorId: a.operatorId ?? null,
        at: new Date(a.at),
      })
      .onConflictDoNothing();
  }

  /** Kuyrukta önceliğinin üstlenme hedefini aşan olay → kuyruğa her girişte tek O-QUEUE-UNCLAIMED. */
  async sweep(now = new Date()): Promise<number> {
    const rows = (
      (await this.db.execute(sql`
        SELECT e.id::text AS id, e.type, e.priority, coalesce(e.escalated_at, e.created_at) AS since,
               (SELECT max(t.at) FROM event.transition t WHERE t.event_id = e.id AND t.to_state = 'OPERATOR_QUEUE') AS queued
        FROM event.event e
        WHERE e.state = 'OPERATOR_QUEUE' AND NOT e.is_test`)) as unknown as Rows<{
        id: string;
        type: string;
        priority: number;
        since: Date | string;
        queued: Date | string | null;
      }>
    ).rows;
    let n = 0;
    for (const r of rows) {
      const entered = new Date(r.queued ?? r.since);
      if (now.getTime() - entered.getTime() < claimSlaSec(r.priority) * 1000) continue;
      const dedupeKey = `unclaimed:${r.id}:${entered.toISOString()}`;
      const [seen] = await this.db
        .select({ id: supervisorAlert.id })
        .from(supervisorAlert)
        .where(eq(supervisorAlert.dedupeKey, dedupeKey));
      if (seen) continue;
      const alert = { code: 'O-QUEUE-UNCLAIMED', eventId: r.id, eventType: r.type, at: now.toISOString(), dedupeKey };
      await this.outbox.publish(TOPICS.supervisorAlert, {
        eventId: uuidv7(),
        type: TOPICS.supervisorAlert,
        version: 1,
        occurredAt: now.toISOString(),
        countryCode: 'TR',
        subjectUserId: r.id,
        payload: alert,
      } as KafkaEnvelope<unknown>);
      // Yazım çekirdek şeritten gelir; bu turda tekrar üretmemek için hemen de kaydet (aynı anahtar).
      await this.record({ eventId: dedupeKey, payload: alert } as unknown as KafkaEnvelope<
        SupervisorAlert & { dedupeKey?: string }
      >);
      n++;
    }
    if (n) this.outbox.notifyCommitted();
    return n;
  }

  async list(opts: { open?: boolean; limit?: number } = {}): Promise<AlertView[]> {
    const rows = await this.db
      .select()
      .from(supervisorAlert)
      .where(opts.open ? isNull(supervisorAlert.ackedAt) : undefined)
      .orderBy(desc(supervisorAlert.at))
      .limit(Math.min(opts.limit ?? 200, 1000));
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      eventId: r.eventId,
      eventType: r.eventType,
      operatorId: r.operatorId,
      at: r.at.toISOString(),
      ackedAt: r.ackedAt?.toISOString() ?? null,
      ackedBy: r.ackedBy,
    }));
  }

  /** "Gördüm" (amir/yönetici): kim, ne zaman; audit. Zaten görülmüşse 409. */
  async ack(id: string, by: string, now = new Date()): Promise<AlertView> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException('Uyarı yok');
    const done = await this.db.transaction(async (tx) => {
      const [r] = await tx
        .update(supervisorAlert)
        .set({ ackedAt: now, ackedBy: by })
        .where(and(eq(supervisorAlert.id, id), isNull(supervisorAlert.ackedAt)))
        .returning();
      if (!r) return null;
      await tx.insert(auditLog).values({
        actorKind: 'OPERATOR',
        actorId: by,
        action: 'supervisor.alert_acked',
        entityType: 'alert',
        entityId: id,
        data: { code: r.code, eventId: r.eventId },
      });
      return r;
    });
    if (!done) {
      const [exists] = await this.db
        .select({ id: supervisorAlert.id })
        .from(supervisorAlert)
        .where(eq(supervisorAlert.id, id));
      throw exists ? new ConflictException('Uyarı zaten görüldü') : new NotFoundException('Uyarı yok');
    }
    return (await this.list({ limit: 1000 })).find((x) => x.id === id)!;
  }
}
