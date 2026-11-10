# Görev listesi (06 · Geliştirme Planı, v1.0)

> Adım adım tam kapsam: **docs/TASKS-DETAY.md** (07 · Görev Kitabı). v1.0 sadeleştirmesi: Kafka yerine Postgres outbox + BullMQ; K8s yerine VPS + compose (prod). Bu dosya özet/işaretleme listesidir.

Her görev bir PR. Kimlikler PRD'ye (02), teknik referans 03'e işaret eder. S0 kısmen hazır (bu repo).
Claude Code'a görev verirken 06'daki istem şablonunu kullan.

## Epik 0 · Temel (S0) — bu repo ile başlatıldı
- [x] T-001 Monorepo iskeleti, CLAUDE.md, docs/
- [x] T-001b Kod kalitesi: ESLint flat + Prettier, Husky + lint-staged, commitlint `<alan>(<PRD-id>): <özet>`
- [x] T-002 docker-compose: Postgres+Timescale, Redpanda, Redis, Keycloak, MinIO, Mailhog; init.sql
- [x] T-003 packages/contracts: OpenAPI taslağı, sinyal ve zarf şemaları, TS tipleri (uç noktalar her görevde genişler)
- [x] T-004 packages/rules: JSON Schema + tr.yaml + validate.mjs
- [x] T-005 packages/messages: tr.json + t()
- [x] T-006 packages/simulator: fall/sos/heartbeat/offbody/onbody/battery/inactivity/cancel/scenario
- [x] T-007 CI: kural doğrulama, lint, typecheck, test, build; API imajı (<250 MB), duman testi, Trivy (ilk CI koşusunda doğrulanacak)

## Epik 1 · Olay motoru (S1)
- [x] T-010 signal: Postgres/Timescale yazımı + transactional outbox + OutboxWorker (DLQ), Redis idempotency (D-01). Testler PGlite ile; Testcontainers T-016
- [x] T-011 event: durum makinesi + geçiş kaydı (D-10)
- [x] T-011b olay ve geçiş kalıcılığı: event.event + event.transition, tek transaction (durum + geçiş + audit + outbox), kişi başına tek açık olay, append-only audit.log, gecikmiş soru taraması
- [x] T-012 kural paketi (D-02): JSON Schema + katalog doğrulama, chain.procedure_template sürümleme, POST /v1/admin/rules/reload; karar tablosu (decide.ts); açık olayda SOS → P1; WATCH_OFF 120/240 dk bekleme; pil bildirimleri; BATTERY_DEAD/CONNECTION_LOST cihaz taraması; test olayları 112'siz şablon
- [x] T-013 BullMQ zamanlayıcılar (D-09): prompt-expire, silent-ask-expire, follow-up bağlı; watch-off/battery-dead/connection-lost türleri hazır (T-012/T-014 bağlar). Yeniden başlatma kabulü T-011b ile uçtan uca sağlandı
- [x] T-014 koruma durumu ve gece penceresi (D-05): PROTECTED_WATCH/NIGHT/PROTECTED_PHONE/UNPROTECTED, event.threshold uyku penceresi, user.protection.changed, GET /v1/protected-persons/{id}/status, sabah WATCH_OFF, gece başında bekleyen WATCH_OFF kapanır. Açık: aile bildirimi için katalog kodu yok (02 PRD kataloğu)
- [x] T-015 cihaz adaptörü: DeviceAdapter + AdapterRegistry; WearOs (no-op, prompt/ring → FCM), AndroidPhone, Simulator (üretimde kapalı); sinyal alımı türe göre adaptör seçer, sunucu `source` ekler. Not: arayüz 03 dokümanı olmadan türetildi
- [x] T-016 Entegrasyon (S3/S4/S7, gerçek süreçler), kaos (Redis 30 sn, Postgres 10 sn), k6 duman; raporlar docs/test-reports/. Not: Docker yok → Testcontainers yerine redis-server + PGlite sunucusu; gerçek TimescaleDB koşumu açık

## Epik 2 · Konsol çekirdek (S2)
- [x] T-020 identity: Keycloak realm'leri, OIDC guard, roller, MFA (E-01)
- [x] T-021 chain: prosedür şablonu (05 → JSON), chain_run/step, operatör kilidi (D-03, D-04) — kilit Redis yerine olay satırında (lock_until); 05 metinleri katalogda, gözden geçirilmeli
- [x] T-022 GET /v1/queue + WebSocket; claim (E-02)
- [x] T-023 Konsol UI: 04 düzeni, QueueRow, EventCard, StepRow, ScriptPanel, kısayollar (E-03, E-04, E-08, E-10) — tıbbi özet T-040 ile bağlandı; 04 dokümanı okunamadı, düzen görev kitabından
- [x] T-024 Kapatma + takip planlama (E-07); 112 şablonu (E-06) — tıbbi alanlar T-040 ile doluyor
- [x] T-025 SLA sayaçları ve metrikler (E-09, D-11)
- [x] T-026 Playwright e2e — S3/S4/S5/S6 + eğitim modu; S5'in sahte CPaaS ayağı T-050 ile

