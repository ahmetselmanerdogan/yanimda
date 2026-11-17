# T-016 Test raporu: entegrasyon, kaos, k6 duman

Tarih: 2026-11-08 · Commit: T-016 · Ortam: geliştirici Mac (Apple Silicon), Node 20.20

## Özet

| Test | Kabul ölçütü | Sonuç |
| --- | --- | --- |
| S3 düşme, cevap yok | CREATED → DEVICE_PROMPT → ESCALATED → OPERATOR_QUEUE, operatör kapanışı | ✅ |
| S4 düşme, yanlış alarm | CREATED → DEVICE_PROMPT → CANCELLED_BY_USER → CLOSED, kuyruğa düşmez | ✅ |
| S7 saat çıkarıldı (gündüz) | WATCH_OFF beklemesi + PROTECTED_PHONE | ✅ |
| Redis 30 sn kapalı | sinyal kaybı 0, düşme yine yükselir, Redis dönünce işler çalışır | ✅ |
| Postgres 10 sn kapalı | API 503 ve ayakta, cihaz tamponlar, kayıp 0 | ✅ (kayıp 0, çift 0) |
| k6: 200 cihaz × 5 dk heartbeat, 10 dk | p95 signal→queue < 5 sn, hata 0 | ✅ p95 = 119 ms, hata 0 |

## Ortam ve görev tanımından sapma

Docker bu makinede yok, bu yüzden Testcontainers kullanılmadı. Testler gerçek süreçlerle koşuyor
(`apps/api/test/e2e/infra.ts`):

- **Redis:** `redis-server` 8.0.1, kalıcılık kapalı. Bu en kötü durum: yeniden başlatmada işler kaybolur.
- **Postgres:** PGlite socket sunucusu (Postgres 16 WASM), veri dosyada. Durdurulup başlatıldığında veri korunur.
  **TimescaleDB yok;** `signal.signal` düz tablo olarak çalıştı.
- **API:** `tsx src/main.ts` alt süreci, gerçek `pg` sürücüsü, BullMQ ve outbox işçisi.
- **Süreler:** Uçtan uca ve kaos testlerinde kural süreleri 0,1 ölçekli (FALL penceresi 6 sn); k6'da gerçek kural paketi
  kullanıldı.

~~**Açık:** Aynı testlerin gerçek TimescaleDB ve yönetilen Redis ile koşumu Docker veya staging (T-083) ile
yapılmalı.~~ — kapandı (2026-11-17): CI `image` işi (`.github/workflows/ci.yml`) her PR'da üretim imajını gerçek
TimescaleDB (`timescale/timescaledb:2.17.2-pg16`, `infra/init.sql`) + Redis 7.4 hizmet kaplarına karşı açar: migration'lar,
`signal.signal` hypertable, kayıtlı cihazdan SOS → outbox → operatör kuyruğu ve aynı veritabanının döküm/geri yükleme
tatbikatı (`infra/backup/restore-drill.sh`). Yük, `load-v1.yml` (`LOAD_TIMESCALE=1`, `scripts/load-v1.sh`) ile gerçek
TimescaleDB'de koşar (`docs/test-reports/yuk-kaos-v1.md`). Yönetilen Redis (DCS) yalnız staging'de doğrulanabilir.
CI'da uçtan uca iş, aynı Docker'sız düzenle her PR'da koşar (Ubuntu'ya `apt install redis-server`).

## 1. Senaryolar (`pnpm --filter @yanimda/api test:e2e`)

Simülatörün senaryo dosyaları değiştirilmeden kullanıldı (`packages/simulator/scenarios/s3|s4|s7`).

| Senaryo | Süre | Doğrulanan |
| --- | --- | --- |
| S3 | 6,6 sn | geçiş listesi, `GET /v1/queue`'da, 3 sinyal satırı; HTTP üstlen + EMERGENCY kapanış → 8 geçiş |
| S4 | 7,7 sn | geçiş listesi; pencere geçtikten sonra da ESCALATED yok, kuyrukta yok |
| S7 | 1,0 sn | WATCH_OFF CREATED → DEVICE_PROMPT, `GET /status` = PROTECTED_PHONE, onWrist=false |

