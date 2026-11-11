-- 0028 · T-040 (C-02, C-04) aile üyesi (MEMBER) daveti: hesap sahibi (OWNER) ikinci bir aile hesabını davet eder.
-- Kod 10 karakter (Crockford base32, ~50 bit), 72 saat geçerli, tek kullanımlık. Kodun kendisi saklanmaz: sha256(kod).
-- created_by / used_by aile hesabının OIDC `sub` kimliğidir (e-posta, telefon değil).
CREATE TABLE profile.member_invite (
  id uuid PRIMARY KEY,
  protected_person_id uuid NOT NULL REFERENCES profile.protected_person (id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  created_by text NOT NULL,
  relation text CHECK (char_length(relation) <= 50),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((used_at IS NULL) = (used_by IS NULL))
);
CREATE UNIQUE INDEX member_invite_code_hash ON profile.member_invite (code_hash);
-- Açık davet sayısı (kişi başına sınır) için.
CREATE INDEX member_invite_open ON profile.member_invite (protected_person_id, expires_at) WHERE used_at IS NULL;
