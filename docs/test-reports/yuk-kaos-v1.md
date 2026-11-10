# T-080 Test raporu: yük ve kaos (v1)

Tarih: 2026-11-10 · Dal: `claude/t080-hardening-0d1255` · Ortam: geliştirici Mac (Apple Silicon, 8 çekirdek, 16 GB),
Node 26, Docker Desktop (2 vCPU / 4 GB VM)

## Özet

| Kabul ölçütü (TASKS-DETAY T-080) | Sonuç |
| --- | --- |
| Kayıp 0 (her yük ve kaos durumunda) | ✅ Yük koşularının hepsinde kabul edilen sinyal = satır = tekil anahtar; gönderilen olay = olay satırı; DLQ 0. Kaos: Redis 60 sn, Postgres, API `kill -9`, CPaaS 500 → kayıp 0, çift 0 |
| Kuyruk toparlanma < 2 dk | ✅ Redis 7,8 sn · Postgres 2,7 sn · API `kill -9` 2,0 sn · CPaaS 500 anında (sonraki "Ara") |
| p95 signal→screen < 5 sn (2.000 cihaz, 20 operatör) | ⚠️ Yerelde 3 dk: **p95 1,01 sn**, 5 dk: **p95 1,12 sn** (TimescaleDB). Tam 30 dk koşu yerelde yapılmadı; CI `load-v1` işi bu PR'da koşar (§4) |

**Önemli sınır:** Ölçüm sırasında makinenin yük ortalaması 48–133 idi (8 çekirdek; aynı makinede Android Studio/Gradle,
Flutter, ffmpeg ve başka oturumların testleri). Gecikme sayıları bu yüzden kötümserdir ve kapasite iddiası değildir.
Kayıpsızlık ve toparlanma sonuçları yükten bağımsızdır.

## 1. Yük senaryosu

Araçlar: `infra/k6/load-v1.js`, `scripts/load-v1.sh` → `apps/api/test/e2e/load-cli.ts`.

| Bileşen | Model |
| --- | --- |
| Cihazlar | 2.000 cihaz × 5 dk'da bir HEARTBEAT (≈ 6,7 istek/sn), sabit varış hızı; her yineleme ayrı cihaz, bağlantı paylaşımı yok |
| Olaylar | 6 olay/dk: %40 SOS, %30 düşme (cevap yok → 60 sn sonra kuyruk), %30 düşme + 5 sn sonra iptal. "500 olay/gün" ortalaması ≈ 0,35/dk; 6/dk yoğun saat + pay (`LOAD_EVENTS_PER_MIN=0.35` gerçek dağılım) |
| Operatörler | 20 operatör: kuyruk WebSocket'i (`/v1/ws/queue`) açık; her yeni kuyruk öğesinde signal→screen ölçülür (tüm ekranlarda); olay kimliğinin özetiyle seçilen operatör 3–15 sn düşünür, üstlenir, "OK" ile kapatır |
| signal→screen | WS'de öğenin ilk görünüşü − başlangıç (cihaz sorusu yoksa `createdAt`, sorulu olayda `escalatedAt`; API'nin `signal_to_screen_seconds` tanımıyla aynı) |
| Kayıp sayımı | k6'nın 202 ile kabul edildi saydığı sinyal = `signal.signal` satırı = tekil `idempotency_key`; gönderilen olay = `event.event` satırı; `event.outbox` birikimi 0; `outbox_dlq` 0 |
| İkinci ölçüm | API'nin kendi `/metrics` histogramı (kova üst sınırı) ve 10 sn'de bir outbox birikimi / en eski satır yaşı |

Yığın: Redis (`redis-server`), API (`tsx src/main.ts`, gerçek kural süreleri), Postgres = `LOAD_TIMESCALE=1` ile
Docker'da `timescale/timescaledb:2.17.2-pg16` + `infra/init.sql` (veya PGlite). k6 0.54 (yerelde Docker imajı).

### 1.1 TimescaleDB, 5 dk (asıl yerel ölçüm)

