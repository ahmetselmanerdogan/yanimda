DROP TABLE IF EXISTS device.pendant_maintenance;
DROP TABLE IF EXISTS device.work_order;
DROP TABLE IF EXISTS device.partner_status;
DROP TABLE IF EXISTS device.partner_latency;
DROP TABLE IF EXISTS device.partner_delivery;
DROP TABLE IF EXISTS device.vendor_link;
UPDATE device.device SET model_id = NULL
WHERE model_id IN ('FAKE_PENDANT_CELL', 'FAKE_PENDANT_RADIO', 'FAKE_HOME_UNIT');
DELETE FROM device.device_model WHERE id IN ('FAKE_PENDANT_CELL', 'FAKE_PENDANT_RADIO', 'FAKE_HOME_UNIT');
