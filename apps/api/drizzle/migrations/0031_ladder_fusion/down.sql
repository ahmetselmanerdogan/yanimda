UPDATE chain.chain_step SET result = 'NO_ANSWER' WHERE result = 'SILENT';
UPDATE chain.chain_step SET result = 'SKIPPED', reason = coalesce(reason, 'offline') WHERE result = 'OFFLINE_SKIPPED';
ALTER TABLE chain.chain_step DROP CONSTRAINT chain_step_result_check;
ALTER TABLE chain.chain_step ADD CONSTRAINT chain_step_result_check
  CHECK (result IN ('REACHED', 'NO_ANSWER', 'BUSY', 'WRONG_NUMBER', 'SKIPPED'));
ALTER TABLE chain.chain_step DROP COLUMN IF EXISTS auto_answer_sec;
ALTER TABLE event.event
  DROP COLUMN IF EXISTS cancelled_by_device_id,
  DROP COLUMN IF EXISTS corroborated_at,
  DROP COLUMN IF EXISTS source_device_ids;
ALTER TABLE profile.protected_person
  DROP CONSTRAINT IF EXISTS protected_person_hold,
  DROP COLUMN IF EXISTS hold_until,
  DROP COLUMN IF EXISTS hold_mode,
  DROP COLUMN IF EXISTS hearing_speech_impaired;
ALTER TABLE profile.contact
  DROP COLUMN IF EXISTS reachable_hours,
  DROP COLUMN IF EXISTS arrival_min,
  DROP COLUMN IF EXISTS has_key;
