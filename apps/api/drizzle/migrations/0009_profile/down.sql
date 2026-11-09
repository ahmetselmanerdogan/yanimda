DROP TABLE IF EXISTS profile.subscription;
DROP TABLE IF EXISTS health.medical_summary;
DROP TABLE IF EXISTS profile.family_member;
ALTER TABLE profile.protected_person
  DROP COLUMN IF EXISTS door_access_note_enc,
  DROP COLUMN IF EXISTS geocoded_at,
  DROP COLUMN IF EXISTS lng,
  DROP COLUMN IF EXISTS lat,
  DROP COLUMN IF EXISTS postal_code,
  DROP COLUMN IF EXISTS city,
  DROP COLUMN IF EXISTS district,
  DROP COLUMN IF EXISTS address_line;
