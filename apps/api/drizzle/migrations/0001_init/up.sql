-- 0001_init · infra/init.sql'in migration hâli + T-010 outbox (D-01).
-- TimescaleDB uzantısı süper kullanıcı ister; infra/init.sql kurar. Uzantı yoksa (PGlite testleri, düz Postgres)
-- signal.signal düz tablo olarak kalır.

CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS profile;
CREATE SCHEMA IF NOT EXISTS health;
CREATE SCHEMA IF NOT EXISTS device;
CREATE SCHEMA IF NOT EXISTS signal;
CREATE SCHEMA IF NOT EXISTS event;
CREATE SCHEMA IF NOT EXISTS chain;
CREATE SCHEMA IF NOT EXISTS notify;
CREATE SCHEMA IF NOT EXISTS telephony;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS report;

CREATE TABLE profile.protected_person (
  id uuid PRIMARY KEY,
  display_name text NOT NULL,
  birth_year int,
  language text NOT NULL DEFAULT 'tr',
  country_code text NOT NULL DEFAULT 'TR',
  timezone text NOT NULL DEFAULT 'Europe/Istanbul',
  status text NOT NULL DEFAULT 'TRIAL',
  learning_mode_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE device.device (
  id uuid PRIMARY KEY,
  protected_person_id uuid NOT NULL REFERENCES profile.protected_person(id),
  kind text NOT NULL,
  model text,
  last_seen_at timestamptz,
  battery_pct int,
  on_wrist boolean,
  connectivity text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Sinyal şeması deviceId/protectedPersonId için uuid zorunlu kılmaz (simülatör: pp_demo) → text.
CREATE TABLE signal.signal (
  time timestamptz NOT NULL,
  device_id text NOT NULL,
  protected_person_id text NOT NULL,
  kind text NOT NULL,
  value double precision,
  payload jsonb NOT NULL,
  idempotency_key text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
-- Hypertable tekil indeksleri zaman kolonunu içermelidir; aynı sinyalin tekrarı aynı occurredAt'i taşır.
CREATE UNIQUE INDEX signal_idem ON signal.signal (idempotency_key, time);
CREATE INDEX signal_person_time ON signal.signal (protected_person_id, time DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('signal.signal', 'time', if_not_exists => TRUE, migrate_data => TRUE);
  END IF;
END $$;

CREATE TABLE event.event (
  id uuid PRIMARY KEY,
  protected_person_id uuid NOT NULL,
  type text NOT NULL,
  priority int NOT NULL,
  state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  device_prompt_until timestamptz,
  escalated_at timestamptz,
  operator_id uuid,
  confirmed_outcome text,
  closed_at timestamptz,
  close_reason text,
  location jsonb,
  source_signal_ids text[],
  is_test boolean NOT NULL DEFAULT false
);

CREATE TABLE event.transition (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES event.event(id),
  from_state text,
  to_state text NOT NULL,
  actor_kind text NOT NULL,
  actor_id text,
  at timestamptz NOT NULL DEFAULT now(),
  note text
);

CREATE TABLE event.protection_state (
  protected_person_id uuid PRIMARY KEY,
  state text NOT NULL,
  since timestamptz NOT NULL DEFAULT now(),
  reason text
);

-- Transactional outbox (v1.0; Kafka v2.0). id sırası = teslim sırası.
CREATE TABLE event.outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic text NOT NULL,
  envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text
);
CREATE INDEX outbox_pending ON event.outbox (id) WHERE processed_at IS NULL;

CREATE TABLE event.outbox_dlq (
  id bigint PRIMARY KEY,
  topic text NOT NULL,
  envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL,
  last_error text
);
