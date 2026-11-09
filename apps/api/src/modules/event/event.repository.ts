import { Inject, Injectable } from '@nestjs/common';
import type { EventState, EventType, Signal } from '@yanimda/contracts';
import { and, arrayContains, asc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import { validate as isUuid } from 'uuid';

import { DB, type Db, type Tx } from '../../db/client';
import { auditLog, device, event, transition } from '../../db/schema';

export type ActorKind = 'SYSTEM' | 'USER' | 'OPERATOR';

export interface TransitionRecord {
  id: string;
  from?: EventState;
  to: EventState;
  actorKind: ActorKind;
  actorId?: string;
  at: string;
  note?: string;
}

export interface EventRecord {
  id: string;
  protectedPersonId: string;
  type: EventType;
  priority: number;
  state: EventState;
  createdAt: string;
  devicePromptUntil?: string;
  escalatedAt?: string;
  operatorId?: string;
  confirmedOutcome?: string;
  closedAt?: string;
  closeReason?: string;
  location?: Signal['location'];
  sourceSignalIds: string[];
  isTest: boolean;
  /** D-04 operatör kilidi bitişi (T-021). */
  lockUntil?: string;
  transitions: TransitionRecord[];
}

type Q = Db | Tx;
type EventRow = typeof event.$inferSelect;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : undefined);
const date = (s: string | undefined) => (s ? new Date(s) : null);

function toRecord(r: EventRow, transitions: TransitionRecord[] = []): EventRecord {
  return {
    id: r.id,
    protectedPersonId: r.protectedPersonId,
    type: r.type as EventType,
    priority: r.priority,
    state: r.state as EventState,
    createdAt: r.createdAt.toISOString(),
    devicePromptUntil: iso(r.devicePromptUntil),
    escalatedAt: iso(r.escalatedAt),
    operatorId: r.operatorId ?? undefined,
    confirmedOutcome: r.confirmedOutcome ?? undefined,
    closedAt: iso(r.closedAt),
    closeReason: r.closeReason ?? undefined,
    location: (r.location as Signal['location']) ?? undefined,
    sourceSignalIds: r.sourceSignalIds,
    isTest: r.isTest,
    lockUntil: iso(r.lockUntil),
    transitions,
  };
}

function toRow(e: EventRecord) {
  return {
    protectedPersonId: e.protectedPersonId,
    type: e.type,
    priority: e.priority,
    state: e.state,
    createdAt: new Date(e.createdAt),
    devicePromptUntil: date(e.devicePromptUntil),
    escalatedAt: date(e.escalatedAt),
    operatorId: e.operatorId ?? null,
    confirmedOutcome: e.confirmedOutcome ?? null,
    closedAt: date(e.closedAt),
    closeReason: e.closeReason ?? null,
    location: e.location ?? null,
    sourceSignalIds: e.sourceSignalIds,
    isTest: e.isTest,
    lockUntil: date(e.lockUntil),
  };
}

