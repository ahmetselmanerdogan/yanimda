-- 0012 · T-051 (E-05) konsol yazılım telefonu ve konferans.
-- provider_leg_id: aranan bacağın sağlayıcı kimliği (konferansa taşıma ve bekletme için). conference: görüşme
-- `<Conference>`'a taşındı (aile eklendi veya bekletildi). held: aranan beklemede. parties: eklenen yakın sayısı.
ALTER TABLE telephony.call
  ADD COLUMN provider_leg_id text,
  ADD COLUMN conference boolean NOT NULL DEFAULT false,
  ADD COLUMN held boolean NOT NULL DEFAULT false,
  ADD COLUMN parties int NOT NULL DEFAULT 0 CHECK (parties >= 0);
