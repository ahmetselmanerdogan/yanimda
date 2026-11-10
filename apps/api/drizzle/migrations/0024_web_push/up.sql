-- 0024 · Personel web push aboneliği (PWA): amir uyarıları (SLA ihlali, kilit, 112 gecikmesi, kaçırılan düzenli
-- arama) telefona/masaüstüne. Abonelik kişiye değil personele aittir; yük kişisel veri içermez (olay türü + kod).
CREATE TABLE identity.web_push_subscription (
  endpoint text PRIMARY KEY,
  subject text NOT NULL,
  roles text[] NOT NULL DEFAULT '{}',
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_ok_at timestamptz,
  failures int NOT NULL DEFAULT 0
);
CREATE INDEX web_push_subject_idx ON identity.web_push_subscription (subject);
