-- 0002 geri alma. Not: kişi/operatör kimlikleri uuid olmayan satırlar varsa tip dönüşümü hata verir
-- (veri kaybını önlemek için bilerek; önce bu satırlar temizlenmelidir).
DROP TABLE IF EXISTS audit.log;
DROP FUNCTION IF EXISTS audit.deny_change();
DROP INDEX IF EXISTS event.transition_event_seq;
ALTER TABLE event.transition DROP COLUMN IF EXISTS seq;
DROP INDEX IF EXISTS event.event_sources;
DROP INDEX IF EXISTS event.event_prompt_due;
DROP INDEX IF EXISTS event.event_queue;
DROP INDEX IF EXISTS event.event_one_open_per_person;
ALTER TABLE event.event ALTER COLUMN source_signal_ids DROP NOT NULL;
ALTER TABLE event.event ALTER COLUMN source_signal_ids DROP DEFAULT;
ALTER TABLE event.event ALTER COLUMN operator_id TYPE uuid USING operator_id::uuid;
ALTER TABLE event.event ALTER COLUMN protected_person_id TYPE uuid USING protected_person_id::uuid;
