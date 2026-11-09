-- 0009 · T-040 (C-02, C-03, C-04) profil: adres, aile üyeleri (sahiplik), tıbbi özet (şifreli), abonelik.
-- Şifreli alanlar (door_access_note_enc, health.medical_summary.ciphertext) AES-256-GCM, `v1:<kid>:…` biçiminde;
-- düz metin DB'ye yazılmaz. Sağlık verisi yalnız olay anında, olayı yürüten operatöre çözülür.
ALTER TABLE profile.protected_person
  ADD COLUMN address_line text,
  ADD COLUMN district text,
  ADD COLUMN city text,
  ADD COLUMN postal_code text,
  ADD COLUMN lat double precision,
  ADD COLUMN lng double precision,
  ADD COLUMN geocoded_at timestamptz,
  ADD COLUMN door_access_note_enc text CHECK (door_access_note_enc LIKE 'v1:%');

-- Aile hesabı (consumers realm `sub`) ↔ korunan kişi. FAMILY yalnız burada kaydı olan kişileri görür.
CREATE TABLE profile.family_member (
  id uuid PRIMARY KEY,
  protected_person_id uuid NOT NULL REFERENCES profile.protected_person (id) ON DELETE CASCADE,
  subject text NOT NULL,
  role text NOT NULL CHECK (role IN ('OWNER', 'MEMBER')),
  relation text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (protected_person_id, subject)
);
CREATE INDEX family_member_subject_idx ON profile.family_member (subject);

-- Tıbbi özet tek şifreli JSON (hastalıklar, ilaçlar, alerjiler, kan grubu, not). Rıza zamanı zorunlu (C-03).
CREATE TABLE health.medical_summary (
  protected_person_id uuid PRIMARY KEY REFERENCES profile.protected_person (id) ON DELETE CASCADE,
  ciphertext text NOT NULL CHECK (ciphertext LIKE 'v1:%'),
  consent_at timestamptz NOT NULL,
  consent_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Abonelik (ödeme T-060). Kişi başına en çok bir açık abonelik.
CREATE TABLE profile.subscription (
  id uuid PRIMARY KEY,
  protected_person_id uuid NOT NULL REFERENCES profile.protected_person (id) ON DELETE CASCADE,
  plan text NOT NULL,
  status text NOT NULL CHECK (status IN ('TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELED')),
  started_at timestamptz NOT NULL DEFAULT now(),
  renews_at timestamptz,
  canceled_at timestamptz
);
CREATE UNIQUE INDEX subscription_open_idx ON profile.subscription (protected_person_id) WHERE status <> 'CANCELED';