| Metrik | Değer | Eşik |
| --- | --- | --- |
| signal→screen (22 olay × 20 ekran) | ort 950 ms, medyan 942 ms, **p95 1.120 ms**, p99 1.246 ms, max 1.287 ms | p95 < 5 sn ✅ |
| API `signal_to_screen_seconds` p95 | ≤ 2 sn kovası | ✅ |
| `POST /v1/signals` | medyan 23 ms, **p95 135 ms**, p99 415 ms, max 1,55 sn | p95 < 300 ms ✅ |
| Operatör üstlenme (`POST claim`) | medyan 70 ms, p95 207 ms | |
| HTTP istek / hata | 2.077 / %1,83 (38 "EOF") | 0 ❌ → düzeltildi, bkz. 1.3 |
| Kabul edilen sinyal / satır / tekil anahtar | 2.003 / 2.003 / 2.003 | kayıp 0 ✅ |
| Olay gönderilen / veritabanında | 31 / 31 (27 kapandı, 4 kuyrukta: koşu sonunda kapanmayı bekleyen) | kayıp 0 ✅ |
| Outbox birikimi (10 sn örnek) | en çok 11 satır, en eski 1 sn; koşu bitince 4 ms'de 0 | |
| DLQ | 0 | ✅ |

### 1.2 Önceki yerel koşular (ders çıkarılanlar)

| Koşu | Bulgu |
| --- | --- |
| PGlite, 2 dk (×2) | POST p95 1,8 sn, signal→screen p95 70 sn, hata %1,6. API log'unda `08P01`, `34000`, `26000` (protokol ihlali, geçersiz imleç / hazır ifade): **PGlite soket sunucusu eşzamanlı bağlantılarda bozuluyor.** Kayıp yine 0. PGlite yalnız kaos ve uçtan uca testleri için uygun; yük için `LOAD_TIMESCALE=1` |
| TimescaleDB, 2 dk | Makine aşırı yüklüyken (paralel kaos testi + takılı kalmış önceki API + yük ortalaması ~70) signal→screen p95 70 sn; kayıp 0. Aynı kod 5 dk koşuda p95 1,1 sn → ilk sayı ölçüm ortamının |

### 1.3 Bulunan ve düzeltilen

| Bulgu | Düzeltme |
| --- | --- |
| %1,8 `EOF` / "server closed idle connection": Node `http` sunucusu boştaki bağlantıyı 5 sn'de kapatır (`keepAliveTimeout`); istemci aynı anda o bağlantıya yazarsa istek düşer | k6: yinelemeler arası bağlantı paylaşımı kapalı (`noVUConnectionReuse`; her yineleme ayrı cihaz, gerçekçi). **Üretim:** Caddy upstream `keepalive 4s` (`infra/caddy/Caddyfile`); aksi hâlde vekil arkasında ara sıra 502 olurdu |
| `kill -9` tsx sarmalayıcısını öldürüyor, asıl node süreci portu tutmaya devam ediyordu (test altyapısı) | `infra.ts`: süreçler ayrı grupta, SIGKILL tüm gruba; zarif kapanış 20 sn'de bitmezse grup öldürülür |

DOĞRULAMA_3M

## 2. Kaos (`pnpm --filter @yanimda/api test:e2e`, CI `e2e` işi)

Kural süreleri 0,1 ölçekli (FALL penceresi 6 sn); Redis ve Postgres (PGlite) gerçek süreçler, durdur/başlat.

