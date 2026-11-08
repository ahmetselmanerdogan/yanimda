# 07 · Görev Kitabı — adım adım uygulama (v1.0)

Her görev tek başına yapılabilir, test edilebilir ve geri alınabilir bir PR'dır. Biçim: **Amaç · Adımlar · Dosyalar · Kabul/Test · Bağımlılık**. Kimlikler PRD'ye (02), teknik kararlar 03'e, ekranlar 04'e, prosedürler 05'e bağlıdır.

## Basit ama sağlam: v1.0 teknoloji sadeleştirmesi
03 numaralı dokümandaki mimari korunur, ancak v1.0'da işletme yükünü düşürmek için şu sadeleştirmeler geçerlidir (03'ü bu kadarıyla günceller):

| Konu | 03'teki seçim | v1.0 kararı | Neden sağlam kalır |
| --- | --- | --- | --- |
| Olay akışı | Kafka/Redpanda | **Postgres outbox tablosu + BullMQ (Redis) işçileri** | Sinyal önce aynı transaction'da `signal.signal` + `outbox` tablosuna yazılır; işçi outbox'ı okuyup işler; kayıp sıfır, tek veritabanı yedeği yeter. Kafka v2.0'da (çok ülke, yüksek hacim) eklenir; `Bus` arayüzü aynı kalır |
| Kimlik | Keycloak | **Keycloak (dev'de docker, prod'da yönetilen)**; alternatif Auth0 | Değişmedi; ama v1.0'da yalnız 2 realm: `consumers`, `operations` |
| Aile uygulaması | Flutter veya RN | **Flutter** (tek karar) | Tek kod tabanı, arka plan kritik değil |
| Konsol | React + Vite | Değişmedi | |
| Telefoni | Twilio + TR SIP trunk | Değişmedi; **sahte CPaaS** geliştirmede zorunlu | |
| Konum/harita | Google Maps | Değişmedi | |
| Bulut | K8s + Terraform | **v1.0 beta: tek VM/VPS + docker compose (prod profili) + yönetilen Postgres**; K8s Faz 3 | 200–2.000 abone için yeterli; Terraform yalnız VM, DNS, DB için |

Sağlamlık kuralları her görevde geçerlidir: olay kaybı sıfır (outbox), idempotency, her geçiş kayıtlı, her görevde test, PII loglanmaz, mesajlar katalogdan, hata biçimi RFC 7807, sağlık verisi şifreli.

## Çalışma ritmi
1. Görevi `FIRST-CLAUDE-CODE-PROMPT.md` şablonuyla ver; bu kitaptaki adımları istemin "Yapılacak" bölümüne kopyala.
2. Claude Code önce test yazar, sonra kod; `pnpm test` ve `pnpm typecheck` yeşil olmadan PR açılmaz.
3. PR açıklamasında: görev kimliği, kabul kriterleri ve karşılayan testlerin adı.
4. Görev bitince TASKS.md'de kutuyu işaretle, CHANGELOG'a satır ekle.
## Epik 0 · Temel (S0) — tamamlama görevleri

### T-001b Kod kalitesi araçları
- **Amaç:** Tüm paketlerde tek lint/format standardı.
- **Adımlar:** (1) Kökte `eslint.config.js` (flat config, typescript-eslint, import sırası), `.prettierrc` (singleQuote, 120 kolon). (2) `apps/api` ve `packages/*` için `lint` ve `typecheck` script'leri. (3) Husky + lint-staged pre-commit: prettier + eslint --fix. (4) `commitlint` ile `<alan>(<PRD-id>): <özet>` biçimi zorunlu.
- **Dosyalar:** eslint.config.js, .prettierrc, .husky/pre-commit, commitlint.config.js, package.json.
- **Kabul:** `pnpm lint` temiz; hatalı commit mesajı reddedilir.

### T-007 CI tamamlama
- **Adımlar:** (1) ci.yml'ye lint, typecheck, test, build adımları. (2) Docker imajı build (apps/api Dockerfile, çok aşamalı, node:20-alpine). (3) Trivy imaj taraması, yüksek/kritik açıkta fail. (4) PR'da `pnpm --filter @yanimda/rules test` (kural paketi doğrulaması) zorunlu.
- **Dosyalar:** .github/workflows/ci.yml, apps/api/Dockerfile, .dockerignore.
- **Kabul:** PR'da tüm adımlar yeşil; imaj < 250 MB.

### T-008 Yerel geliştirme deneyimi
- **Adımlar:** (1) `pnpm dev` ile api + (ileride) konsol. (2) `scripts/dev-up.sh`: docker compose up, Keycloak realm import (`infra/keycloak/realms.json`), seed. (3) `scripts/seed.ts`: 3 demo kişi, 2 cihaz, yakın zinciri, 1 operatör. (4) README'ye 5 dakikalık başlangıç.
- **Kabul:** Temiz makinede `scripts/dev-up.sh` sonrası simülatör `fall --no-cancel` → `GET /v1/queue` olayı gösterir.

## Epik 1 · Olay motoru (S1)

