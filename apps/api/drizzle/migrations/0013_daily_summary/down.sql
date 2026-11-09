ALTER TABLE profile.protected_person DROP COLUMN IF EXISTS daily_summary_enabled;
DROP TABLE IF EXISTS signal.daily_summary;