/** event.event / event.transition / audit.log erişimi (event modülünün kendi tabloları). */
@Injectable()
export class EventRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async transitions(q: Q, eventId: string): Promise<TransitionRecord[]> {
    const rows = await q.select().from(transition).where(eq(transition.eventId, eventId)).orderBy(asc(transition.seq));
    return rows.map((t) => ({
      id: t.id,
      from: (t.fromState as EventState) ?? undefined,
      to: t.toState as EventState,
      actorKind: t.actorKind as ActorKind,
      actorId: t.actorId ?? undefined,
      at: t.at.toISOString(),
      note: t.note ?? undefined,
    }));
  }

  /** Olayı satır kilidiyle yükler (transaction içinde). */
  async findForUpdate(tx: Tx, id: string): Promise<EventRecord | null> {
    if (!isUuid(id)) return null;
    const [r] = await tx.select().from(event).where(eq(event.id, id)).for('update');
    return r ? toRecord(r, await this.transitions(tx, id)) : null;
  }

  /** Kişinin açık olayı (state <> CLOSED), satır kilidiyle. Kişi başına en fazla bir tane (tekil indeks). */
  async findOpenForUpdate(tx: Tx, protectedPersonId: string): Promise<EventRecord | null> {
    const [r] = await tx
      .select()
      .from(event)
      .where(and(eq(event.protectedPersonId, protectedPersonId), ne(event.state, 'CLOSED')))
      .for('update');
    return r ? toRecord(r, await this.transitions(tx, r.id)) : null;
  }

  /** Bu kaynak (sinyal anahtarı / follow-up:<id>) zaten bir olaya bağlandı mı? */
  async hasSource(q: Q, sourceId: string): Promise<boolean> {
    const [r] = await q
      .select({ id: event.id })
      .from(event)
      .where(arrayContains(event.sourceSignalIds, [sourceId]))
      .limit(1);
    return !!r;
  }

  async appendSource(tx: Tx, eventId: string, sourceId: string): Promise<void> {
    await tx
      .update(event)
      .set({ sourceSignalIds: sql`array_append(${event.sourceSignalIds}, ${sourceId})` })
      .where(eq(event.id, eventId));
  }

  async insert(tx: Tx, e: EventRecord): Promise<void> {
    await tx.insert(event).values({ id: e.id, ...toRow(e) });
  }

  async update(tx: Tx, e: EventRecord): Promise<void> {
    await tx.update(event).set(toRow(e)).where(eq(event.id, e.id));
  }

  /** Geçişler + her geçiş için audit.log satırı (aynı transaction). */
  async insertTransitions(tx: Tx, eventId: string, ts: TransitionRecord[]): Promise<void> {
    if (!ts.length) return;
    await tx.insert(transition).values(
      ts.map((t) => ({
        id: t.id,
        eventId,
        fromState: t.from ?? null,
        toState: t.to,
        actorKind: t.actorKind,
        actorId: t.actorId ?? null,
        at: new Date(t.at),
        note: t.note ?? null,
      })),
    );
    await tx.insert(auditLog).values(
      ts.map((t) => ({
        at: new Date(t.at),
        actorKind: t.actorKind,
        actorId: t.actorId ?? null,
        action: 'event.transition',
        entityType: 'event',
        entityId: eventId,
        data: { from: t.from ?? null, to: t.to, note: t.note ?? null },
      })),
    );
  }

  async get(id: string, q: Q = this.db): Promise<EventRecord | null> {
    if (!isUuid(id)) return null;
    const [r] = await q.select().from(event).where(eq(event.id, id));
    return r ? toRecord(r, await this.transitions(q, id)) : null;
  }

  /** Operatör kuyruğu: öncelik → yaş (E-02). Geçişler dahil değildir. */
  async queue(): Promise<EventRecord[]> {
    const rows = await this.db
      .select()
      .from(event)
      .where(
        inArray(event.state, [
          'OPERATOR_QUEUE',
          'OPERATOR_ASSIGNED',
          'CONTACT_CHAIN',
          'CONFIRMED_OK',
          'CONFIRMED_EMERGENCY',
          'DISPATCH',
        ]),
      )
      .orderBy(asc(event.priority), asc(event.createdAt));
    return rows.map((r) => toRecord(r));
  }

  async all(): Promise<EventRecord[]> {
    const rows = await this.db.select().from(event).orderBy(asc(event.createdAt));
    return rows.map((r) => toRecord(r));
  }

  async insertAudit(
    tx: Tx,
    a: { actorKind: ActorKind; actorId?: string; action: string; entityId: string; data?: unknown },
  ): Promise<void> {
    await tx.insert(auditLog).values({
      actorKind: a.actorKind,
      actorId: a.actorId ?? null,
      action: a.action,
      entityType: 'event',
      entityId: a.entityId,
      data: a.data ?? null,
    });
  }

  /**
   * `before`'dan beri sinyal göndermeyen cihazlar (salt okuma; device modülü T-041'de servis olarak sunacak).
   */
  async silentDevices(
    before: Date,
  ): Promise<{ deviceId: string; protectedPersonId: string; lastSeenAt: Date; batteryPct: number | null }[]> {
    const r = (await this.db.execute(sql`
      SELECT d.id::text AS device_id, d.protected_person_id::text AS person_id, d.last_seen_at, d.battery_pct
      FROM ${device} d
      WHERE d.last_seen_at IS NOT NULL AND d.last_seen_at < ${before.toISOString()}::timestamptz`)) as unknown as {
      rows: { device_id: string; person_id: string; last_seen_at: Date | string; battery_pct: number | null }[];
    };
    return r.rows.map((x) => ({
      deviceId: x.device_id,
      protectedPersonId: x.person_id,
      lastSeenAt: new Date(x.last_seen_at),
      batteryPct: x.battery_pct,
    }));
  }

  /** Operatör kilidi `now`'dan önce dolmuş olaylar (T-021). */
  async expiredLockIds(now: Date): Promise<string[]> {
    const rows = await this.db.select({ id: event.id }).from(event).where(lt(event.lockUntil, now));
    return rows.map((r) => r.id);
  }

  /** Cihaz sorusu süresi `before`'dan önce dolmuş, hâlâ DEVICE_PROMPT olan olaylar. */
  async overduePromptIds(before: Date): Promise<string[]> {
    const rows = await this.db
      .select({ id: event.id })
      .from(event)
      .where(and(eq(event.state, 'DEVICE_PROMPT'), lt(event.devicePromptUntil, before)));
    return rows.map((r) => r.id);
  }
}
