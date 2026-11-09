-- 0006 · T-041 cihaz kaydı (+ T-040'ın davet kodu parçası).
-- Davet kodu 6 hanedir, 15 dk geçerlidir, tek kullanımlıktır. Kodun kendisi saklanmaz: sha256(kod).
CREATE TABLE profile.invite (
  id uuid PRIMARY KEY,
  protected_person_id uuid NOT NULL REFERENCES profile.protected_person(id),
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_by_device_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invite_code_hash ON profile.invite (code_hash);

-- Kayıt ve token iptali: revoked_at dolu cihazın token'ı 401 alır (aile "cihazı kaldır").
ALTER TABLE device.device ADD COLUMN enrolled_at timestamptz;
ALTER TABLE device.device ADD COLUMN revoked_at timestamptz;
ALTER TABLE device.device ADD COLUMN os_version text;
ALTER TABLE device.device ADD COLUMN app_version text;
-- Push token (T-053 kullanır): APNS | FCM. Token PII değildir ama log'lanmaz.
ALTER TABLE device.device ADD COLUMN push_provider text;
ALTER TABLE device.device ADD COLUMN push_token text;
ALTER TABLE device.device ADD COLUMN push_sandbox boolean;
ALTER TABLE device.device ADD COLUMN push_updated_at timestamptz;