### T-010 Sinyal alımı kalıcı (D-01)
- **Amaç:** Her sinyal veritabanına ve outbox'a tek transaction'da yazılsın; kayıp sıfır.
- **Adımlar:** (1) `apps/api` içine Drizzle ORM (veya Prisma) ekle; `infra/init.sql` şemasını migration'a çevir (`drizzle/`). (2) `signal.signal` + `event.outbox(id, topic, envelope jsonb, created_at, processed_at null)` tabloları. (3) `SignalService.accept`: şema doğrulama → Redis `SET idem:<key> 1 NX EX 86400` → transaction: signal insert + outbox insert (`signal.received`). (4) `OutboxWorker` (BullMQ repeat job her 1 sn veya LISTEN/NOTIFY): processed_at null satırları sırayla `Bus.publish` ile iç abonelere ver, işaretle; hata → 5 deneme sonra `outbox_dlq`. (5) `common/bus.ts` arayüzü aynı; uygulama `OutboxBus` oldu. (6) Cihaz `last_seen_at`, `battery_pct`, `on_wrist` güncelle (device modülü yoksa signal içinde geçici).
- **Dosyalar:** apps/api/src/db/*, src/modules/signal/*, src/common/outbox.worker.ts, drizzle/migrations/*.
- **Kabul/Test:** Testcontainers (Postgres+Redis): 1 sinyal → 1 signal satırı + 1 outbox satırı; işçi çalışınca EventService'e ulaşır; aynı key → duplicates=1; işçi öldürülüp yeniden başlatılınca kayıp yok (10 sinyal/10 olay).
- **Bağımlılık:** T-008.

### T-011b Olay ve geçiş kalıcılığı (D-10)
- **Adımlar:** (1) `EventRecord` → `event.event` + `event.transition` tablolarına yaz; bellek içi Map kaldır. (2) `transition()` tek transaction: event state update + transition insert + outbox (`event.transitioned`). (3) `openBySubject` yerine sorgu: `state NOT IN (CLOSED)` ve aynı kişi. (4) Audit: `audit.log` append-only; INSERT dışında yetki yok (DB rolü).
- **Kabul:** flow.spec.ts Testcontainers ile aynı sonuç; `UPDATE audit.log` yetki hatası verir.

### T-012 Kural paketi ve olay üretimi tamamlama (D-02)
- **Adımlar:** (1) `RulesService`: `packages/rules/<ülke>.yaml` yükle, JSON Schema ile doğrula, `chain.procedure_template` tablosuna sürümle kaydet; `POST /v1/admin/rules/reload` (yönetici) ile sıcak yükleme. (2) Sinyal → olay eşlemesi tamamlansın: BATTERY ≤20 → BATTERY_LOW (yalnız bildirim), ≤10 → aileye F-BAT-10, cihaz kapanınca (HEARTBEAT yok + son pil ≤5) 2 saat sonra BATTERY_DEAD olayı; INACTIVITY değeri eşiği aşınca olay; OFF_BODY → WATCH_OFF (gece penceresinde bastır); HEARTBEAT boşluğu 15 dk → cihaz "bağlantı yok", 6 saat → CONNECTION_LOST. (3) Aynı kişi için açık olay varken yeni sinyal: SOS gelirse mevcut olayın önceliğini 1'e çek ve nota ekle; diğerleri sinyal olarak eklenir. (4) `isTest` olaylar 112 adımı olmadan şablon alır.
- **Kabul:** Kural tablo testi: her sinyal türü için beklenen olay/olay yok; sıcak yükleme sonrası yeni pencere süresi uygulanır.

### T-013 Zamanlayıcılar BullMQ (D-09)
- **Adımlar:** (1) `TimersService`: BullMQ `delayed` işler: `prompt-expire`, `silent-ask-expire`, `watch-off-remind`, `watch-off-operator`, `battery-dead`, `connection-lost`, `follow-up`. (2) İş kimliği = `<olayId>:<tür>` (idempotent; iptalde `remove`). (3) İşçi, olay durumunu DB'den okur, hâlâ beklenen durumdaysa geçiş yapar (yarış koşulu güvenli). (4) Uygulama yeniden başlasa da işler Redis'te kalır (persist).
- **Kabul:** Test: FALL oluştur → süreç yeniden başlat → 60 sn sonra yine ESCALATED; CANCEL iş siler.

### T-014 Koruma durumu ve gece penceresi (D-05)
- **Adımlar:** (1) `event.protection_state` yönetimi: ON_BODY→PROTECTED_WATCH; OFF_BODY→(gece penceresi içindeyse NIGHT, değilse PROTECTED_PHONE); telefon da yoksa UNPROTECTED. (2) Gece penceresi: `event.threshold.sleep_start/sleep_end` (varsayılan 22:00–08:00, kişi saat dilimi). (3) Her değişiklik outbox `user.protection.changed` → aile bildirimi (katalog). (4) `GET /v1/protected-persons/{id}/status` döner.
- **Kabul:** Saat dilimi testi (Europe/Istanbul, America/New_York); OFF_BODY 23:00 → NIGHT, 14:00 → PROTECTED_PHONE.

### T-015 Cihaz adaptörü arayüzü
- **Adımlar:** (1) `DeviceAdapter` arayüzü (03) ve `AdapterRegistry`. (2) `SimulatorAdapter`, `WearOsAdapter` (normalize no-op, promptUser → FCM data mesajı, ring → FCM yüksek öncelik), `AndroidPhoneAdapter`. (3) `POST /v1/signals` gelen `deviceId`'nin türüne göre adaptör seçer.
- **Kabul:** Her adaptör için normalize/capabilities birim testi.

### T-016 Entegrasyon testi ve yük duman testi
- **Adımlar:** (1) Testcontainers: Postgres+Redis+API; simülatör senaryoları S3, S4, S7 koşturulur, beklenen geçiş listeleri doğrulanır. (2) k6 duman: 200 cihaz × 5 dk heartbeat 10 dk; p95 `signal→queue` < 5 sn, hata 0. (3) Kaos: Redis 30 sn kapat → işler tekrar çalışır; Postgres 10 sn kapat → API 503 döner, cihaz tamponlar (simülatör yeniden dener), kayıp 0.
- **Kabul:** CI'da entegrasyon; k6 ve kaos raporu docs/test-reports/'a.
## Epik 2 · Operatör konsolu çekirdek (S2)

### T-020 Kimlik ve erişim (E-01)
- **Amaç:** Operatör MFA ile girer; her istek rolüyle yetkilendirilir; cihazlar ayrı token alır.
- **Adımlar:** (1) Keycloak realm'leri `infra/keycloak/realms.json`: `consumers` (ELDER, FAMILY), `operations` (OPERATOR, SUPERVISOR, ADMIN); operations'ta OTP zorunlu. (2) API'de `OidcGuard` (JWKS doğrulama, realm/rol kontrolü) ve `@Roles()` dekoratörü; cihaz token'ı için ayrı `DeviceTokenGuard` (T-041). (3) Konsol: `oidc-client-ts` ile PKCE giriş, 12 saat oturum, sessiz yenileme. (4) `X-Operator-Id` başlığı kaldırılır; operatör kimliği token'dan.
- **Dosyalar:** infra/keycloak/realms.json, apps/api/src/modules/identity/*, apps/console/src/auth/*.
- **Kabul:** Token'sız `GET /v1/queue` 401; FAMILY rolü 403; OTP olmadan operations girişi reddedilir.

### T-021 Prosedür ve zincir (D-03, D-04)
- **Adımlar:** (1) 05'teki olay tipi tablosunu `packages/rules/procedures.tr.yaml` olarak yaz: her tip için adım listesi (kind, label, scriptRef, timeoutSec, required). (2) `chain` modülü: olay OPERATOR_ASSIGNED olunca `chain_run` + `chain_step` satırları üretilir. (3) `POST /v1/events/{id}/chain/steps/{n}/result` (REACHED | NO_ANSWER | BUSY | WRONG_NUMBER | SKIPPED + note); sıra zorunlu, SKIPPED gerekçe ister. (4) `POST /v1/events/{id}/escalate-112` kısayolu: gerekçe zorunlu, kalan adımlar SKIPPED(reason=escalate) olur. (5) Operatör kilidi Redis `SET lock:<olay> <op> NX EX 300`; her istekte uzatılır; kilit düşerse olay OPERATOR_QUEUE'ya döner ve amir uyarısı outbox'a. (6) Adım sonuçları olay geçişlerini tetikler: herhangi bir adımda "kullanıcı iyi" → CONFIRMED_OK; 112 adımı → CONFIRMED_EMERGENCY→DISPATCH.
- **Kabul:** Şablon testi: her olay tipi için adım sayısı ve sırası; sıra dışı sonuç 409; kilit süresi dolunca kuyruğa dönüş testi (fake timers).

### T-022 Canlı kuyruk (E-02)
- **Adımlar:** (1) `GET /v1/queue` sayfalı, öncelik → yaş sıralı, `lockedBy` dahil. (2) WebSocket `/v1/ws/queue` (socket.io veya ws): `event.created/transitioned` outbox mesajlarını operasyon odasına yayınla; yeniden bağlanınca tam liste. (3) `POST /v1/events/{id}/claim` 409 çakışma; `POST /unclaim` (amir).
- **Kabul:** İki istemci aynı olayı aynı anda üstlenmeye çalışır → biri 200 biri 409; WS'de 1 sn içinde yeni olay görünür.

### T-023 Konsol arayüzü (E-03, E-04, E-08, E-10)
- **Adımlar:** (1) `apps/console`: Vite + React + TS; tokens `packages/ui-tokens`; koyu tema varsayılan. (2) Düzen 04'teki gibi: üst bar, kuyruk (240 px), olay kartı, kişi paneli (260 px), telefon barı (yer tutucu). (3) Bileşenler: QueueRow, EventCard (SLA sayaçları canlı), StepRow (Ara/sonuç/not), ScriptPanel (05 script'leri `packages/rules/scripts.tr.json`'dan), ClosePanel. (4) Klavye: Enter üstlen, A ara, 1–5 sonuç, N not, C kapat, Ctrl+1 112. (5) Yeni olay ses uyarısı (tip bazlı ses dosyaları) ve üst bar yanıp sönme. (6) Kişi paneli tıbbi özet yalnız olay açıkken `GET /v1/events/{id}` ile gelir; kopyalama engeli (CSS user-select none + uyarı).
- **Kabul:** Playwright: giriş → simülatör olayı → Enter → adım 1 "cevap yok" → adım 2 açılır → C ile kapat → kuyruktan düşer; erişilebilirlik: axe ciddi hata 0.

### T-024 Kapatma ve 112 şablonu (E-06, E-07)
- **Adımlar:** (1) Kapatma formu: sonuç zorunlu, not ≤ 2000, takip aramasını planla (varsayılan 24 saat, EMERGENCY'de zorunlu). (2) 112 şablonu `GET /v1/events/{id}/script?kind=dispatch112` ülke paketinden doldurulur (adres, yaş, hastalık, ilaç, alerji, kapı notu); kopyala butonu; okundu zaman damgası chain_step'e. (3) FOLLOW_UP olayı T-013 zamanlayıcısıyla üretilir ve kuyruğa P4 düşer.
- **Kabul:** EMERGENCY kapatınca 24 saat sonra FOLLOW_UP olayı oluşur (fake timers); şablon tüm alanları doldurur, boş alan "bilinmiyor".

### T-025 SLA ve metrikler (E-09, D-11)
- **Adımlar:** (1) Prometheus `prom-client`: `signal_to_screen_seconds` (histogram), `operator_claim_seconds`, `event_decision_seconds`, `queue_depth`, `false_alarm_ratio`. (2) Olay kartında sayaçlar: olay yaşı, üstlenmeye kalan (10 sn), ilk aramaya kalan (20 sn). (3) `GET /v1/supervisor/dashboard` özet; `/metrics` uç noktası (iç ağ).
- **Kabul:** Metrikler sentetik testte artar; Grafana panosu JSON `infra/grafana/konsol.json`.

### T-026 Konsol uçtan uca ve eğitim modu
- **Adımlar:** (1) Playwright senaryoları: S3, S4, S5 (SOS konuşabilen, sahte CPaaS), S6 (sessiz hat → Ctrl+1). (2) Eğitim modu: `?training=1` ile sahte olaylar üreten yerel mod; gerçek API'ye yazmaz (05 tatbikat).
- **Kabul:** CI'da 4 senaryo yeşil; eğitim modu üretimde kapalı.
## Epik 3 · Wear OS saat uygulaması (S3) — repo `yanimda-android`

### T-030 Proje ve test modu
- **Adımlar:** (1) Gradle çok modül: `watch`, `phone`, `core` (sinyal şeması, HTTP, kripto, log maskeleme). (2) `watch`: Compose for Wear, Health Services, Tiles, Complications, Room, WorkManager, Wearable Data Layer. (3) Gizli test menüsü: tile'da 5 sn basılı tutma → "Sahte düşme", "Sahte SOS", "Sinyal kuyruğunu göster"; yalnız `BuildConfig.DEBUG` veya aile uygulamasından açılan `testMode` bayrağıyla. (4) `core` içinde `Signal` veri sınıfı `packages/contracts/schemas/signal.schema.json` ile birebir; kotlinx.serialization.
- **Kabul:** Emülatör + gerçek Galaxy Watch'ta derlenir; test menüsü sahte FALL sinyalini kuyruğa yazar.

### T-031 Düşme algılama ve soru ekranı (A-02, A-03)
- **Adımlar:** (1) `PassiveListenerService` ile `HealthEvent.Type.FALL_DETECTED`; izin `BODY_SENSORS`, `ACTIVITY_RECOGNITION`. (2) Olay anında `PromptActivity` tam ekran (ekran kapalıysa uyandır, `setShowWhenLocked`, `setTurnScreenOn`): "Düşme algılandı. İyi misiniz? İyiyseniz dokunun." (katalog W-FALL-1), CountdownRing 60 sn, büyük İYİYİM. (3) Titreşim 5 sn'de bir (3 kısa), TTS her 15 sn (TextToSpeech, maksimum ses, `AudioAttributes.USAGE_ALARM`). (4) Dokunma → CANCEL sinyali (aynı `sourceSignalId` payload'da); süre dolunca FALL sinyali `payload.unconfirmed=true` ile anında gönderilir (not: FALL sinyali olay anında da gönderilir; sunucu 60 sn'yi kendi sayar, CANCEL gelmezse yükseltir — çevrimdışı güvenliği için). (5) Ekran kapanırsa bildirim kanalı `ALARM` ile tekrar açılır.
- **Kabul:** Test modu: sahte düşme → 60 sn → sunucuda ESCALATED; dokununca CANCEL; uygulama kapalıyken `PassiveListenerService` çağrılır (adb ile servis öldür testi).

### T-032 SOS (A-01)
- **Adımlar:** (1) Tile/kadran: kırmızı YARDIM butonu, 3 sn basılı tutma (halka animasyonu, `pointerInput` ile süre ölçümü), titreşim onayı. (2) Fiziksel tuş: `KeyEvent` 3× 2 sn içinde (cihaz desteği varsa; `WearableButtons`). (3) SOS ekranı: W-SOS-1; iptal yok. (4) Sinyal SOS, konum anlık GPS (`FusedLocationProvider`, 10 sn zaman aşımı, yoksa son konum).
- **Kabul:** 1 sn dokunma SOS üretmez; 3 sn üretir; sinyal 2 sn içinde telefona ulaşır (log zaman damgası).

### T-033 Hareketsizlik (A-04)
- **Adımlar:** (1) `WorkManager` 5 dk periyodik: son 5 dk ivmeölçer varyansı + adım farkı; `core`'da `InactivityTracker` (son hareket zamanı). (2) Eşik `config`'ten (varsayılan 30 dk); bilekte değilse sayma. (3) Eşik aşımında sessiz soru ekranı (W-INACT-1, titreşim yok sadece ekran 120 sn); cevap → OK sinyali; cevapsız → INACTIVITY sinyali (value=dk).
- **Kabul:** Emülatörde sensör sahteleme ile 30 dk hareketsizlik → sinyal; hareket gelince sayaç sıfırlanır.

### T-034 Bilek, pil, nabız, konum sinyalleri (A-05…A-08)
- **Adımlar:** (1) Off-body: `TYPE_LOW_LATENCY_OFFBODY_DETECT` → OFF_BODY/ON_BODY. (2) Pil: `BatteryManager` yayınları; %20 ve %10'da BATTERY sinyali + W-BAT-20/10 ekran ve titreşim (2 kısa). (3) Nabız: Health Services `PassiveMonitoring` HEART_RATE_BPM 5 dk ortalama → HEARTBEAT payload; SOS/FALL'da anlık. (4) Konum: 15 dk düşük güç (telefon konumu tercih), olayda GPS.
- **Kabul:** Her sinyal türü simülatör formatında sunucuya düşer; pil ölçümü 24 saatte uygulama payı < %10 (Battery Historian raporu docs/test-reports/).

### T-035 Kalıcı kuyruk ve iletim (A-09)
- **Adımlar:** (1) Room `signal_queue` (id, json, createdAt, attempts, sentAt). (2) `Transport`: önce Wearable `MessageClient` (telefon), 3 sn cevap yoksa LTE/Wi‑Fi ile doğrudan `POST /v1/signals` (cihaz token'ı T-041). (3) Üstel geri çekilme (2, 4, 8… 300 sn), `WorkManager` ağ kısıtıyla yeniden deneme; sıra korunur. (4) SOS/FALL öncelikli (kuyruk başına), HEARTBEAT toplu (10'lu). (5) Telefon tarafı alıcı (T-043) aynı JSON'ı iletir.
- **Kabul:** Uçak modunda 10 sinyal → kuyruk; mod kapanınca sırayla teslim; sunucu duplicates=0.

### T-036 Tile, komplikasyon, durum (A-11, A-13)
- **Adımlar:** (1) Tile: durum satırı (yeşil/amber/gri + tek kelime), YARDIM, ikinci sayfada "Beni arayın" (CALLBACK_REQUEST). (2) Komplikasyon: küçük ikon + renk; dokununca tile. (3) Durum kaynağı: telefon bağlantısı, bilek, pil, son başarılı gönderim.
- **Kabul:** Tile Wear OS 3.5+ cihazlarda eklenir; durum 30 sn içinde güncellenir.

### T-037 Gelen arama ve otomatik cevap (A-10)
- **Adımlar:** (1) LTE modelde operatör numarası `InCallService` ile tam ekran "Yanımda · <operatör>" ve CEVAPLA (katalog W-CALL-1); 10 sn sonra otomatik cevap (config). (2) BLE modelde arama telefona gelir; saat titreşir ve "Telefonunuzu açın" gösterir. (3) Hoparlör ve ses maksimum.
- **Kabul:** Sahte CPaaS'tan gelen çağrı ekranı 2 sn içinde; otomatik cevap süresi aile ayarından değişir.

## Epik 4 · Eşlikçi Android ve profil (S4)

### T-040 Profil modülü (C-02, C-03, C-04)
- **Adımlar:** (1) Tablolar: protected_person, family_member, contact_chain, health.medical_summary (AES-256-GCM alan şifreleme, anahtar KMS/`.env` dev), subscription. (2) Uç noktalar: `POST/GET/PATCH /v1/protected-persons`, `PUT /{id}/medical` (rıza zamanı zorunlu), `PUT /{id}/contacts` (sıralı, 1–5), `POST /{id}/invite` (6 haneli kod, 15 dk, SMS katalog metni). (3) Adres doğrulama: Google Geocoding ile lat/lng; `door_access_note` şifreli. (4) Yetki: FAMILY yalnız kendi korunan kişilerini görür (sahiplik kontrolü).
- **Kabul:** Şifreli alanlar DB'de düz metin değil; başka ailenin kişisi 404; davet kodu 15 dk sonra geçersiz.

### T-041 Cihaz kaydı ve yapılandırma
- **Adımlar:** (1) `POST /v1/devices/enroll` (davet kodu + cihaz bilgisi) → uzun ömürlü cihaz token'ı (JWT, 1 yıl, `deviceId` claim) + yenileme. (2) `DeviceTokenGuard`. (3) `GET /v1/devices/{id}/config`: eşikler, uyku penceresi, TTS metinleri (katalog), otomatik cevap süresi, test modu; ETag. (4) Push token kaydı (`PUT /devices/{id}/push-token`).
- **Kabul:** Yanlış kod 400; token iptali (aile "cihazı kaldır") sonrası 401; config ETag 304.

### T-042 Eşlikçi kurulum sihirbazı (B-01, B-02)
- **Adımlar:** (1) `phone` modülü: deep link `yanimda://invite/<kod>` ve App Links; Play Store yönlendirme sayfası. (2) 04'teki 7 ekran: hoş geldiniz (TTS otomatik), bildirim, konum (iki aşamalı arka plan), pil optimizasyonu muafiyeti (ayara git ve dönüşte kontrol), saat bağlantısı (Galaxy Wearable ile `CapabilityClient` kontrolü, saat uygulamasını Play'den yükleme isteği), test, eksik izin ekranı. (3) Her ekran tek buton, ≥ 56 dp, 22/28 sp; `packages/ui-tokens`. (4) Kurulum ilerlemesi `PATCH /v1/devices/{id}/setup-state` ile aile uygulamasına.
- **Kabul:** 5 yaşlı kullanıcı testinde yardım almadan tamamlama ≥ 4/5; eksik izinde aileye P-PERM bildirimi.

### T-043 Saat köprüsü ve tampon (B-03)
- **Adımlar:** (1) `WearableListenerService` ile saatten mesaj al, Room tamponuna yaz, `POST /v1/signals` ile gönder (toplu, 2 sn pencere). (2) Konum zenginleştirme: saatte konum yoksa telefon konumu ekle (`source: PHONE`). (3) Teslim onayı saate geri gönderilir (saat kuyruğundan düşer).
- **Kabul:** Saat → telefon → API gecikmesi < 2 sn (log); telefon çevrimdışıyken tampon, dönünce teslim.

### T-044 Ana ekran, kalıcı servis, koruma ve gece modu (B-04, B-05, B-06, B-09)
- **Adımlar:** (1) `ForegroundService` (kalıcı bildirim "Yanımda sizi koruyor", `FOREGROUND_SERVICE_HEALTH`), cihaz yeniden başlatınca otomatik başlat (`BOOT_COMPLETED`). (2) Ana ekran 04'e göre: StatusBanner, operatör adı, YARDIM (3 sn), Beni arayın, aile kısayolu. (3) Koruma modu: saat OFF_BODY/bağlantı yok/pil bitti bilgisi gelince telefon `ActivityRecognition` + ivmeölçer hareketsizlik ve SOS devrede; sunucu `protection_state` ile senkron. (4) Gece modu: config'ten pencere; ekran "Telefonunuz sizi koruyor". (5) Uygulama kapatılırsa (kullanıcı kaydırırsa) servis 1 dk içinde yeniden başlar (WorkManager), olmazsa sunucu 15 dk'da bağlantı kaybı.
- **Kabul:** Saat çıkarılınca 30 sn içinde banner amber; 2 saat sonra P-WATCH-OFF-2H; servis öldürülünce yeniden başlar (adb testi).

### T-045 Uçtan uca cihaz testi
- **Adımlar:** (1) Cihaz laboratuvarı listesi ve test protokolü `docs/test-reports/e2e-protokol.md`. (2) 20 tekrar sahte düşme → konsol; p95 < 5 sn. (3) Pil 24 saat raporu saat + telefon.
- **Kabul:** Rapor docs/test-reports/'ta; Kapı 2 girdisi.
## Epik 5 · Telefoni ve bildirim (S5)

### T-050 CPaaS giden arama ve kayıt (E-05)
- **Adımlar:** (1) `telephony` modülü: `CpaasProvider` arayüzü (`call`, `conference`, `hangup`, `sendSms`, `tts-call`); uygulamalar `TwilioProvider`, `FakeProvider` (dev/test; webhook'ları kendisi tetikler). (2) `POST /v1/events/{id}/chain/steps/{n}/call`: kayıt=on, statusCallback `/v1/webhooks/cpaas`, `telephony.call` satırı; webhook imza doğrulama (Twilio `X-Twilio-Signature`). (3) `recording-ready` webhook: dosyayı indir → S3 (`recordings/<ülke>/<olay>/<call>.mp3`, nesne kilidi) → Twilio'dan sil → `recording_ref`. (4) Arama durumu (ringing/answered/no-answer/busy) chain_step sonucunu otomatik önerir, operatör onaylar. (5) Anons: aranan tarafa "Bu görüşme kaydedilmektedir" (TwiML `<Say>` önce).
- **Kabul:** FakeProvider ile tam akış testi; Twilio sandbox'ta 1 gerçek arama; kayıt S3'te, Twilio'da yok; webhook imzası bozuksa 403.

### T-051 Konsol yazılım telefonu
- **Adımlar:** (1) Twilio Voice JS SDK (WebRTC): `GET /v1/telephony/token` (kısa ömürlü capability token, operatör kimliği). (2) Telefon barı: durum, süre, beklet, konferans (aile ekle), kapat; mikrofon izni kontrolü girişte. (3) Gelen SOS aramaları (LTE saat → CPaaS numarası) `TaskRouter` veya basit kuyruk: müsait operatöre yönlendir, IVR bekletme anonsu.
- **Kabul:** İki operatörle test: gelen arama müsait olana düşer; konferansa aile eklenir; ses kaydı olay kaydında.

### T-052 Türkiye numarası ve 112 prosedürü
- **Adımlar:** (1) TR yerel numara: Twilio TR numarası varsa doğrudan; yoksa Netgsm/Verimor SIP trunk → Twilio SIP Domain. (2) 112 aramaları operatör masasındaki sabit hattan (arayan numara doğrulaması); konsol "112'yi sabit hattan arayın" uyarısı ve çağrı sonucu manuel giriş. (3) Numaralar `packages/rules/country.tr.yaml`'da (ana, yedek, 112, 183, 182).
- **Kabul:** Test aramaları TR numarasından; 112 adımı konsolda "manuel" işaretli.

### T-053 Bildirim modülü (D-08)
- **Adımlar:** (1) `notify` modülü: `NotificationChannel` arayüzü (`push`, `sms`, `voice`); FCM HTTP v1, APNs token auth, Twilio SMS/TTS. (2) Şablon motoru `packages/messages` `t()`; kişi adı, adres gibi değişkenler. (3) Kanal yedekliliği: acil olaylarda push + SMS + sesli paralel; bilgi bildirimlerinde push, 10 sn teslim yoksa SMS. (4) `notify.notification` kaydı, teslim raporu webhook'ları. (5) Outbox tüketici: `event.created/transitioned/closed`, `user.protection.changed` → aile bildirimi kuralları (hangi geçişte hangi kod).
- **Kabul:** Her olay geçişi için beklenen bildirim kodu tablo testi; FCM hatasında SMS gönderilir; PII log'da yok.

### T-054 Gelen arama ekranları ve otomatik cevap (A-10, B-07)
- **Adımlar:** (1) Android `phone`: operatör numarası rehbere "Yanımda" olarak eklenir (kurulumda, kullanıcı onayıyla); arama gelince `InCallService` değil, standart arama + otomatik hoparlör (`AudioManager`). (2) Saat T-037 tamamlanır. (3) iOS: CallKit yok, standart arama; otomatik hoparlör yok (bilgi notu).
- **Kabul:** Operatör araması gelince telefon hoparlörde çalar; otomatik cevap yalnız saatte.

## Epik 6 · Aile uygulaması ve web (S6)

### T-060 Web abonelik (C-01)
- **Adımlar:** (1) `apps/family-web` Next.js: 3 adım (paket, hesap+ödeme, uygulamayı indir). (2) iyzico Checkout Form (TR) ve Stripe Checkout (US) sağlayıcı soyutlaması; webhook'lar `/v1/webhooks/payments` imza doğrulamalı → `profile.subscription` durumu. (3) Deneme: ilk olay veya 30 gün; ödeme bekliyor 7 gün koruma; askıda → aileye F-SUB-PAY ve saat/telefonda durum. (4) Keycloak `consumers` hesabı oluşturma (e-posta + telefon doğrulama). (5) İptal tek tık; KVKK aydınlatma ve açık rıza metinleri (hukuk onaylı yer tutucu).
- **Kabul:** Sandbox ödeme → ACTIVE; webhook tekrarları idempotent; iptal → CANCELLED ve koruma kapanır (cihaz config).

### T-061 Aile uygulaması (Flutter) (C-04…C-10)
- **Adımlar:** (1) Flutter projesi `yanimda-family` (ayrı repo), Riverpod, go_router, dio; tokens'tan tema. (2) Ekranlar 04'e göre: giriş (OIDC PKCE), kurulum sihirbazı 6 adım, Ana, Olay bildirimi (tam ekran, canlı adımlar WebSocket), Olaylar, Profil, Ayarlar, Rıza. (3) Push: FCM/APNs; acil bildirimler kritik uyarı (iOS critical alert yetkisi başvurusu; yoksa yüksek öncelik). (4) `GET /{id}/status` 30 sn yenileme; harita Google Maps Flutter. (5) Ayarlar: uyku penceresi, hareketsizlik eşiği (düşük/orta/yüksek → 45/30/20 dk), otomatik cevap süresi, konum paylaşımı.
- **Kabul:** Widget testleri her ekran; entegrasyon: kurulum → davet → test SOS → olay bildirimi görünür.

### T-062 Günlük özet (C-07, B-10)
- **Adımlar:** (1) Gece 00:30 işi: `signal.signal`'dan günlük özet (adım, nabız min/ort/maks, bilekte saat, uyku penceresi tahmini) → `signal.daily_summary`. (2) 20:00 F-DAILY bildirimi (kişi saat dilimi); kapatılabilir. (3) Ana ekranda özet satırı.
- **Kabul:** Özet değerleri test verisiyle doğru; bildirim kapalıysa gönderilmez.

### T-063 Test SOS ve kurulum görüşmesi (C-05)
- **Adımlar:** (1) `POST /{id}/test-sos` → TEST olayı (isTest, P4); konsolda "TEST" etiketi ve 05 kurulum script'i. (2) Aile uygulamasında ilerleme "test tamamlandı" ve operatör notu. (3) Test olayında 112 adımı yok, bildirimler "test" ön ekiyle.
- **Kabul:** Test olayı gerçek metrikleri etkilemez (metrik etiketi `is_test`).
## Epik 7 · Öğrenme modu, yanlış alarm, iOS, amir (S7)

### T-070 Öğrenme modu (D-06)
- **Adımlar:** (1) Kişi oluşturulunca `learning_mode_until = +30 gün`. (2) Günlük iş: son 14 günün özetinden uyku penceresi (bilekte değil + hareketsiz saatlerin modu), uyanma saati (ilk hareket), hareketsizlik p95 (sınırlar 15–90 dk) → `event.threshold` (aile elle değiştirdiyse dokunma). (3) Öğrenme modunda INACTIVITY olayları operatöre düşmeden önce 2. sessiz soru ve otomatik sesli ön eleme (T-072); SOS/FALL değişmez. (4) 30. gün aileye "profil raporu" bildirimi ve uygulamada özet.
- **Kabul:** Sentetik 30 günlük veriyle eşikler beklenen aralıkta; aile override korunur.

### T-071 Yanlış alarm yönetimi (D-07, C-12)
- **Adımlar:** (1) Kapanış sonucu FALSE_ALARM veya kullanıcı CANCEL → `event.false_alarm(person, event, cause)`; cause: USER_CANCEL, OPERATOR, FAMILY_FEEDBACK. (2) Aile uygulamasında olay sonrası "Gerçek miydi?" (C-12) → feedback uç noktası. (3) Kişi bazlı 30 günlük oran; 3. tekrarda F-EVT-OK + eşik önerisi bildirimi ve konsolda "eşik görüşmesi" CALLBACK olayı P4. (4) Amir panosunda oran.
- **Kabul:** 3 iptal → bildirim + CALLBACK olayı; oran metriği doğru.

### T-072 Otomatik sesli ön eleme (D-12)
- **Adımlar:** (1) INACTIVITY ve WATCH_OFF için (asla SOS/FALL): CPaaS TTS araması "Yanımda: iyi misiniz? İyiyseniz 'evet' deyin veya 1'e basın." (2) STT (Google Speech, tr-TR) veya DTMF; "evet/iyiyim/1" → OK sinyali, olay CONFIRMED_OK (SYSTEM); anlaşılmaz/cevapsız → operatör kuyruğu. (3) Her sonuç kayıtlı; yanlış pozitif ölçümü için ilk ay operatör örneklemesi.
- **Kabul:** FakeProvider ile 3 senaryo; gerçek STT'de "evet" tanıma ≥ %95 (10 deneme).

### T-073 iOS eşlikçi
- **Adımlar:** (1) `yanimda-ios/Companion` SwiftUI: davet deep link, izin sihirbazı (bildirim, konum Always, hareket), ana ekran 04'e göre. (2) Arka plan: Significant Location Change + Background Fetch + APNs silent push; `CMMotionActivity` koruma modu; HealthKit arka plan teslimi (nabız, adım) → HEARTBEAT. (3) SOS 3 sn; YARDIM → `POST /v1/signals`. (4) Galaxy Watch köprüsü yok (ürün notu); Apple Watch v1.5.
- **Kabul:** iPhone'da SOS → konsol < 3 sn; uygulama kapalıyken silent push ile uyanma; 24 saat pil < %5.

### T-074 Amir panosu (E-11)
- **Adımlar:** (1) `/supervisor` sayfası: kuyruk derinliği (son 24 saat), operatör kartları (durum, açık olay, ortalama yanıt), SLA ihlalleri, olay dağılımı, yanlış alarm oranı; 5 sn WS yenileme. (2) Eylemler: unclaim, operatör durumu değiştirme, yedek merkeze taşma bayrağı (v2.0'da gerçek).
- **Kabul:** Playwright: ihlal üretilince listede 5 sn içinde.

## Epik 8 · Sertleştirme ve beta (S8)

### T-080 Yük ve kaos
- **Adımlar:** (1) k6: 2.000 cihaz heartbeat (5 dk), 500 olay/gün dağılımı, 20 operatör; 30 dk. (2) Kaos: Redis 60 sn kapalı, Postgres failover (yönetilen), API yeniden başlatma, CPaaS 500 döndürme; her durumda olay kaybı 0 ve kuyruk toparlanma süresi ölçülür. (3) Rapor docs/test-reports/yuk-kaos-v1.md.
- **Kabul:** p95 signal→screen < 5 sn; kayıp 0; toparlanma < 2 dk.

### T-081 Güvenlik
- **Adımlar:** (1) Semgrep + ZAP baseline CI; Dependabot; imaj imzalama (cosign). (2) Mobil: sertifika sabitleme (OkHttp `CertificatePinner`, iOS `URLSession` pinning), root/jailbreak uyarısı (engel değil). (3) PII denetimi: log maskeleme testi (ad, telefon, adres asla); `health` şema erişimi yalnız `event` ve `console` rolü, zamanla sınırlı. (4) Sırlar KMS/Vault; `.env` üretimde yok. (5) OWASP ASVS L2 kontrol listesi docs/security/asvs-l2.md; dış sızma testi planı.
- **Kabul:** Kontrol listesi ≥ %90; kritik bulgu 0.

### T-082 Erişilebilirlik ve kullanıcı testi
- **Adımlar:** (1) 04 kontrol listesi otomasyonu (axe web, Accessibility Scanner Android, Xcode Accessibility Inspector). (2) 5 yaşlı + 5 aile ile protokol (04); kritik görevler %100. (3) Bulgular PRD'ye gereksinim olarak.
- **Kabul:** Rapor docs/test-reports/erisilebilirlik-v1.md.

### T-083 Staging ve üretim altyapısı (basit ama sağlam)
- **Adımlar:** (1) Terraform: 1 VPS (4 vCPU/8 GB, Türkiye bölgesi), yönetilen Postgres (çoklu AZ, PITR), yönetilen Redis, S3 uyumlu kova (nesne kilidi), DNS, TLS (Caddy/Traefik). (2) `infra/docker-compose.prod.yml`: api (2 replika), console, family-web, outbox worker, caddy; sağlık kontrolleri; otomatik yeniden başlatma. (3) Yedek: Postgres PITR + günlük dump S3'e; haftalık geri yükleme tatbikatı script'i. (4) İzleme: Prometheus + Grafana + Loki (tek compose), uyarılar (kuyruk gecikmesi, outbox birikimi, CPaaS hata oranı, disk) → e-posta/Telegram/PagerDuty. (5) Sentetik: her 5 dk simülatör TEST sinyali → `signal_to_screen` ölçümü. (6) Durum sayfası (Uptime Kuma). (7) K8s'e geçiş Faz 3; compose dosyaları Helm'e çevrilir.
- **Kabul:** Staging'de 7 gün kesintisiz sentetik; geri yükleme tatbikatı < 1 saat; RPO 15 dk.

### T-084 Beta dağıtımı ve Kapı 2
- **Adımlar:** (1) Play iç test (watch + phone), TestFlight (iOS), Flutter aile uygulaması her iki mağaza; gizlilik beyanları, izin açıklamaları. (2) 20 kullanıcı (10 aile) 4 hafta; günlük olay incelemesi; haftalık NPS. (3) Kapı 2 raporu: yanlış alarm, yanıt süresi, aktivasyon, pil, bağlantı kaybı; 00 Yol Haritası KPI tablosu. (4) S9 planı.
- **Kabul:** Kapı 2 metrikleri eşiklerde; rapor docs/test-reports/kapi-2.md.

## Çapraz görevler (her sprintte)
- **X-01 Dokümantasyon:** her PR'da ilgili doküman bölümü güncellenir; OpenAPI'den Redoc sayfası `apps/api/docs`.
- **X-02 Gözlemlenebilirlik:** her yeni modülde metrik + log alanı (PII'siz) + izleme span'i.
- **X-03 Mesaj kataloğu:** yeni kullanıcı metni → `packages/messages/tr.json` + PRD kataloğu.
- **X-04 Test raporu:** docs/test-reports/ altına tarihli dosya.
- **X-05 Geri alma:** her migration geri alınabilir; feature flag ile kademeli açılış (`packages/flags`).
