-- 0036 · T-085 OEM ortak cihazları (docs/07 S2.5–S2.7, S4.9, S8.1, S9.3).
-- Ortak adaptörü (ör. hücresel / radyo kolye merkezi) olaylarını imzalı webhook'la gönderir; sinyaller aynı hattan
-- (signal.signal + outbox, tek transaction) geçer. Burada: sahte ortağın katalog satırları, kişi/cihaz ↔ üretici
-- bağlantısı (yalnız kimlikler; üretici hesap kimliği ve belirteç yalnız şifreli), webhook tekrar koruması (nonce),
-- ortak gecikmesi örnekleri ve bozulma durumu, 12 ay pilli kolye bakımı (iş emri, pil eğilimi, test hatırlatması).

-- Sahte ortak (FAKE_PENDANT, yalnız test / geliştirme): hücresel kolye, EN 50134-2 radyo kolye ve ev ünitesi.
INSERT INTO device.device_model (id, vendor, model, category, tier, capabilities, battery_life_h, charge_time_min)
VALUES
  ('FAKE_PENDANT_CELL', 'Sahte ortak (test)', 'Hücresel kolye', 'PENDANT', 'A',
   '{"sos": {"available": true, "latency": "INSTANT"}, "fall": {"available": true, "latency": "INSTANT"},
     "voice": {"available": true}, "location": {"available": true, "latency": "NEAR"},
     "onBody": {"available": true}, "charging": {"available": true}}',
   72, 120),
  ('FAKE_PENDANT_RADIO', 'Sahte ortak (test)', 'Radyo kolye (EN 50134-2, ev ünitesi)', 'PENDANT', 'A',
   '{"sos": {"available": true, "latency": "INSTANT"}, "fall": {"available": true, "latency": "INSTANT"},
     "voice": {"available": false}, "location": {"available": false}, "onBody": {"available": true}}',
   8760, NULL),
  ('FAKE_HOME_UNIT', 'Sahte ortak (test)', 'Ev ünitesi (hoparlör, SOS düğmesi)', 'HOME_UNIT', 'A',
   '{"sos": {"available": true, "latency": "INSTANT"}, "fall": {"available": false},
     "voice": {"available": true}, "location": {"available": false}}',
   24, NULL);

-- Kişi/cihaz ↔ üretici bağlantısı. Üretici cihaz kimliği (seri no) eşleme için açık; üretici hesap kimliği ve bulut
-- belirteci yalnız alan düzeyinde şifreli (FieldCipher, AAD `vendor-link:<id>`). Yurt dışı veri bölgesinde açık rıza
-- veya aktarım dayanağı zorunlu (S9.3, KVKK).
CREATE TABLE device.vendor_link (
  id uuid PRIMARY KEY,
  partner text NOT NULL CHECK (partner ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  vendor_device_id text NOT NULL CHECK (char_length(vendor_device_id) BETWEEN 1 AND 200),
  vendor_account_enc text,
  token_enc text,
  device_id uuid NOT NULL REFERENCES device.device (id),
  protected_person_id uuid NOT NULL,
  model_id text NOT NULL REFERENCES device.device_model (id),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  data_region text NOT NULL CHECK (data_region ~ '^[A-Z]{2}$'),
  consent_basis text NOT NULL
    CHECK (consent_basis IN ('EXPLICIT_CONSENT', 'SCC_NOTIFIED', 'ADEQUACY', 'NOT_REQUIRED')),
  consent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  revoked_at timestamptz,
  CHECK (data_region = 'TR' OR (consent_at IS NOT NULL AND consent_basis <> 'NOT_REQUIRED')),
  CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX vendor_link_active_idx ON device.vendor_link (partner, vendor_device_id) WHERE status = 'ACTIVE';
CREATE INDEX vendor_link_device_idx ON device.vendor_link (device_id);

-- Webhook tekrar koruması: (ortak, nonce) bir kez. Zaman penceresinden eski satırlar tarama ile silinir.
CREATE TABLE device.partner_delivery (
  partner text NOT NULL,
  nonce text NOT NULL,
  received_at timestamptz NOT NULL,
  PRIMARY KEY (partner, nonce)
);
CREATE INDEX partner_delivery_at_idx ON device.partner_delivery (received_at);

-- Ortak gecikmesi örnekleri (olay anı → alım anı, ms); p95 / p99 son pencereden (S2.7, S7.3).
CREATE TABLE device.partner_latency (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  partner text NOT NULL,
  at timestamptz NOT NULL,
  latency_ms int NOT NULL CHECK (latency_ms >= 0)
);
CREATE INDEX partner_latency_partner_at_idx ON device.partner_latency (partner, at);

-- Ortak başına son değerlendirme; degraded_since doluyken o ortağın cihazları kapsamada "zayıf" (PARTNER_LATENCY).
CREATE TABLE device.partner_status (
  partner text PRIMARY KEY,
  samples int NOT NULL DEFAULT 0,
  p95_ms int,
  p99_ms int,
  degraded_since timestamptz,
  checked_at timestamptz
);

-- Operasyon iş emri (S4.9): uzun ömürlü pilli kolyenin pil değişimi. Cihaz ve tür başına tek açık iş emri.
CREATE TABLE device.work_order (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('PENDANT_BATTERY')),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DONE')),
  reason text NOT NULL CHECK (reason IN ('LOW_BATTERY', 'PREDICTED_END')),
  device_id uuid NOT NULL,
  protected_person_id uuid NOT NULL,
  battery_pct int CHECK (battery_pct BETWEEN 0 AND 100),
  predicted_end_at timestamptz,
  due_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  closed_at timestamptz,
  closed_by text,
  close_reason text CHECK (close_reason IN ('REPLACED', 'DONE')),
  CHECK ((status = 'DONE') = (closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX work_order_open_idx ON device.work_order (device_id, kind) WHERE status = 'OPEN';
CREATE INDEX work_order_status_idx ON device.work_order (status, due_at);

-- Uzun ömürlü pilli cihazın pil eğilimi (tahmini bitiş) ve aylık test hatırlatmasının son gönderimi.
CREATE TABLE device.pendant_maintenance (
  device_id uuid PRIMARY KEY,
  protected_person_id uuid NOT NULL,
  baseline_pct int,
  baseline_at timestamptz,
  last_pct int,
  last_at timestamptz,
  test_reminded_at timestamptz
);
