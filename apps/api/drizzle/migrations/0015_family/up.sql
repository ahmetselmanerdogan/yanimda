-- 0015 · T-061 (C-09) aile ayarları: düşme sorusu cevap süresi (kişiye özel, 30–90 sn; null → kural paketi) ve konum
-- paylaşımı (kapalıysa aile uygulaması konumu göremez; olay anında operatör yine görür).
ALTER TABLE event.threshold ADD COLUMN fall_prompt_sec int CHECK (fall_prompt_sec BETWEEN 30 AND 90);
ALTER TABLE profile.protected_person ADD COLUMN location_sharing boolean NOT NULL DEFAULT true;
