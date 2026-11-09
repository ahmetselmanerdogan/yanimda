-- 0007 · T-021 (D-03, D-04) prosedür zinciri ve operatör kilidi.
-- Olay üstlenilince zincir (chain_run) ve adımları (chain_step) aynı transaction'da oluşur; adım sonuçları sırayla
-- yazılır. Operatör kilidi olay satırında (lock_until): her operatör isteği uzatır, süresi dolunca tarama olayı
-- kuyruğa döndürür ve amir uyarısını outbox'a yazar (Redis yerine veritabanı: olay durumuyla aynı transaction).
ALTER TABLE event.event ADD COLUMN lock_until timestamptz;
CREATE INDEX event_lock_until_idx ON event.event (lock_until) WHERE lock_until IS NOT NULL;

CREATE TABLE chain.chain_run (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE REFERENCES event.event (id) ON DELETE CASCADE,
  procedure_country text NOT NULL,
  procedure_version int NOT NULL,
  rules_version int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chain.chain_step (
  run_id uuid NOT NULL REFERENCES chain.chain_run (id) ON DELETE CASCADE,
  n int NOT NULL,
  kind text NOT NULL,
  target text NOT NULL,
  contact_index int,
  label_code text NOT NULL,
  script_code text,
  timeout_sec int NOT NULL,
  required boolean NOT NULL,
  called_at timestamptz,
  result text CHECK (result IN ('REACHED', 'NO_ANSWER', 'BUSY', 'WRONG_NUMBER', 'SKIPPED')),
  assessment text CHECK (assessment IN ('OK', 'EMERGENCY')),
  note text,
  reason text,
  operator_id text,
  completed_at timestamptz,
  script_read_at timestamptz,
  PRIMARY KEY (run_id, n),
  CHECK (result IS DISTINCT FROM 'SKIPPED' OR reason IS NOT NULL)
);
