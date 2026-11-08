CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
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

-- 03-teknik-mimari.md "Veri modeli" ile uyumlu çekirdek tablolar (S1 kapsamı)
CREATE TABLE IF NOT EXISTS profile.protected_person (
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

CREATE TABLE IF NOT EXISTS device.device (
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

CREATE TABLE IF NOT EXISTS signal.signal (
  time timestamptz NOT NULL,
  device_id uuid NOT NULL,
  protected_person_id uuid NOT NULL,
  kind text NOT NULL,
  value double precision,
  payload jsonb,
  idempotency_key text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
SELECT create_hypertable('signal.signal', 'time', if_not_exists => TRUE);
CREATE UNIQUE INDEX IF NOT EXISTS signal_idem ON signal.signal (idempotency_key, time);

CREATE TABLE IF NOT EXISTS event.event (
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

CREATE TABLE IF NOT EXISTS event.transition (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES event.event(id),
  from_state text,
  to_state text NOT NULL,
  actor_kind text NOT NULL,
  actor_id text,
  at timestamptz NOT NULL DEFAULT now(),
  note text
);

CREATE TABLE IF NOT EXISTS event.protection_state (
  protected_person_id uuid PRIMARY KEY,
  state text NOT NULL,
  since timestamptz NOT NULL DEFAULT now(),
  reason text
);

-- demo kişi
INSERT INTO profile.protected_person (id, display_name, birth_year)
VALUES ('00000000-0000-0000-0000-000000000001', 'Ayşe K. (demo)', 1952)
ON CONFLICT DO NOTHING;
INSERT INTO device.device (id, protected_person_id, kind, model)
VALUES ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-000000000001', 'WEAROS_WATCH', 'Galaxy Watch 6')
ON CONFLICT DO NOTHING;
