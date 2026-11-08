# İlk Claude Code oturumu için istem (kopyala-yapıştır)

Önce docs/ klasörüne 00–06 dokümanlarını Markdown olarak indirip koy (docs/README.md'deki bağlantılar). Sonra Claude Code'u repo kökünde aç ve şunu ver:

```
CLAUDE.md ve docs/README.md, docs/TASKS.md, docs/03-teknik-mimari.md dosyalarını oku.
Mevcut durum: S0 iskeleti ve bellek içi olay motoru çalışıyor (`pnpm test` 9 test yeşil).
Görev: T-010 — Sinyal alımını kalıcı hale getir (PRD D-01; 03 "Veri modeli" signal.signal ve "Servis haritası" Sinyal Alımı).
Yapılacak:
1. apps/api/src/modules/signal: Timescale (signal.signal) yazımı; bağlantı DATABASE_URL (infra/init.sql şeması).
2. Kafka/Redpanda üretici: topic signal.received, packages/contracts/schemas/kafka-envelope.schema.json'a uygun; common/bus.ts arayüzünü koru, Kafka ile değiştir (geliştirmede docker compose redpanda).
3. Idempotency: Redis'te 24 saat (SET NX EX); bellek içi Map kaldır.
Kabul: test/flow.spec.ts yeşil kalır; Testcontainers ile entegrasyon testi: 1 sinyal → 1 satır + 1 Kafka mesajı; aynı key iki kez → duplicates=1.
Sınırlar: event modülüne dokunma; mesaj ekleme; sağlık verisi yok.
Çıktı: PR, commit `backend(D-01): sinyal alımı Timescale+Kafka+Redis`. Bitmeden docs/06 "Tanımı tamamlandı" listesini raporla.
```
