-- 0005 · T-014 (D-05) koruma durumu ve kişiye özel gece penceresi.
ALTER TABLE event.protection_state ALTER COLUMN protected_person_id TYPE text;
-- Durumun hesaplandığı son bilinen olgular (sinyallerle güncellenir; tarama zamanla yeniden hesaplar).
ALTER TABLE event.protection_state ADD COLUMN watch_on_wrist boolean;
ALTER TABLE event.protection_state ADD COLUMN watch_seen_at timestamptz;
ALTER TABLE event.protection_state ADD COLUMN phone_seen_at timestamptz;
ALTER TABLE event.protection_state ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- Kişiye özel eşikler. v1.0: uyku penceresi (kişinin saat diliminde). T-070 öğrenme modu genişletir.
CREATE TABLE event.threshold (
  protected_person_id text PRIMARY KEY,
  sleep_start time NOT NULL DEFAULT '22:00',
  sleep_end time NOT NULL DEFAULT '08:00',
  updated_at timestamptz NOT NULL DEFAULT now()
);
