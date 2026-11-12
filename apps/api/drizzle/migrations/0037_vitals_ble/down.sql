-- 0037 geri alma: BLE köprülü cihaz kayıtları silinir (kategori kısıtı eski hâline döner), değer tabloları düşer.
DELETE FROM device.device WHERE kind IN ('BLE_HR', 'BLE_PULSE_OX', 'BLE_THERMO', 'BLE_PENDANT');
DELETE FROM device.device_model WHERE id IN ('BLE_HR', 'BLE_PULSE_OX', 'BLE_THERMO', 'BLE_PENDANT');
UPDATE device.device SET category = NULL WHERE category = 'SENSOR';
ALTER TABLE device.device DROP CONSTRAINT IF EXISTS device_category_check;
ALTER TABLE device.device ADD CONSTRAINT device_category_check
  CHECK (category IN ('WATCH', 'PHONE', 'PENDANT', 'RING', 'EARBUD', 'EARRING', 'HOME_UNIT', 'CLOUD'));
ALTER TABLE device.device_model DROP CONSTRAINT IF EXISTS device_model_category_check;
ALTER TABLE device.device_model ADD CONSTRAINT device_model_category_check
  CHECK (category IN ('WATCH', 'PHONE', 'PENDANT', 'RING', 'EARBUD', 'EARRING', 'HOME_UNIT', 'CLOUD'));
DROP INDEX IF EXISTS device.device_bridge_address_idx;
ALTER TABLE device.device DROP COLUMN IF EXISTS bridge_address_hash;
ALTER TABLE event.event DROP COLUMN IF EXISTS head_of_queue;
DROP TABLE IF EXISTS health.vital_review;
DROP TABLE IF EXISTS health.vital_silence;
DROP TABLE IF EXISTS health.vital_alert;
DROP TABLE IF EXISTS health.vital_profile;
DROP TABLE IF EXISTS health.vital_baseline;
DROP TABLE IF EXISTS health.vital_daily;
DROP TABLE IF EXISTS health.vital_sample;