## 2. Kaos

### Redis 30 sn kapalı

| Ölçüm | Değer |
| --- | --- |
| Kesinti sırasında gelen FALL'ın operatör kuyruğuna düşmesi | 6,1 sn (pencere 6 sn; yerel yedek zamanlayıcı) |
| Kesintiden hemen önce kurulmuş, Redis'le kaybolan işin kurtarılması | 11,2 sn (gecikmiş soru taraması) |
| Kesintide gönderilen 11 sinyal | 11 satır, 11 tekil anahtar (kayıp 0) |
| Aynı anahtarın kesintide tekrarı | `duplicates: 1` (veritabanı tekil indeksi) |
| Redis dönünce yeni FALL (BullMQ yolu) | 7,6 sn |

### Postgres 10 sn kapalı

| Ölçüm | Değer |
| --- | --- |
| Kesinti süresi | 10,3 sn |
| Kesintide `GET /v1/queue` | 503, `Retry-After: 2` |
| Gönderilen sinyal (40, biri kesinti ortasında SOS) | 40 satır, 40 tekil anahtar: **kayıp 0, çift 0** |
| Cihazın (simülatör) yeniden denemesi | 7 |
| Postgres dönüşünden cihaz tamponunun boşalmasına | 2,2 sn |
| SOS operatör kuyruğunda | ✅ |
| API yeniden başladı mı | Hayır (tek süreç, kaos boyunca ayakta) |

## 3. k6 duman (`scripts/load-smoke.sh`, `infra/k6/heartbeat-smoke.js`)

10 dk, 200 sanal cihaz (5 dk'da bir HEARTBEAT, başlangıçlar zamana yayılmış) ve bir SOS cihazı (30 sn'de bir SOS;
kuyruğa düşene kadar `GET /status` yoklaması).

| Metrik | Değer | Eşik |
| --- | --- | --- |
| signal → kuyruk (SOS, 20 örnek) | ort 114 ms, p95 **119 ms**, max 131 ms | p95 < 5 sn ✅ |
| `POST /v1/signals` süresi | ort 5,9 ms, p95 8,2 ms, max 16 ms | p95 < 300 ms ✅ |
| HTTP hata oranı | 0 / 460 | 0 ✅ |
| Kontroller | 440 / 440 | %100 ✅ |
| Heartbeat | 400 | |

**Yorum:** Yük çok hafif (yaklaşık 0,7 istek/sn); bu test duman testidir, kapasite testi değildir. 2.000 cihaz ve
20 operatörlük yük testi T-080'dedir. k6 doğrulaması HTTP düzeyindedir (202 cevapları). Kayıpsızlık sayımı kaos
testinde veritabanı üzerinden yapıldı.

**2026-11-16:** Gece koşusu (`load-smoke`) 2026-11-10'dan beri kırmızıydı: T-020 ile `GET /protected-persons/{id}/status`
OIDC ister oldu, k6 yoklaması token'sız 401 alıyordu (HTTP hata %83, "sos kuyrukta" 0/14). Sinyaller etkilenmedi.
Düzeltme: `load-smoke.sh` yerel yığından sahte OIDC operatör token'ı alır (`STACK_PRINT_TOKEN`, süre
`STACK_TOKEN_TTL`) ve k6'ya `OP_AUTH` olarak verir; token yoksa k6 başlamadan durur.

## Testler sırasında bulunan ve düzeltilen hatalar (T-015 commit'i)

- Boştaki Postgres bağlantısı kopunca API süreci çöküyordu (havuzda `error` dinleyicisi yoktu).
- Altyapı kesintisinde API 500 dönüyordu, artık 503 + `Retry-After` dönüyor.
- Docker imajında kural paketi şeması eksikti (imaj açılışta çökerdi).

## Ek bilgi

Bu makinede 5432 portunda projeye ait olmayan bir Postgres çalışıyor. `docker compose -f infra/docker-compose.yml up`
aynı portu kullanacağı için çakışır.
