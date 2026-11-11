-- 0031 · T-087 ulaşılamama merdiveni + T-088 sinyal birleştirme (docs/07 S3.3–S3.7, S5, S8.1–S8.2).
-- (0030 T-085/T-086 kapsama ve şarj; bu migration cihaz tablosuna dokunmaz.)

-- S5.6 anahtar sahibi ayrı rol değil, yakın kaydının özelliği: anahtarı var mı, eve varma süresi, ulaşılabilir saatler
-- ("HH:MM-HH:MM", kişinin saat diliminde; gece yarısını geçebilir).
ALTER TABLE profile.contact
  ADD COLUMN has_key boolean NOT NULL DEFAULT false,
  ADD COLUMN arrival_min integer CHECK (arrival_min BETWEEN 1 AND 600),
  ADD COLUMN reachable_hours text CHECK (reachable_hours ~ '^[0-2][0-9]:[0-5][0-9]-[0-2][0-9]:[0-5][0-9]$');

-- S5.9 işitme/konuşma güçlüğü (otomatik cevap "ulaşılamadı" sayılır); S4.10 "hastanede / seyahatte" modu bitişiyle
-- (kapsama uyarıları durur, SOS ve düşme her zaman çalışır — bastırma T-085/T-086'da).
ALTER TABLE profile.protected_person
  ADD COLUMN hearing_speech_impaired boolean NOT NULL DEFAULT false,
  ADD COLUMN hold_mode text CHECK (hold_mode IN ('HOSPITAL', 'TRAVEL')),
  ADD COLUMN hold_until timestamptz,
  ADD CONSTRAINT protected_person_hold CHECK ((hold_mode IS NULL) = (hold_until IS NULL));

-- S8.2 olaya: kaynak cihazlar listesi, doğrulanma zamanı (iki farklı cihaz 90 sn içinde düşme), iptal eden cihaz.
ALTER TABLE event.event
  ADD COLUMN source_device_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN corroborated_at timestamptz,
  ADD COLUMN cancelled_by_device_id text;

-- S5.2 P1 sesli cihaz adımında otomatik cevap süresi (konsol gösterir; cihaz uygular).
ALTER TABLE chain.chain_step ADD COLUMN auto_answer_sec integer;

-- S5.1 arama sonuçları: + SILENT (otomatik cevap, ses yok → olası acil durum), + OFFLINE_SKIPPED (sistem atladı).
ALTER TABLE chain.chain_step DROP CONSTRAINT chain_step_result_check;
ALTER TABLE chain.chain_step ADD CONSTRAINT chain_step_result_check
  CHECK (result IN ('REACHED', 'NO_ANSWER', 'BUSY', 'WRONG_NUMBER', 'SKIPPED', 'SILENT', 'OFFLINE_SKIPPED'));
