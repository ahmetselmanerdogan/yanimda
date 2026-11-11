-- 0030 · T-085 / T-086 (docs/07 S1, S3, S4, S8.1): çoklu cihaz modeli, kapsama durumu, şarj.
-- "Birincil cihaz" yoktur: her cihaz kategori, sınıf (A/B/C), vücut konumu ve katalogdaki yetenek profiliyle kayıtlıdır.
-- Kişinin korunup korunmadığını cihazların toplamından hesaplanan kapsama durumu söyler; protection_state bir sürüm
-- boyunca kapsamadan türetilerek yazılmaya devam eder (eski istemciler için).

-- Cihaz modeli kataloğu: yetenekler (gecikme + kalite sınıfıyla), pil ömrü, şarj süresi. OEM entegrasyonu yok; yalnız
-- bugünkü türlerimiz. Yetenek model × entegrasyon yoluna aittir (S1.5); kimlik bugün cihaz türüyle aynıdır.
CREATE TABLE device.device_model (
  id text PRIMARY KEY,
  vendor text NOT NULL,
  model text NOT NULL,
  category text NOT NULL
    CHECK (category IN ('WATCH', 'PHONE', 'PENDANT', 'RING', 'EARBUD', 'EARRING', 'HOME_UNIT', 'CLOUD')),
  tier text NOT NULL CHECK (tier IN ('A', 'B', 'C')),
  -- { sos, fall, voice, location: { available, latency: INSTANT|NEAR|BATCH|DAILY, quality: Q1|Q2|Q3 } … }
  capabilities jsonb NOT NULL,
  battery_life_h int,
  charge_time_min int,
  certified_sw text,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO device.device_model (id, vendor, model, category, tier, capabilities, battery_life_h, charge_time_min)
VALUES
  ('WEAROS_WATCH', 'Yanımda', 'Wear OS saat uygulaması', 'WATCH', 'A',
   '{"sos": {"available": true, "latency": "INSTANT"}, "fall": {"available": true, "latency": "INSTANT"},
     "voice": {"available": true}, "location": {"available": true, "latency": "NEAR"},
     "onBody": {"available": true}, "charging": {"available": true},
     "heartRate": {"available": true, "latency": "NEAR", "quality": "Q2"}, "steps": {"available": true}}',
   40, 90),
  ('ANDROID_PHONE', 'Yanımda', 'Android eşlikçi uygulama', 'PHONE', 'A',
   '{"sos": {"available": true, "latency": "INSTANT"}, "fall": {"available": false},
     "voice": {"available": true}, "location": {"available": true, "latency": "NEAR"},
     "onBody": {"available": false}, "charging": {"available": true}, "steps": {"available": true}}',
   30, 120),
  ('IOS_PHONE', 'Yanımda', 'iOS eşlikçi uygulama', 'PHONE', 'A',
   '{"sos": {"available": true, "latency": "INSTANT"}, "fall": {"available": false},
     "voice": {"available": true}, "location": {"available": true, "latency": "NEAR"},
     "onBody": {"available": false}, "charging": {"available": true}, "steps": {"available": true}}',
   30, 120),
  ('SIMULATOR', 'Yanımda', 'Simülatör (geliştirme)', 'WATCH', 'A',
   '{"sos": {"available": true, "latency": "INSTANT"}, "fall": {"available": true, "latency": "INSTANT"},
     "voice": {"available": true}, "location": {"available": true, "latency": "NEAR"},
     "onBody": {"available": true}, "charging": {"available": true}}',
   40, 90);

