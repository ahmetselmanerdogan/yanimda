DELETE FROM notify.notification WHERE recipient_kind = 'DEVICE_RELAY';
ALTER TABLE notify.notification DROP CONSTRAINT notification_recipient_kind_check;
ALTER TABLE notify.notification ADD CONSTRAINT notification_recipient_kind_check
  CHECK (recipient_kind IN ('PUSH_TARGET', 'CONTACT', 'DEVICE'));
