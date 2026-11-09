DROP TABLE IF EXISTS event.family_feedback;
DROP TABLE IF EXISTS event.false_alarm;
ALTER TABLE event.threshold DROP COLUMN IF EXISTS report_sent_at;
ALTER TABLE event.threshold DROP COLUMN IF EXISTS learned_days;
ALTER TABLE event.threshold DROP COLUMN IF EXISTS learned_at;
ALTER TABLE event.threshold DROP COLUMN IF EXISTS inactivity_source;
ALTER TABLE event.threshold DROP COLUMN IF EXISTS sleep_source;
ALTER TABLE event.threshold DROP COLUMN IF EXISTS inactivity_min;
