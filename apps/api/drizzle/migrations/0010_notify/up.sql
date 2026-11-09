-- 0010 · T-053 (D-08) bildirimler.
-- notify.push_target: aile/kişi uygulamasının push token'ı (consumers realm `sub`). Cihazların (saat/telefon) token'ı
-- device.device'ta (T-041).
CREATE TABLE notify.push_target (
  id uuid PRIMARY KEY,
  subject text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('FCM')),
  token text NOT NULL UNIQUE,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_target_subject_idx ON notify.push_target (subject);

-- notify.notification: alıcı × kanal başına bir satır. Metin ve numara saklanmaz: kod + alıcı kimliği (push hedefi,
-- rehber kaydı veya cihaz). Gönderim olay akışından ayrı: satır önce yazılır (kalıcı), dağıtıcı sonra gönderir.
CREATE TABLE notify.notification (
  id uuid PRIMARY KEY,
  dedupe_key text NOT NULL,
  code text NOT NULL,
  audience text NOT NULL CHECK (audience IN ('ELDER', 'FAMILY')),
  urgency text NOT NULL CHECK (urgency IN ('URGENT', 'INFO')),
  protected_person_id text NOT NULL,
  event_id uuid,
  channel text NOT NULL CHECK (channel IN ('PUSH', 'SMS', 'VOICE', 'DEVICE')),
  recipient_kind text NOT NULL CHECK (recipient_kind IN ('PUSH_TARGET', 'CONTACT', 'DEVICE')),
  recipient_id text NOT NULL,
  vars jsonb,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'failed')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  -- INFO push: bu ana kadar teslim (uygulama onayı) yoksa SMS yedeği
  fallback_at timestamptz,
  fallback_done boolean NOT NULL DEFAULT false,
  fallback_of uuid REFERENCES notify.notification (id),
  provider_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  UNIQUE (dedupe_key, channel, recipient_id)
);
CREATE INDEX notification_due_idx ON notify.notification (next_attempt_at) WHERE status IN ('queued', 'sending');
CREATE INDEX notification_fallback_idx ON notify.notification (fallback_at) WHERE NOT fallback_done;
CREATE INDEX notification_provider_idx ON notify.notification (provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX notification_person_idx ON notify.notification (protected_person_id, created_at DESC);
