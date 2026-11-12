-- 0037 · T-092 (docs/07 S6, S2.1 B sınıfı, S4.8, S7.5, S8.1): değer kuralları (bayrakla kapalı) ve telefon köprüsüyle
-- bağlanan BLE cihazlar. Değer tabloları health şemasındadır: yalnız kural paketinde `vitals.enabled` açıkken yazılır,
-- yalnız olay anında (operatör, açık olay) ve aileye haftalık özet olarak okunur; log'a yazılmaz.

-- Geçerli ham örnekler (S6.8: 30 gün). Nabız 25–250 dışı hiç yazılmaz. eligible: ortak şartlar (takılı, şarjda değil,
-- ≥5 dk takılı, pil ≥%10, son 5 dk hiçbir cihazda 20 adımdan az) örnek geldiği anda sağlanıyordu.
CREATE TABLE health.vital_sample (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  protected_person_id text NOT NULL,
  device_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('HR', 'SPO2', 'SKIN_TEMP')),
  value double precision NOT NULL,
  at timestamptz NOT NULL,
  quality text NOT NULL CHECK (quality IN ('Q1', 'Q2', 'Q3')),
  slice text NOT NULL CHECK (slice IN ('SLEEP', 'REST', 'ACTIVE')),
  worn boolean NOT NULL,
  still boolean NOT NULL,
  eligible boolean NOT NULL,
  source_key text NOT NULL UNIQUE
);
CREATE INDEX vital_sample_person_idx ON health.vital_sample (protected_person_id, kind, at DESC);
CREATE INDEX vital_sample_at_idx ON health.vital_sample (at);

-- Günlük dilim özetleri (kişinin yerel günü; S6.8: 13 ay). Taban çizgisi ve aileye haftalık eğilim buradan.
CREATE TABLE health.vital_daily (
  protected_person_id text NOT NULL,
  day date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('HR', 'SPO2', 'SKIN_TEMP')),
  slice text NOT NULL CHECK (slice IN ('SLEEP', 'REST', 'ACTIVE')),
  median double precision NOT NULL,
  min double precision NOT NULL,
  max double precision NOT NULL,
  n int NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (protected_person_id, day, kind, slice)
);
CREATE INDEX vital_daily_day_idx ON health.vital_daily (day);

-- Kişisel taban çizgisi (S6.3): dilim başına geçerli günlerin ortancası, 28 günlük kayan pencere.
CREATE TABLE health.vital_baseline (
  protected_person_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('HR', 'SPO2', 'SKIN_TEMP')),
  slice text NOT NULL CHECK (slice IN ('SLEEP', 'REST', 'ACTIVE')),
  median double precision NOT NULL,
  valid_days int NOT NULL,
  computed_at timestamptz NOT NULL,
  PRIMARY KEY (protected_person_id, kind, slice)
);

-- Kişi başına değer ayarları: öğrenme başlangıcı (ilk geçerli örnek) ve kişiye özel eşikler (S6.7). Kişiye özel eşik
-- veya KOAH profili yalnız aile onayı + yüklenmiş doktor notu işaretiyle; notun içeriği tutulmaz (yalnız işaret ve
-- isteğe bağlı belge referansı).
CREATE TABLE health.vital_profile (
  protected_person_id text PRIMARY KEY,
  learning_started_at timestamptz,
  low_hr int CHECK (low_hr BETWEEN 25 AND 80),
  high_hr int CHECK (high_hr BETWEEN 90 AND 220),
  spo2_low int CHECK (spo2_low BETWEEN 70 AND 96),
  copd boolean NOT NULL DEFAULT false,
  trends_muted boolean NOT NULL DEFAULT false,
  family_consent_by text,
  family_consent_at timestamptz,
  doctor_note boolean NOT NULL DEFAULT false,
  doctor_note_ref text CHECK (char_length(doctor_note_ref) <= 200),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  CHECK (
    (low_hr IS NULL AND high_hr IS NULL AND spo2_low IS NULL AND NOT copd)
    OR (family_consent_at IS NOT NULL AND doctor_note)
  )
);

-- Tetiklenen kurallar: olay (EVENT), aileye eğilim (FAMILY), haftalık sınıra takılan (LIMITED), düşme vurgusu
-- (HIGHLIGHT). run_start: tutarlı okumanın başladığı an (aynı süren okuma ikinci kez tetiklemez).
CREATE TABLE health.vital_alert (
  id uuid PRIMARY KEY,
  protected_person_id text NOT NULL,
  rule text NOT NULL CHECK (
    rule IN ('LOW_HR_STILL', 'LOW_HR', 'HIGH_HR', 'HR_BASELINE_DEVIATION', 'SPO2_LOW', 'SPO2_LOW_HR', 'FALL_HR_HIGHLIGHT')
  ),
  outcome text NOT NULL CHECK (outcome IN ('EVENT', 'FAMILY', 'LIMITED', 'HIGHLIGHT')),
  priority int CHECK (priority BETWEEN 1 AND 4),
  value double precision NOT NULL,
  run_start timestamptz NOT NULL,
  at timestamptz NOT NULL,
  event_id uuid,
  -- Ulaşılamadı + hareket yok → P2 hareketsizlik merdiveni (S5.4); yanlış alarm işareti (S6.7, T-071 ile).
  escalated_at timestamptz,
  false_alarm_at timestamptz
);
CREATE INDEX vital_alert_person_idx ON health.vital_alert (protected_person_id, rule, at DESC);
CREATE INDEX vital_alert_event_idx ON health.vital_alert (event_id);

