ALTER TABLE device.device DROP COLUMN push_updated_at;
ALTER TABLE device.device DROP COLUMN push_sandbox;
ALTER TABLE device.device DROP COLUMN push_token;
ALTER TABLE device.device DROP COLUMN push_provider;
ALTER TABLE device.device DROP COLUMN app_version;
ALTER TABLE device.device DROP COLUMN os_version;
ALTER TABLE device.device DROP COLUMN revoked_at;
ALTER TABLE device.device DROP COLUMN enrolled_at;
DROP TABLE profile.invite;