| Durum | Ölçüm | Değer |
| --- | --- | --- |
| **Redis 60 sn kapalı** | kesintide gelen FALL kuyruğa | 6,5 sn (pencere 6 sn; yerel yedek zamanlayıcı) |
| | Redis'le kaybolan işin kurtarılması | 11,6 sn |
| | kesintide 11 sinyal | 11 satır, 11 tekil anahtar; tekrar `duplicates: 1` |
| | Redis dönünce yeni FALL | 7,6 sn |
| | **kuyruk toparlanması** (Redis dönüşü → outbox birikimi 0) | **7,8 sn** |
| **Postgres kapalı** (yönetilen failover'ın yerel benzeri) | kesinti | 11,6 sn |
| | kesintide `GET /v1/queue` | 503, `Retry-After: 2` |
| | 40 sinyal (biri kesinti ortasında SOS) | 40 satır, 40 tekil anahtar: kayıp 0, çift 0; cihaz 7 yeniden deneme |
| | Postgres dönüşü → cihaz tamponu boş | 2,2 sn |
| | **kuyruk toparlanması** | **2,7 sn** |
| **API `kill -9`**, 5 sn sonra yeniden başlatma (yeni) | kesinti (öldürme → yeni süreç dinliyor) | 9,1 sn |
| | 40 sinyal (biri kesintide SOS) | 40 satır, 40 tekil anahtar: kayıp 0, çift 0 |
| | yeniden başlama → cihaz tamponu boş | 1,5 sn |
| | yeniden başlama → SOS kuyrukta | 1,6 sn |
| | **kuyruk toparlanması** | **2,0 sn** |
| **CPaaS 500** (yeni, `test/cpaas-chaos.spec.ts`) | "Ara" | hata fırlatmaz; arama `failed` (`Twilio HTTP 500`), olay operatörde `CONTACT_CHAIN` |
| | kesintide yeni SOS | `OPERATOR_QUEUE` (sinyal yolu CPaaS'tan bağımsız) |
| | CPaaS dönünce aynı adım | yeni arama satırı, sağlayıcı kimliği yazıldı; numara audit / hata alanında yok |

Not (API `kill -9`): outbox kirası 30 sn'dir. Yerel testte yeni süreç aynı sahip kimliğiyle kirayı hemen geri aldı (2 sn).
Farklı ana makine adlı bir kopya devralırsa toparlanma kira süresi kadar (≤ 30 sn) uzar; yine < 2 dk.

## 3. PII

Uçtan uca + kaos API log'ları ve yük koşularının log'ları `apps/api/test/e2e/pii-audit-cli.ts` ile tarandı: **0 bulgu**
(telefon, TC kimlik, e-posta, token, adres, koordinat, tıbbi terim). CI'da `e2e`, `console-e2e`, `security` ve
`load-v1` işlerinde aynı denetim koşar (T-081).

## 4. Gerçek ortamda denenmeyenler

- **30 dk tam koşu temiz donanımda:** CI `load-v1.yml` (yük araçları değişen PR'da, haftalık, elle) GitHub koşucusunda
  yerel k6 + Docker TimescaleDB ile koşar ve `load-v1.json`'ı artefakt olarak yükler. Bu raporun p95 satırı o koşuyla
  güncellenmeli.
- **Yönetilen Postgres failover** (çoklu AZ geçişi): yerelde süreç durdur/başlat ile benzetildi; gerçek failover'da
  bağlantı havuzunun yeni birincile geçişi staging'de (T-083) denenmeli.
- **Üretim imajı:** API `tsx` ile koştu (derlenmiş `dist/` değil); cihazlar simülatör modunda token'sız
  (`SIMULATOR_ENABLED`); gerçek cihaz token doğrulaması (T-041) yükte yok.
- **Yönetilen Redis / gerçek CPaaS (Twilio):** CPaaS 500 sahte HTTP ile; Redis yerel süreç.
- **WebSocket ölçeği:** 20 operatör tek API kopyasında; çok kopyada Redis pub/sub dağıtımı yükte denenmedi.

## 5. Risk ve öneriler (uygulama kodu bu PR'da değişmedi)

- **Outbox tek işçi, genel FIFO:** her heartbeat de outbox'a yazılıyor ve tek işçi satırları id sırasıyla işliyor;
  başarısız satır arkasındakileri bekletiyor (`outbox.worker.ts`). Bu yükte birikim en çok 11 satırdı, sorun yok; ama
  işçi yavaşlarsa veya bir heartbeat satırı tekrar tekrar düşerse SOS heartbeat'lerin arkasında bekler. Sıra yalnız
  kişi başına gerekli: kişiye göre bölümleme veya SOS/FALL için öncelikli şerit önerilir (Kafka v2.0'a kadar).
- **Node `keepAliveTimeout`:** API vekilin boşta bekleme süresinden uzun tutmalı (ör. 65 sn) ya da vekil < 5 sn
  bırakmalı (Caddy'de yapıldı). Doğrudan bağlanan istemciler için API tarafında da ayar önerilir.
- **Ayrı sağlık ucu yok:** yük betiği ve compose sağlık kontrolü `GET /v1/queue` 401'ine bakıyor; `/health` ve
  `/ready` önerilir (T-083 takip).
