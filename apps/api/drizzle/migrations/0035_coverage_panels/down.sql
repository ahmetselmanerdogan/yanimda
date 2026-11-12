ALTER TABLE profile.protected_person DROP COLUMN IF EXISTS coverage_tolerance_min;
DROP TABLE IF EXISTS event.coverage_gap;
ALTER TABLE event.coverage_state
  DROP COLUMN IF EXISTS chronic_cleared_at,
  DROP COLUMN IF EXISTS chronic_gap_since,
  DROP COLUMN IF EXISTS plan_learned_on;
ALTER TABLE event.charging_plan
  DROP COLUMN IF EXISTS learned_at,
  DROP COLUMN IF EXISTS learned_days;