## Epik 3 · Wear OS saat (S3) — repo: yanimda-android
- [ ] T-030 Proje: Compose for Wear, Health Services, test modu
- [ ] T-031 FALL_DETECTED + prompt 60 sn, titreşim, TTS (A-02, A-03)
- [ ] T-032 SOS: 3 sn buton + fiziksel tuş 3× (A-01)
- [ ] T-033 Hareketsizlik (A-04)
- [ ] T-034 Off-body, pil, nabız, konum (A-05…A-08)
- [ ] T-035 Room kuyruk + Wearable Data Layer + LTE HTTPS (A-09)
- [ ] T-036 Tile, komplikasyon, durum rozeti (A-11, A-13)
- [ ] T-037 Gelen arama ve otomatik cevap (A-10)

## Epik 4 · Eşlikçi Android + profil (S4)
- [x] T-040 profile: protected_person, contacts, medical (şifreli), invite (C-02, C-03, C-04) — SMS gönderimi T-053, aile ekranları T-061; aile üyesi (MEMBER) daveti açık
- [x] T-041 /v1/devices/enroll, cihaz token, /config — aile "cihazı kaldır" T-020'ye kadar yönetici token'ıyla
- [ ] T-042 phone: davet → 6 ekran kurulum (B-01, B-02)
- [ ] T-043 phone: köprü ve tampon (B-03)
- [ ] T-044 phone: ana ekran, foreground service, koruma ve gece modu (B-04, B-05, B-06, B-09)
- [ ] T-045 Uçtan uca cihaz testi <5 sn

## Epik 5 · Telefoni ve bildirim (S5)
- [x] T-050 telephony: CPaaS giden arama, webhook, kayıt → S3 (E-05) — Twilio sandbox'ta gerçek arama hesap bekliyor; operatör ucu T-051'e kadar masa hattı
- [x] T-051 Konsol WebRTC softphone — token, PhoneBar, konferans/bekletme; gelen SOS aramaları (müsait operatöre yönlendirme) açık; gerçek Twilio denemesi hesap bekliyor
- [ ] T-052 TR numara / SIP trunk; 112 sabit hat prosedürü
- [x] T-053 notify: FCM/APNs, SMS, sesli; katalog; yedekleme (D-08) — gerçek FCM/APNs/Twilio hesaplarıyla deneme açık; aile uygulaması T-061
- [ ] T-054 Gelen arama ekranları, otomatik cevap (A-10, B-07)

## Epik 6 · Aile ve web (S6)
- [x] T-060 family-web: paket, ödeme, hesap (C-01) — iyzico/Stripe gerçek sandbox'ta denenmedi (sahte sağlayıcı + imzalı olay testleri); KVKK metinleri yer tutucu (hukuk onayı)
- [ ] T-061 Aile uygulaması ekranları (C-04…C-10)
- [x] T-062 Günlük özet + F-DAILY (C-07, B-10) — aile ve telefon ekranları T-061/T-044
- [x] T-063 Test SOS akışı (C-05) — aile ilerleme ekranı T-061

## Epik 7 · Öğrenme, yanlış alarm, iOS (S7)
- [x] T-070 Öğrenme modu (D-06) — API; rapor ekranı T-061, otomatik sesli ön eleme T-072
- [x] T-071 Yanlış alarm sayacı ve geri bildirim (D-07, C-12) — API; aile ekranı T-061, amir ekranı T-074
- [ ] T-072 Otomatik sesli ön eleme (D-12)
- [ ] T-073 iOS Companion — başladı (repo `yanimda-ios`): iskelet, izin sihirbazı, SOS 3 sn → /v1/signals, kalıcı tampon, önemli konum değişikliği, arka plan yenilemesi; sunucuda `IOS_PHONE` adaptörü. eşleşme (davet kodu/bağlantısı → cihaz token'ı, Keychain, kaldırılınca yeniden eşleşme), CMMotionActivity hareketsizlik → INACTIVITY + "İyiyim", HealthKit adım/nabız → HEARTBEAT. APNs sessiz uyandırma (15 dk). Açık: gerçek APNs anahtarı ve cihazda deneme, pil ölçümü (<%5/24 sa), TestFlight
- [x] T-074 Amir panosu (E-11) — taşma bayrağı yalnız işaret (yönlendirme v2.0); operatörün kendi durum seçimi açık

## Epik 8 · Sertleştirme (S8)
- [ ] T-080 Yük ve kaos testleri, olay kaybı 0
- [ ] T-081 Güvenlik taramaları, sertifika sabitleme, PII denetimi
- [ ] T-082 Erişilebilirlik denetimi ve 5 kullanıcı testi
- [ ] T-083 Staging (Terraform + Helm), sentetik izleme
- [ ] T-084 Beta dağıtımı, Kapı 2 raporu

## İlk Claude Code oturumu için önerilen sıra
1. `pnpm install && pnpm test` yeşil olsun.
2. T-010 (Timescale + Kafka) → T-013 (BullMQ) → T-012 → T-016.
3. Ardından T-020 → T-021 → T-022 → T-023.
