-- 0011 · T-070 (D-06) öğrenme modu ve T-071 (D-07, C-12) yanlış alarm.

-- Kişiye özel eşikler (0005): hareketsizlik eşiği ve her alanın kaynağı. FAMILY = aile elle değiştirdi; öğrenme
-- işi o alana dokunmaz. DEFAULT = kural paketi varsayılanı (satır yoksa da DEFAULT).
ALTER TABLE event.threshold ADD COLUMN inactivity_min int CHECK (inactivity_min BETWEEN 1 AND 1440);
ALTER TABLE event.threshold ADD COLUMN sleep_source text NOT NULL DEFAULT 'DEFAULT'
  CHECK (sleep_source IN ('DEFAULT', 'LEARNED', 'FAMILY'));
ALTER TABLE event.threshold ADD COLUMN inactivity_source text NOT NULL DEFAULT 'DEFAULT'
  CHECK (inactivity_source IN ('DEFAULT', 'LEARNED', 'FAMILY'));
-- Son öğrenme koşusu (günlük iş) ve kaç günlük veriden öğrenildiği.
ALTER TABLE event.threshold ADD COLUMN learned_at timestamptz;
ALTER TABLE event.threshold ADD COLUMN learned_days int;
-- Öğrenme dönemi sonu "profil raporu" aileye bir kez.
ALTER TABLE event.threshold ADD COLUMN report_sent_at timestamptz;

-- Yanlış alarm kaydı: olay başına bir kez (ilk neden kalır). review_at: bu kayıt eşik görüşmesini tetikledi.
CREATE TABLE event.false_alarm (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  protected_person_id text NOT NULL,
  event_type text NOT NULL,
  cause text NOT NULL CHECK (cause IN ('USER_CANCEL', 'OPERATOR', 'FAMILY_FEEDBACK')),
  at timestamptz NOT NULL DEFAULT now(),
  review_at timestamptz
);
CREATE INDEX false_alarm_person_idx ON event.false_alarm (protected_person_id, at DESC);

-- C-12 "Gerçek miydi?": aile üyesi başına olay başına bir cevap (son cevap geçerli). Serbest metin yok.
CREATE TABLE event.family_feedback (
  event_id uuid NOT NULL,
  subject text NOT NULL,
  real boolean NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, subject)
);
