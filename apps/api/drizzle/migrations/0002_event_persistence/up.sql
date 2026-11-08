-- 0002 · T-011b (D-10) olay ve geçiş kalıcılığı + append-only audit.log.

-- Sinyal şeması kişi/operatör kimliği için uuid zorunlu kılmaz (simülatör: pp_demo; operatör: Keycloak sub) → text.
ALTER TABLE event.event ALTER COLUMN protected_person_id TYPE text;
ALTER TABLE event.event ALTER COLUMN operator_id TYPE text;
UPDATE event.event SET source_signal_ids = '{}' WHERE source_signal_ids IS NULL;
ALTER TABLE event.event ALTER COLUMN source_signal_ids SET DEFAULT '{}';
ALTER TABLE event.event ALTER COLUMN source_signal_ids SET NOT NULL;

-- Kişi başına tek açık olay (yarışta ikinci açık olay oluşmasın).
CREATE UNIQUE INDEX event_one_open_per_person ON event.event (protected_person_id) WHERE state <> 'CLOSED';
CREATE INDEX event_queue ON event.event (priority, created_at) WHERE state IN ('OPERATOR_QUEUE', 'OPERATOR_ASSIGNED');
CREATE INDEX event_prompt_due ON event.event (device_prompt_until) WHERE state = 'DEVICE_PROMPT';
-- Aynı sinyalin yeniden teslimi yeni olay açmasın (outbox en az bir kez teslim eder).
CREATE INDEX event_sources ON event.event USING gin (source_signal_ids);

-- Geçiş sırası (aynı milisaniyede birden çok geçiş olur).
ALTER TABLE event.transition ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
CREATE INDEX transition_event_seq ON event.transition (event_id, seq);

-- Append-only denetim kaydı. Tetikleyici süper kullanıcıya da uygulanır (izin sistemini atlayamaz);
-- üretimde API ayrıca süper kullanıcı olmayan rolle bağlanır (T-083).
CREATE TABLE audit.log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor_kind text NOT NULL,
  actor_id text,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  data jsonb
);
CREATE INDEX audit_entity ON audit.log (entity_type, entity_id, id);

CREATE FUNCTION audit.deny_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit.log yalnız eklenebilir (append-only): % reddedildi', TG_OP USING ERRCODE = '42501';
END $$;
CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON audit.log
  FOR EACH ROW EXECUTE FUNCTION audit.deny_change();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit.log
  FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_change();
REVOKE UPDATE, DELETE, TRUNCATE ON audit.log FROM PUBLIC;