-- Cihaz: kategori, sınıf, vücut konumu, bağlantı yolu ve köprü, sesli arama sırası, takma ad, emeklilik, şarj.
-- Takılı bilgisi mevcut on_wrist sütunudur (API'de onBody).
ALTER TABLE device.device ADD COLUMN model_id text REFERENCES device.device_model (id);
ALTER TABLE device.device ADD COLUMN category text
  CHECK (category IN ('WATCH', 'PHONE', 'PENDANT', 'RING', 'EARBUD', 'EARRING', 'HOME_UNIT', 'CLOUD'));
ALTER TABLE device.device ADD COLUMN tier text CHECK (tier IN ('A', 'B', 'C'));
ALTER TABLE device.device ADD COLUMN body_location text
  CHECK (body_location IN ('WRIST_LEFT', 'WRIST_RIGHT', 'NECK', 'CHEST', 'FINGER', 'EAR', 'POCKET', 'HOME'));
ALTER TABLE device.device ADD COLUMN connection_path text
  CHECK (connection_path IN ('DIRECT', 'PHONE_BRIDGE', 'HOME_UNIT', 'VENDOR_CLOUD', 'PARTNER_CENTER'));
ALTER TABLE device.device ADD COLUMN bridge_device_id uuid;
ALTER TABLE device.device ADD COLUMN voice_order int CHECK (voice_order BETWEEN 1 AND 6);
ALTER TABLE device.device ADD COLUMN nickname text CHECK (char_length(nickname) <= 40);
ALTER TABLE device.device ADD COLUMN vendor_device_id text;
ALTER TABLE device.device ADD COLUMN retired_at timestamptz;
ALTER TABLE device.device ADD COLUMN charging boolean NOT NULL DEFAULT false;
ALTER TABLE device.device ADD COLUMN charging_since timestamptz;

UPDATE device.device d
SET model_id = m.id, category = m.category, tier = m.tier
FROM device.device_model m
WHERE m.id = d.kind;

CREATE INDEX device_person_active_idx ON device.device (protected_person_id)
  WHERE revoked_at IS NULL AND retired_at IS NULL;

-- Kişi başına kapsama: seviye, yetenek vektörü, nedenler ve hesaplamanın olguları (cihaz başına son durum, JSON;
-- olay motoru cihaz tablosunu okumaz, olgular sinyallerden gelir). Şarj boşluğu ve "kapsama yok" zamanlayıcıları
-- dakikalık taramada bu satırdan yürür (gönderilen adımlar *_sent; tekrar ayıklama).
CREATE TABLE event.coverage_state (
  protected_person_id text PRIMARY KEY,
  level text NOT NULL CHECK (level IN ('FULL', 'BASIC', 'PHONE_ONLY', 'NIGHT', 'NONE')),
  -- Gece penceresi uygulanmadan önceki seviye (gece boyunca da boşluk nedenini bilmek için).
  raw_level text NOT NULL CHECK (raw_level IN ('FULL', 'BASIC', 'PHONE_ONLY', 'NONE')),
  since timestamptz NOT NULL,
  reasons text[] NOT NULL DEFAULT '{}',
  capabilities jsonb NOT NULL,
  devices jsonb NOT NULL DEFAULT '{}',
  bridge_seen_at timestamptz,
  gap_since timestamptz,
  gap_cause text CHECK (gap_cause IN ('CHARGING', 'BATTERY_DEAD')),
  gap_off_plan boolean NOT NULL DEFAULT false,
  gap_sent text[] NOT NULL DEFAULT '{}',
  none_since timestamptz,
  none_sent text[] NOT NULL DEFAULT '{}',
  intent_until timestamptz,
  plan_checked_on text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Seviye geçişleri: "uyanık zamanın yüzde kaçı korundu" ve 7 günlük zaman çizelgesi buradan (S3.2, S7.4).
CREATE TABLE event.coverage_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  protected_person_id text NOT NULL,
  from_level text,
  level text NOT NULL,
  reasons text[] NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL
);
CREATE INDEX coverage_history_person_at_idx ON event.coverage_history (protected_person_id, at);

-- Tercih edilen şarj penceresi (S4.3): varsayılan 19:00–21:00, 14 günde öğrenilir, aile değiştirebilir. Tek alarm
-- cihazının gece şarjı yalnız aile "gece düşme koruması yok" uyarısını onaylarsa (night_ack_*).
CREATE TABLE event.charging_plan (
  protected_person_id text PRIMARY KEY,
  window_start text NOT NULL CHECK (window_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  window_end text NOT NULL CHECK (window_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  source text NOT NULL DEFAULT 'DEFAULT' CHECK (source IN ('DEFAULT', 'LEARNED', 'FAMILY')),
  night_charge_allowed boolean NOT NULL DEFAULT false,
  night_ack_at timestamptz,
  night_ack_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
