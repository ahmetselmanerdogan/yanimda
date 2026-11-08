DROP TABLE IF EXISTS event.threshold;
ALTER TABLE event.protection_state DROP COLUMN IF EXISTS updated_at;
ALTER TABLE event.protection_state DROP COLUMN IF EXISTS phone_seen_at;
ALTER TABLE event.protection_state DROP COLUMN IF EXISTS watch_seen_at;
ALTER TABLE event.protection_state DROP COLUMN IF EXISTS watch_on_wrist;
ALTER TABLE event.protection_state ALTER COLUMN protected_person_id TYPE uuid USING protected_person_id::uuid;