-- Alarm yorgunluğu (S6.7): operatör "iyi" kaydedince kişi + kural cooldownH susar; okuma worsenPct kötüleşirse delinir.
CREATE TABLE health.vital_silence (
  protected_person_id text NOT NULL,
  rule text NOT NULL,
  until timestamptz NOT NULL,
  ref_value double precision NOT NULL,
  event_id uuid,
  PRIMARY KEY (protected_person_id, rule)
);

-- Amirin eşik incelemesi kuyruğu (S6.7): haftalık kontrol araması sınırı aşıldı veya değer olaylarında tekrarlayan
-- yanlış alarm. Değer yazılmaz.
CREATE TABLE health.vital_review (
  id uuid PRIMARY KEY,
  protected_person_id text NOT NULL,
  rule text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('WEEKLY_LIMIT', 'FALSE_ALARMS')),
  dedupe_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  resolved_at timestamptz,
  resolved_by text,
  note text CHECK (char_length(note) <= 500)
);
CREATE INDEX vital_review_open_idx ON health.vital_review (created_at) WHERE resolved_at IS NULL;

-- P2 değer kombinasyonu (düşük nabız + hareketsizlik) kuyruğun başına (S6.4): aynı öncelikte önce.
ALTER TABLE event.event ADD COLUMN head_of_queue boolean NOT NULL DEFAULT false;

-- BLE köprülü cihazlar (S2.1 B sınıfı, S7.5): yaşlının telefonu kaydeder; ham MAC adresi tutulmaz. İstemci adresin
-- SHA-256'sını gönderir, sunucu telefon kimliğiyle birlikte sunucu tarafı anahtarla (HMAC) yeniden özetler.
-- Aynı telefon + adres için tek etkin kayıt (yeniden kayıt aynı cihaz kimliğini döner).
ALTER TABLE device.device ADD COLUMN bridge_address_hash text;
CREATE UNIQUE INDEX device_bridge_address_idx ON device.device (bridge_device_id, bridge_address_hash)
  WHERE revoked_at IS NULL AND bridge_address_hash IS NOT NULL;

-- Yeni kategori: tek amaçlı ölçüm cihazı (nabız kemeri, parmak oksimetre, termometre).
ALTER TABLE device.device_model DROP CONSTRAINT IF EXISTS device_model_category_check;
ALTER TABLE device.device_model ADD CONSTRAINT device_model_category_check
  CHECK (category IN ('WATCH', 'PHONE', 'PENDANT', 'RING', 'EARBUD', 'EARRING', 'HOME_UNIT', 'CLOUD', 'SENSOR'));
ALTER TABLE device.device DROP CONSTRAINT IF EXISTS device_category_check;
ALTER TABLE device.device ADD CONSTRAINT device_category_check
  CHECK (category IN ('WATCH', 'PHONE', 'PENDANT', 'RING', 'EARBUD', 'EARRING', 'HOME_UNIT', 'CLOUD', 'SENSOR'));

-- BLE model profilleri. Nabız/oksijen/sıcaklık cihazları B sınıfı (olay açamaz; değer kurallarına girer). BLE kolye
-- A sınıfıdır ama yalnız köprü telefon çevrimiçiyken sayılır (S4.8; kapsama köprüsüz düşer); düşme ve ses yok.
INSERT INTO device.device_model (id, vendor, model, category, tier, capabilities, battery_life_h, charge_time_min)
VALUES
  ('BLE_HR', 'Genel', 'BLE nabız ölçer (0x180D)', 'SENSOR', 'B',
   '{"sos": {"available": false}, "fall": {"available": false}, "voice": {"available": false},
     "location": {"available": false}, "onBody": {"available": true}, "charging": {"available": false},
     "heartRate": {"available": true, "latency": "NEAR", "quality": "Q2"}}',
   200, NULL),
  ('BLE_PULSE_OX', 'Genel', 'BLE nabız oksimetre (0x1822)', 'SENSOR', 'B',
   '{"sos": {"available": false}, "fall": {"available": false}, "voice": {"available": false},
     "location": {"available": false}, "onBody": {"available": true}, "charging": {"available": false},
     "heartRate": {"available": true, "latency": "NEAR", "quality": "Q2"},
     "spo2": {"available": true, "latency": "NEAR", "quality": "Q2"}}',
   40, NULL),
  ('BLE_THERMO', 'Genel', 'BLE cilt sıcaklığı ölçer', 'SENSOR', 'B',
   '{"sos": {"available": false}, "fall": {"available": false}, "voice": {"available": false},
     "location": {"available": false}, "onBody": {"available": true}, "charging": {"available": false},
     "skinTemp": {"available": true, "latency": "DAILY", "quality": "Q2"}}',
   720, NULL),
  ('BLE_PENDANT', 'Genel', 'BLE kolye (telefon köprüsü)', 'PENDANT', 'A',
   '{"sos": {"available": true, "latency": "INSTANT"}, "fall": {"available": false}, "voice": {"available": false},
     "location": {"available": false}, "onBody": {"available": true}, "charging": {"available": false}}',
   4380, NULL);
