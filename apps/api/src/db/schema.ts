import {
  bigint,
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgSchema,
  text,
  time,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

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

/** T-062 günlük özet (kişinin yerel günü). */
export const dailySummary = signalSchema.table('daily_summary', {
  protectedPersonId: text('protected_person_id').notNull(),
  day: text('day').notNull(),
  steps: integer('steps'),
  hrMin: integer('hr_min'),
  hrAvg: integer('hr_avg'),
  hrMax: integer('hr_max'),
  wristMinutes: integer('wrist_minutes').notNull().default(0),
  restStart: timestamptz('rest_start'),
  restEnd: timestamptz('rest_end'),
  computedAt: timestamptz('computed_at').notNull().defaultNow(),
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
  // T-041
  enrolledAt: timestamptz('enrolled_at'),
  revokedAt: timestamptz('revoked_at'),
  osVersion: text('os_version'),
  appVersion: text('app_version'),
  pushProvider: text('push_provider'),
  pushToken: text('push_token'),
  pushSandbox: boolean('push_sandbox'),
  pushUpdatedAt: timestamptz('push_updated_at'),
});

export const profileSchema = pgSchema('profile');
export const healthSchema = pgSchema('health');

/** T-040 korunan kişi (0001 + 0009). Kapı notu şifreli (`v1:` FieldCipher). */
export const protectedPerson = profileSchema.table('protected_person', {
  id: uuid('id').primaryKey(),
  displayName: text('display_name').notNull(),
  birthYear: integer('birth_year'),
  language: text('language').notNull().default('tr'),
  countryCode: text('country_code').notNull().default('TR'),
  timezone: text('timezone').notNull().default('Europe/Istanbul'),
  status: text('status').notNull().default('TRIAL'),
  learningModeUntil: timestamptz('learning_mode_until'),
  addressLine: text('address_line'),
  district: text('district'),
  city: text('city'),
  postalCode: text('postal_code'),
  lat: doublePrecision('lat'),
  lng: doublePrecision('lng'),
  geocodedAt: timestamptz('geocoded_at'),
  doorAccessNoteEnc: text('door_access_note_enc'),
  dailySummaryEnabled: boolean('daily_summary_enabled').notNull().default(true),
  /** T-061: aile uygulaması son konumu görebilir mi. */
  locationSharing: boolean('location_sharing').notNull().default(true),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

/** T-040 aile hesabı ↔ kişi (sahiplik). `subject` = consumers realm `sub`. */
export const familyMember = profileSchema.table('family_member', {
  id: uuid('id').primaryKey(),
  protectedPersonId: uuid('protected_person_id').notNull(),
  subject: text('subject').notNull(),
  role: text('role').notNull(),
  relation: text('relation'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

/** T-040 tıbbi özet: tek şifreli JSON; rıza zamanı zorunlu. */
export const medicalSummary = healthSchema.table('medical_summary', {
  protectedPersonId: uuid('protected_person_id').primaryKey(),
  ciphertext: text('ciphertext').notNull(),
  consentAt: timestamptz('consent_at').notNull(),
  consentBy: text('consent_by').notNull(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

export const subscription = profileSchema.table('subscription', {
  id: uuid('id').primaryKey(),
  protectedPersonId: uuid('protected_person_id').notNull(),
  plan: text('plan').notNull(),
  status: text('status').notNull(),
  startedAt: timestamptz('started_at').notNull().defaultNow(),
  renewsAt: timestamptz('renews_at'),
  canceledAt: timestamptz('canceled_at'),
});

/** T-040/T-041 davet kodu: sha256(kod) saklanır; 15 dk, tek kullanım. */
export const invite = profileSchema.table('invite', {
  id: uuid('id').primaryKey(),
  protectedPersonId: uuid('protected_person_id').notNull(),
  codeHash: text('code_hash').notNull(),
  expiresAt: timestamptz('expires_at').notNull(),
  usedAt: timestamptz('used_at'),
  usedByDeviceId: uuid('used_by_device_id'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

/** T-050 aranacak numaralar (asgari; tam profil T-040). */
export const contact = profileSchema.table('contact', {
  id: uuid('id').primaryKey(),
  protectedPersonId: text('protected_person_id').notNull(),
  role: text('role').notNull(),
  priority: integer('priority').notNull().default(1),
  displayName: text('display_name'),
  phoneE164: text('phone_e164').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

export const notifySchema = pgSchema('notify');

/** T-053 aile/kişi uygulamasının push token'ı. */
export const pushTarget = notifySchema.table('push_target', {
  id: uuid('id').primaryKey(),
  subject: text('subject').notNull(),
  platform: text('platform').notNull(),
  token: text('token').notNull(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

/** T-053 bildirim (alıcı × kanal). Metin ve numara yok: kod + alıcı kimliği. */
export const notification = notifySchema.table('notification', {
  id: uuid('id').primaryKey(),
  dedupeKey: text('dedupe_key').notNull(),
  code: text('code').notNull(),
  audience: text('audience').notNull(),
  urgency: text('urgency').notNull(),
  protectedPersonId: text('protected_person_id').notNull(),
  eventId: uuid('event_id'),
  channel: text('channel').notNull(),
  recipientKind: text('recipient_kind').notNull(),
  recipientId: text('recipient_id').notNull(),
  vars: jsonb('vars'),
  status: text('status').notNull().default('queued'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamptz('next_attempt_at').notNull().defaultNow(),
  leaseUntil: timestamptz('lease_until'),
  fallbackAt: timestamptz('fallback_at'),
  fallbackDone: boolean('fallback_done').notNull().default(false),
  fallbackOf: uuid('fallback_of'),
  providerId: text('provider_id'),
  error: text('error'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  sentAt: timestamptz('sent_at'),
  deliveredAt: timestamptz('delivered_at'),
});

export const telephonySchema = pgSchema('telephony');

/** T-050 CPaaS araması. Numara tutulmaz (contact_id). */
export const call = telephonySchema.table('call', {
  id: uuid('id').primaryKey(),
  eventId: uuid('event_id').notNull(),
  stepN: integer('step_n').notNull(),
  operatorId: text('operator_id').notNull(),
  contactId: uuid('contact_id'),
  provider: text('provider').notNull(),
  providerCallId: text('provider_call_id'),
  status: text('status').notNull().default('queued'),
  answered: boolean('answered').notNull().default(false),
  suggestedResult: text('suggested_result'),
  durationSec: integer('duration_sec'),
  recordingRef: text('recording_ref'),
  recordingProviderId: text('recording_provider_id'),
  /** T-051: aranan bacak (konferans ve bekletme). */
  providerLegId: text('provider_leg_id'),
  conference: boolean('conference').notNull().default(false),
  held: boolean('held').notNull().default(false),
  parties: integer('parties').notNull().default(0),
  error: text('error'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

/** T-072 (D-12) otomatik sesli ön eleme: olay başına bir arama. Numara ve konuşma dökümü tutulmaz. */
export const voiceScreening = eventSchema.table('voice_screening', {
  id: uuid('id').primaryKey(),
  eventId: uuid('event_id').notNull(),
  protectedPersonId: text('protected_person_id').notNull(),
  eventType: text('event_type').notNull(),
  contactId: uuid('contact_id'),
  provider: text('provider').notNull(),
  providerCallId: text('provider_call_id'),
  config: jsonb('config').notNull(),
  status: text('status').notNull().default('PENDING'),
  reason: text('reason'),
  input: text('input'),
  matched: text('matched'),
  confidence: doublePrecision('confidence'),
  callStatus: text('call_status'),
  sampled: boolean('sampled').notNull().default(false),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  finishedAt: timestamptz('finished_at'),
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
  lockUntil: timestamptz('lock_until'),
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

export const chainSchema = pgSchema('chain');

export const procedureTemplate = chainSchema.table('procedure_template', {
  country: text('country').notNull(),
  version: integer('version').notNull(),
  checksum: text('checksum').notNull(),
  content: jsonb('content').notNull(),
  loadedAt: timestamptz('loaded_at').notNull().defaultNow(),
  loadedBy: text('loaded_by'),
});

/** T-021 zincir: olay başına bir koşu, adımlar sırayla. */
export const chainRun = chainSchema.table('chain_run', {
  id: uuid('id').primaryKey(),
  eventId: uuid('event_id').notNull(),
  procedureCountry: text('procedure_country').notNull(),
  procedureVersion: integer('procedure_version').notNull(),
  rulesVersion: integer('rules_version').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

export const chainStep = chainSchema.table('chain_step', {
  runId: uuid('run_id').notNull(),
  n: integer('n').notNull(),
  kind: text('kind').notNull(),
  target: text('target').notNull(),
  contactIndex: integer('contact_index'),
  labelCode: text('label_code').notNull(),
  scriptCode: text('script_code'),
  timeoutSec: integer('timeout_sec').notNull(),
  required: boolean('required').notNull(),
  calledAt: timestamptz('called_at'),
  result: text('result'),
  assessment: text('assessment'),
  note: text('note'),
  reason: text('reason'),
  operatorId: text('operator_id'),
  completedAt: timestamptz('completed_at'),
  scriptReadAt: timestamptz('script_read_at'),
});

export const protectionState = eventSchema.table('protection_state', {
  protectedPersonId: text('protected_person_id').primaryKey(),
  state: text('state').notNull(),
  since: timestamptz('since').notNull().defaultNow(),
  reason: text('reason'),
  watchOnWrist: boolean('watch_on_wrist'),
  watchSeenAt: timestamptz('watch_seen_at'),
  phoneSeenAt: timestamptz('phone_seen_at'),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

/** T-014 kişiye özel eşikler (0005) + T-070 öğrenme (0011). Saatler kişinin saat diliminde. */
export const threshold = eventSchema.table('threshold', {
  protectedPersonId: text('protected_person_id').primaryKey(),
  sleepStart: time('sleep_start').notNull().default('22:00'),
  sleepEnd: time('sleep_end').notNull().default('08:00'),
  inactivityMin: integer('inactivity_min'),
  /** T-061: düşme sorusu cevap süresi (sn, 30–90); null → kural paketi. */
  fallPromptSec: integer('fall_prompt_sec'),
  sleepSource: text('sleep_source').notNull().default('DEFAULT'),
  inactivitySource: text('inactivity_source').notNull().default('DEFAULT'),
  learnedAt: timestamptz('learned_at'),
  learnedDays: integer('learned_days'),
  reportSentAt: timestamptz('report_sent_at'),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

/** T-071 yanlış alarm (olay başına bir kayıt). */
export const falseAlarm = eventSchema.table('false_alarm', {
  id: uuid('id').primaryKey(),
  eventId: uuid('event_id').notNull(),
  protectedPersonId: text('protected_person_id').notNull(),
  eventType: text('event_type').notNull(),
  cause: text('cause').notNull(),
  at: timestamptz('at').notNull().defaultNow(),
  reviewAt: timestamptz('review_at'),
});

/** T-071 C-12 aile geri bildirimi. */
export const familyFeedback = eventSchema.table('family_feedback', {
  eventId: uuid('event_id').notNull(),
  subject: text('subject').notNull(),
  real: boolean('real').notNull(),
  at: timestamptz('at').notNull().defaultNow(),
});

/** T-074 (E-11) operatör durumu ve son görülme (WS bağlantısı). */
export const identitySchema = pgSchema('identity');
export const operator = identitySchema.table('operator', {
  subject: text('subject').primaryKey(),
  displayName: text('display_name'),
  kind: text('kind').notNull().default('OPERATOR'),
  status: text('status').notNull().default('AVAILABLE'),
  statusAt: timestamptz('status_at').notNull().defaultNow(),
  statusBy: text('status_by'),
  lastSeenAt: timestamptz('last_seen_at'),
});

/** T-074 amir bayrakları (ör. `overflow`: yedek merkeze taşma; v2.0'da gerçek yönlendirme). */
export const supervisorFlag = eventSchema.table('supervisor_flag', {
  key: text('key').primaryKey(),
  enabled: boolean('enabled').notNull(),
  changedAt: timestamptz('changed_at').notNull().defaultNow(),
  changedBy: text('changed_by'),
});
