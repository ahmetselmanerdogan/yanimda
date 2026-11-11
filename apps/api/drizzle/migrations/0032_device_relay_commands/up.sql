-- 0032 · T-089/T-090 yaşlı bildiriminin kanal yönlendirmesi.
-- Kendi push token'ı olmayan saate (Wear OS: FCM yok, telefona Data Layer ile bağlı) giden W-* bildirimi köprü
-- telefon üzerinden gider: alıcı türü DEVICE_RELAY, alıcı kimliği saat; köprü telefon gönderimde çözülür.
ALTER TABLE notify.notification DROP CONSTRAINT notification_recipient_kind_check;
ALTER TABLE notify.notification ADD CONSTRAINT notification_recipient_kind_check
  CHECK (recipient_kind IN ('PUSH_TARGET', 'CONTACT', 'DEVICE', 'DEVICE_RELAY'));
