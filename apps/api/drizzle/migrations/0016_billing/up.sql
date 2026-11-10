-- 0016 · T-060 (C-01) web abonelik: ödeme sağlayıcısı (iyzico TR / Stripe US), deneme ve ödeme bekleme koruması,
-- KVKK rıza kaydı, webhook tekrar ayıklama. Kart verisi saklanmaz (sağlayıcının barındırdığı ödeme sayfası).
ALTER TABLE profile.subscription
  ADD COLUMN country_code text NOT NULL DEFAULT 'TR',
  ADD COLUMN provider text CHECK (provider IN ('IYZICO', 'STRIPE', 'FAKE')),
  ADD COLUMN provider_customer_ref text,
  ADD COLUMN provider_subscription_ref text,
  ADD COLUMN checkout_ref text,
  -- Deneme: ilk (test olmayan) olay veya 30 gün, hangisi önceyse.
  ADD COLUMN trial_ends_at timestamptz,
  -- Ödeme bekliyor (PAST_DUE): bu ana kadar koruma sürer; sonra askıda (cihaz config protectionActive=false).
  ADD COLUMN past_due_since timestamptz,
  ADD COLUMN grace_until timestamptz,
  ADD COLUMN suspended_at timestamptz,
  -- Sıra dışı gelen webhook'lar eski durumu geri getirmesin.
  ADD COLUMN last_provider_event_at timestamptz,
  -- KVKK aydınlatma metni sürümü ve açık rıza anı (metinler hukuk onayı bekliyor).
  ADD COLUMN kvkk_notice_version text,
  ADD COLUMN explicit_consent_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

UPDATE profile.subscription SET trial_ends_at = started_at + interval '30 days' WHERE status = 'TRIAL';

CREATE UNIQUE INDEX subscription_provider_ref_idx ON profile.subscription (provider, provider_subscription_ref)
  WHERE provider_subscription_ref IS NOT NULL;
CREATE UNIQUE INDEX subscription_checkout_ref_idx ON profile.subscription (provider, checkout_ref)
  WHERE checkout_ref IS NOT NULL;
CREATE INDEX subscription_due_idx ON profile.subscription (status, trial_ends_at, grace_until)
  WHERE status IN ('TRIAL', 'PAST_DUE');

-- Webhook tekrarları: (sağlayıcı, olay kimliği) bir kez işlenir; durum değişikliğiyle aynı transaction'da yazılır.
CREATE TABLE profile.payment_webhook (
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  type text NOT NULL,
  subscription_id uuid REFERENCES profile.subscription (id) ON DELETE SET NULL,
  outcome text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_event_id)
);
