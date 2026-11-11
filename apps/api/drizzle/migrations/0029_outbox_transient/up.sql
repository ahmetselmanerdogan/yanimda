-- 0029 · Outbox core şeridi (denetim bulgusu): geçici altyapı hataları (bağlantı, failover, sorgu zaman aşımı) ayrı
-- sayılır; DLQ bütçesini (attempts, kalıcı hata) tüketmez, kendi sınırına (~1 saat) kadar yeniden denenir.
ALTER TABLE event.outbox ADD COLUMN transient_attempts int NOT NULL DEFAULT 0;
