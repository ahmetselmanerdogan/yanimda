-- 0021 · İnceleme bulgusu 4: 0009–0015 her kişiye (kurum/yönetici eklediği dahil) TRIAL abonelik açtı; 0016 bunlara
-- started_at + 30 gün deneme sonu yazdı → ilk taramada PAST_DUE, 7 gün sonra askı (cihazda koruma kapalı).
-- Kayıt akışından (T-060) gelmeyen eski abonelik: sağlayıcı yok ve KVKK rızası yok.
--  1) Aile sahibi (OWNER) olmayan kişinin (kurum/yönetici) bu aboneliği silinir: abonelik dışı → koruma açık.
--  2) Aile kişisinin bu aboneliği bu göçten itibaren 30 günlük temiz denemeye alınır (bekleme/askı temizlenir).
CREATE TEMP TABLE legacy_sub ON COMMIT DROP AS
  SELECT s.id, s.protected_person_id,
         EXISTS (SELECT 1 FROM profile.family_member f
                 WHERE f.protected_person_id = s.protected_person_id AND f.role = 'OWNER') AS consumer
  FROM profile.subscription s
  WHERE s.provider IS NULL AND s.kvkk_notice_version IS NULL AND s.status IN ('TRIAL', 'PAST_DUE');

DELETE FROM profile.subscription s USING legacy_sub l WHERE s.id = l.id AND NOT l.consumer;
UPDATE profile.protected_person p SET status = 'ACTIVE', updated_at = now()
  FROM legacy_sub l WHERE p.id = l.protected_person_id AND NOT l.consumer;

UPDATE profile.subscription s
  SET status = 'TRIAL', trial_ends_at = now() + interval '30 days', past_due_since = NULL, grace_until = NULL,
      suspended_at = NULL, updated_at = now()
  FROM legacy_sub l WHERE s.id = l.id AND l.consumer;
UPDATE profile.protected_person p SET status = 'TRIAL', updated_at = now()
  FROM legacy_sub l WHERE p.id = l.protected_person_id AND l.consumer;
