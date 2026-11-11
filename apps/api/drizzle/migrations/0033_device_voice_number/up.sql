-- 0033 · T-087 (docs/07 S5.2) 2. sesli cihaz adımı: her sesli cihaz kendi numarasından aranır.
-- Cihaza özel sesli arama numarası (E.164; LTE saat / sesli kolye hattı). Rehber numaraları (profile.contact) gibi
-- düz saklanır, yalnız arama anında okunur; log'a, audit'e ve telephony.call'a yazılmaz (call yalnız device_id tutar).
-- Operasyon PATCH /v1/devices/{id} voiceNumber ile ayarlar; API yalnız son iki haneyi gösterir.
ALTER TABLE device.device
  ADD COLUMN voice_number text CHECK (voice_number ~ '^\+[1-9][0-9]{6,14}$');

-- Cihaz numarasıyla yapılan aramada rehber satırı yok: aranan cihaz.
ALTER TABLE telephony.call ADD COLUMN device_id uuid;
