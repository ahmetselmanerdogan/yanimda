import { bigint, boolean, doublePrecision, integer, jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Drizzle tablo tanımları. Kaynak gerçek: drizzle/migrations/*.sql (geri alınabilir, X-05).
 * Burada yalnız sorgulanan tablolar tanımlıdır; yeni modül kendi tablosunu kendi görevinde ekler.
 */
const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const signalSchema = pgSchema('signal');
export const eventSchema = pgSchema('event');
export const deviceSchema = pgSchema('device');

export const signal = signalSchema.table('signal', {
  time: timestamptz('time').notNull(),
  deviceId: text('device_id').notNull(),
  protectedPersonId: text('protected_person_id').notNull(),
  kind: text('kind').notNull(),
  value: doublePrecision('value'),
  payload: jsonb('payload').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  receivedAt: timestamptz('received_at').notNull().defaultNow(),
});

export const outbox = eventSchema.table('outbox', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  topic: text('topic').notNull(),
  envelope: jsonb('envelope').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  processedAt: timestamptz('processed_at'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamptz('next_attempt_at').notNull().defaultNow(),
  lastError: text('last_error'),
});

export const outboxDlq = eventSchema.table('outbox_dlq', {
  id: bigint('id', { mode: 'number' }).primaryKey(),
  topic: text('topic').notNull(),
  envelope: jsonb('envelope').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  failedAt: timestamptz('failed_at').notNull().defaultNow(),
  attempts: integer('attempts').notNull(),
  lastError: text('last_error'),
});

export const device = deviceSchema.table('device', {
  id: uuid('id').primaryKey(),
  protectedPersonId: uuid('protected_person_id').notNull(),
  kind: text('kind').notNull(),
  model: text('model'),
  lastSeenAt: timestamptz('last_seen_at'),
  batteryPct: integer('battery_pct'),
  onWrist: boolean('on_wrist'),
  connectivity: text('connectivity'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

export const auditSchema = pgSchema('audit');

export const event = eventSchema.table('event', {
  id: uuid('id').primaryKey(),
  protectedPersonId: text('protected_person_id').notNull(),
  type: text('type').notNull(),
  priority: integer('priority').notNull(),
  state: text('state').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  devicePromptUntil: timestamptz('device_prompt_until'),
  escalatedAt: timestamptz('escalated_at'),
  operatorId: text('operator_id'),
  confirmedOutcome: text('confirmed_outcome'),
  closedAt: timestamptz('closed_at'),
  closeReason: text('close_reason'),
  location: jsonb('location'),
  sourceSignalIds: text('source_signal_ids').array().notNull().default([]),
  isTest: boolean('is_test').notNull().default(false),
});

export const transition = eventSchema.table('transition', {
  id: uuid('id').primaryKey(),
  eventId: uuid('event_id').notNull(),
  fromState: text('from_state'),
  toState: text('to_state').notNull(),
  actorKind: text('actor_kind').notNull(),
  actorId: text('actor_id'),
  at: timestamptz('at').notNull().defaultNow(),
  note: text('note'),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
});

export const auditLog = auditSchema.table('log', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  at: timestamptz('at').notNull().defaultNow(),
  actorKind: text('actor_kind').notNull(),
  actorId: text('actor_id'),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  data: jsonb('data'),
});
