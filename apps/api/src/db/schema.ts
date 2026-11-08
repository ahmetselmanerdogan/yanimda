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
