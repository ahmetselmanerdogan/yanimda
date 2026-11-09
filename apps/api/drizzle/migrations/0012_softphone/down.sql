ALTER TABLE telephony.call
  DROP COLUMN parties,
  DROP COLUMN held,
  DROP COLUMN conference,
  DROP COLUMN provider_leg_id;
