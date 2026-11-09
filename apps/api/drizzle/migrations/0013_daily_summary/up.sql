-- 0013 · T-062 (C-07, B-10) günlük özet. (0011–0012 paralel dallara ayrıldı.)
CREATE TABLE signal.daily_summary (
  protected_person_id text NOT NULL,
  day date NOT NULL,
  steps int,
  hr_min int,
  hr_avg int,
  hr_max int,
  wrist_minutes int NOT NULL DEFAULT 0,
  rest_start timestamptz,
  rest_end timestamptz,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (protected_person_id, day)
);

-- Aile günlük F-DAILY bildirimini kapatabilir (C-07).
ALTER TABLE profile.protected_person ADD COLUMN daily_summary_enabled boolean NOT NULL DEFAULT true;
