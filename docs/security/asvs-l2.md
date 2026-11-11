# OWASP ASVS 4.0.3 Seviye 2 kontrol listesi

T-081 (5). Kapsam: `apps/api` (NestJS), `apps/console` (React), `infra/keycloak` realm'leri, `apps/api/Dockerfile`,
`.github/workflows/ci.yml`. Mobil uygulamalar ASVS değil MASVS kapsamındadır (`sizma-testi-plani.md`,
`sertifika-sabitleme.md`). Değerlendirme tarihi: 2026-11-10, dal `claude/t080-hardening-0d1255`.

Durum: ✅ karşılandı (repoda kanıt var) · ⚠️ kısmi veya kanıtı repoda yok · ❌ yok · N/A uygulanamaz.
Kanıtı repoda olmayan altyapı kontrolleri (TLS sonlandırma, ingress başlıkları, log depolama) bilerek ⚠️ sayıldı:
üretim manifestleri bu repoda değil. Yollar repo köküne göredir; `api/` = `apps/api/src/`.

Sayım: sistemle ilgili L1+L2 gereksinimleri satır satır değerlendirildi (L3'e özgü olanlar dışarıda). Grup
satırları (2.7.x, 2.9.x, 3.4.x, 12.1–12.5, 13.3/13.4) tek satır; iki ayrı yapılandırması olan gereksinimler
(2.1.1, 2.2.1, 3.3.2: `operations`/`consumers`, kullanıcı/cihaz) iki satır sayıldı.

## Özet

| | Sayı |
| --- | --- |
| Değerlendirilen satır (L1+L2) | 219 |
| N/A | 17 |
| Uygulanabilir | 202 |
| ✅ karşılandı | 151 |
| ⚠️ kısmi | 47 |
| ❌ yok | 4 |
| **Karşılama (yalnız ✅ / uygulanabilir)** | **%74,8 (151/202)** |
| Ağırlıklı (✅ + ½·⚠️) | %86,4 |

**Sonuç (2026-11-11, ikinci tur sonrası %74,8): T-081 hedefi (≥ %90) hâlâ karşılanmıyor.** Doğrulanmış kritik bulgu: **0**. Bir yüksek bulgu (G-1) dağıtık
saldırgan varsayımında kritik tanımına ("kimliksiz saldırganın sahte acil olay üretmesi") yaklaşır; sızma testinde
öncelikle doğrulanmalı. %90'a giden yol en altta.

Bölüm bazında:

| Bölüm | ✅ | ⚠️ | ❌ | N/A | Karşılama |
| --- | --- | --- | --- | --- | --- |
| V1 Mimari | 24 | 13 | 0 | 1 | %65 |
| V2 Kimlik doğrulama | 28 | 5 | 2 | 2 | %80 |
| V3 Oturum | 8 | 6 | 0 | 1 | %57 |
| V4 Erişim kontrolü | 8 | 1 | 0 | 0 | %89 |
| V5 Doğrulama/kodlama | 15 | 2 | 0 | 6 | %88 |
| V6 Kriptografi | 9 | 1 | 2 | 1 | %75 |
| V7 Hata/log | 10 | 2 | 0 | 0 | %83 |
| V8 Veri koruma | 10 | 4 | 0 | 1 | %71 |
| V9 İletişim | 2 | 6 | 0 | 0 | %25 |
| V10 Kötü amaçlı kod | 2 | 1 | 0 | 2 | %67 |
| V11 İş mantığı | 8 | 0 | 0 | 0 | %100 |
| V12 Dosya | 1 | 0 | 0 | 1 | %100 |
| V13 API | 5 | 4 | 0 | 1 | %56 |
| V14 Yapılandırma | 21 | 2 | 0 | 1 | %91 |

## V1 Mimari, tasarım ve tehdit modelleme

| # | Gereksinim | Durum | Kanıt / not |
| --- | --- | --- | --- |
| 1.1.1 | Güvenli geliştirme yaşam döngüsü | ⚠️ | CI: lint, tip, test, Trivy (`ci.yml`); CLAUDE.md "Bitmeden kontrol et". Resmî güvenli SDLC tanımı yok. |
| 1.1.2 | Tehdit modelleme | ✅ | STRIDE tehdit modeli `docs/security/tehdit-modeli.md`; tasarım değişikliğinde güncellenir (PR açıklamasında etki). |
| 1.1.3 | Kullanıcı hikâyelerinde güvenlik kısıtları | ✅ | PRD kabul kriterleri; `docs/TASKS-DETAY.md` (yetki, PII, idempotency). |
| 1.1.4 | Güven sınırları belgeli | ⚠️ | Modül haritası var (`api/app.module.ts`, 03-teknik-mimari); güvenlik odaklı güven sınırı diyagramı yok. |
| 1.1.5 | Üst düzey mimari güvenlik analizi | ⚠️ | Bu klasör ilk adım; bileşen bazlı analiz yok. |
| 1.1.6 | Merkezi, yeniden kullanılan güvenlik kontrolleri | ✅ | `api/modules/identity/oidc.guard.ts`, `api/modules/device/device-token.guard.ts`, `api/common/field-cipher.ts`, `api/common/problem.filter.ts`, `api/common/safe-error.ts`. |
| 1.1.7 | Geliştiriciye güvenli kodlama rehberi | ✅ | `CLAUDE.md` (PII, sırlar, katalog), `docs/security/`. |
| 1.2.1 | Bileşenler ayrı, düşük yetkili OS hesabı | ✅ | `apps/api/Dockerfile:27` `USER node`. |
| 1.2.2 | Bileşenler arası iletişim kimlik doğrulamalı | ⚠️ | Postgres parolalı; Redis parolasız (`infra/docker-compose.yml`), üretim yapılandırması repoda yok. |
| 1.2.3 | Tek, denetlenmiş kimlik doğrulama | ✅ | Kullanıcı: Keycloak OIDC (`api/modules/identity/oidc-verifier.ts`); cihaz: HS256 token (`api/modules/device/device-token.ts`). |
| 1.2.4 | Tüm kimlik doğrulama yolları eşit güçte | ⚠️ | `x-admin-token` MFA'sız yönetici yolu (`oidc.guard.ts:76`, `api/modules/profile/profile.controller.ts:45-49`) (G-4). |
| 1.4.1 | Erişim kontrolü güvenilir uçta | ✅ | Tüm denetim API guard'larında; konsol rol kontrolü yalnız arayüz (`apps/console/src/lib/auth.ts:23`). |
| 1.4.4 | Tek erişim kontrol mekanizması | ✅ | `@Roles` + `OidcGuard`/`AdminGuard`/`ProfileGuard`/`DeviceTokenGuard`. |
| 1.4.5 | Kaynak/öznitelik düzeyinde erişim | ✅ | Operatör: üstlendiği olay (`api/modules/event/event.service.ts:560-575` `operate`); aile: kendi kişisi (`profile.service.ts`); cihaz: kendisi (`enrollment.service.ts:308` `assertSelf`, `companion.service.ts` `authorizeBatch`: yetkisiz sinyal yazılmaz). |
| 1.5.1 | Girdi/çıktı gereksinimleri tanımlı | ✅ | `packages/contracts/schemas/signal.schema.json`, `packages/contracts/openapi.yaml`. |
| 1.5.2 | Güvenilmeyen istemciyle nesne serileştirme yok | ✅ | Yalnız JSON. |
| 1.5.3 | Girdi doğrulama güvenilir katmanda | ✅ | `api/modules/signal/signal.service.ts` (Ajv), `enrollment.service.ts:192` `parse`. |
| 1.5.4 | Çıktı kodlama yorumlayıcıya yakın | ✅ | TwiML `xml()` (`api/modules/telephony/cpaas.ts:82-83`); React kaçışlama. |
| 1.6.1 | Anahtar yönetim politikası | ⚠️ | `docs/security/sirlar.md` (bu görev); uygulanmış araç (yeniden şifreleme, Vault) yok. |
| 1.6.2 | Anahtar tüketicileri anahtarı korur | ⚠️ | Anahtarlar süreç ortamında (`field-cipher.ts:31`, `device-token.ts:29`). |
| 1.6.3 | Anahtar ve parolalar değiştirilebilir | ⚠️ | `FIELD_ENC_KEYS` çoklu `kid` ✅; `DEVICE_TOKEN_SECRET` tek anahtar, değişim tüm cihazları düşürür (G-7). |
| 1.6.4 | İstemcideki sırlar güvensiz sayılır | ✅ | Konsol public PKCE istemcisi (`infra/keycloak/realm-operations.json`); istemcide paylaşılan sır yok. |
| 1.7.1 | Ortak log biçimi | ✅ | Nest `Logger` + `safeError`. |
| 1.7.2 | Log'lar güvenli şekilde merkeze | ⚠️ | stdout; toplama/iletim altyapısı repoda yok. |
| 1.8.1 | Hassas veri sınıflandırılmış | ✅ | `CLAUDE.md`, `api/modules/health/README.md`, ayrı `health` şeması. |
| 1.8.2 | Koruma düzeyleri uygulanmış | ⚠️ | Sağlık ve kapı notu şifreli; ad, telefon, adres düz metin (G-10). |
| 1.9.1 | Bileşenler arası şifreli iletişim | ⚠️ | DB/Redis TLS kanıtı yok; metrik ucu düz HTTP (G-11). |
| 1.9.2 | Bileşenler karşı tarafı doğrular | ⚠️ | Aynı. |
| 1.10.1 | Kaynak kontrolü, izlenebilir değişiklik | ✅ | git + PR, `commitlint.config.js`. |
| 1.11.1 | İş akışları belgeli | ✅ | 02-prd; `api/modules/event/event-state-machine.ts`. |
| 1.11.2 | Yüksek değerli akışlar eşzamanlılığa dayanıklı | ✅ | `FOR UPDATE` (`enrollment.service.ts:143`), kişi başına tek açık olay (`drizzle/migrations/0002_event_persistence/up.sql:10`), idempotency (`api/modules/signal/idempotency.store.ts`). |
| 1.12.2 | Kullanıcı yüklediği dosyalar | N/A | Dosya yükleme yok. |
| 1.14.1 | Farklı güven düzeyleri ayrık | ✅ | Metrikler ayrı portta (`metrics.service.ts:132-141`); prod'da yalnız iç ağ, vekilden yayınlanmaz (`infra/docker-compose.prod.yml`, `infra/caddy/Caddyfile`, Helm NetworkPolicy). |
| 1.14.2 | İkili imza / güvenilir dağıtım | ✅ | `.github/workflows/release-image.yml`: Trivy → GHCR → cosign anahtarsız imza + doğrulama, SBOM tasdiki. |
| 1.14.3 | Derleme hattı bağımlılık uyarısı | ✅ | Trivy HIGH/CRITICAL'da kırmızı (`ci.yml`, iş `image`). |
| 1.14.4 | Betikli derleme ve dağıtım | ✅ | `apps/api/Dockerfile`, `ci.yml`. |
| 1.14.5 | Yalıtım (sandbox, ağ ayrımı) | ⚠️ | Konteyner; ağ politikaları repoda yok. |
| 1.14.6 | Desteklenmeyen istemci teknolojisi yok | ✅ | — |

## V2 Kimlik doğrulama

Kullanıcı kimlik doğrulaması Keycloak'a devredilmiş (`infra/keycloak/realm-*.json`); API yalnız token doğrular.
Operatör realm'inde OTP zorunlu: `browserFlow: browser-otp`, `CONFIGURE_TOTP` varsayılan eylem ve API'de `amr`
içinde `otp` denetimi (`oidc-verifier.ts:133-136`; üretimde kapatılamaz `:53-54`).

| # | Gereksinim | Durum | Kanıt / not |
| --- | --- | --- | --- |
| 2.1.1 | Parola ≥ 12 karakter (operations) | ✅ | `passwordPolicy: length(12) and notUsername and passwordHistory(5)`. |
| 2.1.1 | Parola ≥ 12 karakter (consumers) | ✅ | `length(12) and maxLength(128) and notUsername and notEmail and passwordHistory(3)` (T-081). |
| 2.1.2 | ≥ 64 karaktere izin | ✅ | Keycloak varsayılanı (üst sınır politikası yok). |
| 2.1.3 | Parola kırpılmaz | ✅ | Keycloak. |
| 2.1.4 | Unicode parola | ✅ | Keycloak. |
| 2.1.5 | Kullanıcı parolasını değiştirebilir | ✅ | Keycloak hesap konsolu, `UPDATE_PASSWORD`. |
| 2.1.6 | Değişimde mevcut parola | ✅ | Keycloak. |
| 2.1.7 | İhlal edilmiş parola denetimi | ❌ | Kara liste/ihlal politikası yok (G-9). |
| 2.1.8 | Parola gücü göstergesi | ❌ | Varsayılan tema; gösterge yok. |
| 2.1.9 | Bileşim kuralı yok | ✅ | Politika yalnız uzunluk/geçmiş. |
| 2.1.10 | Zorunlu periyodik değişim yok | ✅ | `forceExpiredPasswordChange` yok. |
| 2.1.11 | Yapıştırma ve parola yöneticisi | ✅ | Keycloak giriş sayfası. |
| 2.1.12 | Parolayı geçici gösterme | ✅ | Keycloak 26 teması. |
| 2.2.1 | Kaba kuvvet koruması (kullanıcı girişi) | ✅ | `bruteForceProtected: true`, `failureFactor` 5 (operations) / 10 (consumers). |
| 2.2.1 | Kaba kuvvet koruması (cihaz eşleştirme kodu) | ✅ | IP başına 10 hata / 15 dk (`enrollment.service.ts`) + `POST /devices/enroll` hız sınırı (IP, 20/10 dk, Redis, tüm kopyalar ortak); `TRUST_PROXY` ile gerçek istemci IP'si (T-081). |
| 2.2.2 | Zayıf doğrulayıcılar sınırlı | ✅ | Operatör TOTP; davet kodu tek kullanımlık, 15 dk, yalnız özeti saklanır (`enrollment.service.ts:30, 78, 109-127`). |
| 2.2.3 | Kimlik bilgisi değişince bildirim | ✅ | Realm'lerde `eventsListeners: [email]` + SMTP: parola / OTP değişikliği ve hatalı giriş kullanıcıya e-postalanır (T-081). |
| 2.3.1 | İlk parola/aktivasyon kodu rastgele, kısa ömürlü | ✅ | `randomInt` 6 hane, 15 dk (`enrollment.service.ts:115`); operatöre ilk girişte `UPDATE_PASSWORD`. |
| 2.4.1 | Parola saklama (tuzlu, yavaş özet) | ✅ | Keycloak (PBKDF2-SHA512 varsayılanı). |
| 2.5.1 | Sıfırlama sırrı yalnız kurtarmada | ✅ | `resetPasswordAllowed: false` (yönetici sıfırlar). |
| 2.5.2 | Parola ipucu / bilgi sorusu yok | ✅ | — |
| 2.5.3 | Parola geri gönderilmez | ✅ | — |
| 2.5.4 | Paylaşılan / varsayılan hesap yok | ⚠️ | `ADMIN_TOKEN` paylaşımlı sır (G-4); Keycloak `admin/admin` yalnız `infra/docker-compose.yml` (yerel). |
| 2.5.5 | Doğrulama faktörü değişince bildirim | ✅ | Aynı (2.2.3): `UPDATE_TOTP` / `REMOVE_TOTP` e-postası. |
| 2.5.6 | Unutulan parola akışı güvenli | ⚠️ | Self-servis kapalı; yönetici sıfırlama süreci belgelenmemiş. |
| 2.5.7 | OTP kaybında güvenli kurtarma | ⚠️ | Belgelenmiş süreç yok. |
| 2.7.x | Bant dışı doğrulayıcı (SMS OTP) | N/A | SMS OTP kullanılmıyor. |
| 2.8.1 | Zaman tabanlı OTP ömrü | ✅ | `otpPolicyPeriod: 30`. |
| 2.8.2 | OTP tohumları korunur | ✅ | Keycloak. |
| 2.8.3 | Onaylı OTP algoritması | ✅ | TOTP (RFC 6238) HMAC-SHA1, 6 hane. |
| 2.8.4 | OTP tek kullanımlık | ✅ | Keycloak varsayılanı (`otpPolicyCodeReusable` false). |
| 2.8.5 | OTP yeniden kullanım girişimi loglanır | ✅ | Keycloak olay kaydı açık (`eventsEnabled`, 90 gün, DB'de; `LOGIN_ERROR` / `CODE_TO_TOKEN_ERROR`) (T-081). |
| 2.9.x | Kriptografik doğrulayıcı (donanım anahtarı) | N/A | Kullanılmıyor. |
| 2.10.1 | Servis kimlikleri statik değil | ⚠️ | Twilio, S3, FCM statik anahtar; `ADMIN_TOKEN`. |
| 2.10.2 | Varsayılan kimlik bilgisi yok (üretim) | ✅ | Üretimde zorunlu sırlar yoksa açılmaz (`field-cipher.ts:33`, `device-token.ts:32`). |
| 2.10.3 | Servis parolaları korumalı saklanır | ⚠️ | Ortam değişkeni; Vault planı `sirlar.md`. |
| 2.10.4 | Sırlar kaynak kodda değil | ✅ | `.env.example` boş değerler; CI iş başına rastgele (`ci.yml`). |

## V3 Oturum yönetimi

API durumsuz Bearer token kullanır (çerez yok); konsol `oidc-client-ts` PKCE.

| # | Gereksinim | Durum | Kanıt / not |
| --- | --- | --- | --- |
| 3.1.1 | Token URL'de yok | ✅ | WS kimliği ilk mesajla (`api/modules/queue/queue.gateway.ts:52-56, 145-160`); OIDC `code` adresten silinir (`apps/console/src/lib/auth.ts:46-56`). |
| 3.2.1 | Girişte yeni token | ✅ | Keycloak. |
| 3.2.2 | ≥ 64 bit entropi / imzalı | ✅ | RS256/ES256 JWT; cihaz HMAC-SHA256. |
| 3.2.3 | Tarayıcıda güvenli saklama | ✅ | `sessionStorage` (`auth.ts:18`) + konsol CSP `script-src 'self'` (satır içi betik yok), `frame-ancestors 'none'` (`infra/caddy/Caddyfile`). |
| 3.2.4 | Onaylı algoritmayla üretim | ✅ | — |
| 3.3.1 | Çıkış token'ı geçersiz kılar | ⚠️ | Konsol `signoutRedirect` (`apps/console/src/App.tsx:62`); erişim token'ı API'de süresi (5 dk) dolana kadar geçerli. Cihaz iptali anında (`enrollment.service.ts:247-265`). |
| 3.3.2 | Boşta/mutlak süre (operations) | ✅ | `ssoSessionIdleTimeout: 3600`, `ssoSessionMaxLifespan: 43200`, `accessTokenLifespan: 300`. |
| 3.3.2 | Boşta/mutlak süre (consumers) | ⚠️ | 30 gün / 90 gün, çevrimdışı oturum 90 gün: mobil aile uygulaması için bilinçli risk kabulü gerekir (G-9). |
| 3.3.3 | Parola değişince diğer oturumları kapatma | ✅ | Keycloak "diğer cihazlardan çık". |
| 3.3.4 | Etkin oturumları görme/kapatma | ⚠️ | Keycloak hesap konsolunda; aile uygulamasında yok. |
| 3.4.x | Çerez öznitelikleri | N/A | API çerez kullanmaz. |
| 3.5.1 | OAuth izni/token iptal edilebilir | ⚠️ | Cihaz token iptali ✅; `revokeRefreshToken` kapalı. |
| 3.5.2 | Statik API sırrı yerine oturum token'ı | ⚠️ | `ADMIN_TOKEN` (G-4). |
| 3.5.3 | Durumsuz token imzalı ve doğrulanır | ✅ | Yalnız RS256/ES256, `alg: none`/HS reddi, `iss`/`aud`/`exp`/`nbf`/`typ` (`oidc-verifier.ts:100-148`); cihaz: sabit başlık + `timingSafeEqual` (`device-token.ts:56-74`); `test/identity.spec.ts`, `test/device-enrollment.spec.ts`. |
| 3.7.1 | Hassas işlemde yeniden doğrulama | ⚠️ | Step-up yok; 112 yükseltme gerekçe ister (`chain.controller.ts:77`). |

## V4 Erişim kontrolü

| # | Gereksinim | Durum | Kanıt / not |
| --- | --- | --- | --- |
| 4.1.1 | Sunucu tarafında uygulanır | ✅ | Guard'lar; `test/admin-guard.spec.ts`, `test/identity.spec.ts`. |
| 4.1.2 | Öznitelikler kullanıcıca değiştirilemez | ✅ | Roller imzalı token'dan ve realm'e bağlı (`oidc-verifier.ts:138-140`); `X-Operator-Id` kaldırıldı (`oidc.guard.ts:31`). |
| 4.1.3 | En az yetki | ✅ | Uç bazında `@Roles` (`chain.controller.ts:21`, `queue.controller.ts:28,43`, `telephony.controller.ts:69`, `notify.controller.ts:24`); tıbbi özet yalnız üstlenen operatöre. |
| 4.1.5 | Hata durumunda kapalı | ✅ | `ADMIN_TOKEN` boşsa yönetici uçları kapalı (`api/modules/rules/admin-token.guard.ts:16`); OIDC yapılandırılmamışsa 401 (`identity.module.ts:14`); üretimde token'sız sinyal 401 (`device-token.guard.ts:42-43`). |
| 4.2.1 | IDOR koruması | ✅ | `assertSelf`, `authorizeBatch` (sinyal başına), aile için başka kişi 404 (`profile.controller.ts:60`), `operate()` sahiplik. |
| 4.2.2 | CSRF koruması | ✅ | Bearer başlığı; çerez yok; CORS kapalı (`api/main.ts`). |
| 4.3.1 | Yönetici arayüzü MFA | ⚠️ | OIDC ADMIN (operations, OTP) ✅; `x-admin-token` MFA'sız (G-4). |
| 4.3.2 | Dizin listeleme kapalı | ✅ | API statik dosya sunmaz. |
| 4.3.3 | Ek yetkilendirme / görev ayrılığı | ✅ | Amir-özel işlemler (`queue.controller.ts:43`); operatör profil düzenleyemez (`profile.controller.ts:34-36`); tıbbi özet aileye geri okunmaz. |

## V5 Doğrulama, temizleme, kodlama

| # | Gereksinim | Durum | Kanıt / not |
| --- | --- | --- | --- |
| 5.1.1 | HTTP parametre kirliliği | ✅ | Tek değer beklenir; dizi gelirse UUID/regex doğrulaması reddeder. |
| 5.1.2 | Toplu atama koruması | ✅ | Alanlar tek tek seçilir (`enrollment.service.ts:192-207`, `profile.service.ts`). |
| 5.1.3 | Pozitif (izin listesi) doğrulama | ✅ | Ajv şeması, `ENROLLABLE_KINDS`, `WEBHOOK_KINDS`, regex'ler. |
| 5.1.4 | Yapılandırılmış veri şemayla | ⚠️ | Yalnız sinyal JSON Schema ile; diğer uçlar elle doğrulanır, OpenAPI'den otomatik doğrulama yok. |
| 5.1.5 | Yönlendirme izin listesi | ⚠️ | Keycloak `redirectUris` yalnız geliştirme adresleri; üretim değerleri repoda yok (G-20). |
| 5.2.1 | HTML temizleme | ✅ | React; `dangerouslySetInnerHTML` yok (`apps/console/src`). |
| 5.2.2 | Yapısız veri sınırlandırılır | ✅ | Uzunluk sınırları (`enrollment.service.ts:79`, kapanış notu ≤ 2000 `chain.controller.ts:83`). |
| 5.2.3 | E-posta/SMTP enjeksiyonu | N/A | E-posta gönderilmiyor. |
| 5.2.4 | `eval` / dinamik kod yok | ✅ | — |
| 5.2.5 | Şablon enjeksiyonu | ✅ | Katalog `t()` yalnız `{ad}` yer tutucusu (`packages/messages/index.js`). |
| 5.2.6 | SSRF | ✅ | Dış URL'ler sabit/yapılandırma; kayıt SID ile sabit tabandan (`api/modules/telephony/twilio.ts:67-71`); JWKS yalnız yapılandırılmış issuer'dan. |
| 5.2.7 | SVG | N/A | — |
| 5.2.8 | Kullanıcı şablon/markdown dili | N/A | — |
| 5.3.1 | Bağlama uygun çıktı kodlama | ✅ | TwiML `xml()`; JSON. |
| 5.3.3 | XSS bağlama duyarlı kodlama | ✅ | React. |
| 5.3.4 | SQL parametreli | ✅ | Drizzle ve `sql` şablonu; ham SQL yalnız migration (`api/db/migrate.ts`). |
| 5.3.6 | JSON enjeksiyonu | ✅ | `JSON.stringify`. |
| 5.3.7 | LDAP | N/A | — |
| 5.3.8 | OS komut enjeksiyonu | ✅ | `child_process` yok. |
| 5.3.9 | Dosya dahil etme (LFI/RFI) | ✅ | Kural dizini yalnız yapılandırmadan (`RULES_DIR`). |
| 5.3.10 | XPath / XML enjeksiyonu | N/A | XML yalnız üretilir. |
| 5.5.2 | XXE | N/A | XML ayrıştırılmıyor. |
| 5.5.3 | Güvenilmeyen veri deserialize | ✅ | Yalnız `JSON.parse`. |

## V6 Saklanan kriptografi

| # | Gereksinim | Durum | Kanıt / not |
| --- | --- | --- | --- |
| 6.1.1 | Düzenlenmiş kişisel veri şifreli | ⚠️ | Ad, telefon, adres düz metin (`drizzle/migrations/0009_profile/up.sql`); disk şifreleme kanıtı yok (G-10). |
| 6.1.2 | Sağlık verisi şifreli | ✅ | `health.medical_summary.ciphertext` (`0009_profile/up.sql:27-33`, `CHECK LIKE 'v1:%'`), AES-256-GCM + AAD (`field-cipher.ts`). |
| 6.1.3 | Finansal veri şifreli | N/A | Ödeme sağlayıcıda (T-060). |
| 6.2.1 | Kripto modülleri güvenli başarısız olur | ✅ | GCM etiketi; hata istemciye sızmaz (`profile.service.ts:335-345`). |
| 6.2.2 | Denetlenmiş algoritma/kütüphane | ✅ | `node:crypto` AES-256-GCM, HMAC-SHA256. |
| 6.2.3 | IV, mod, dolgu doğru | ✅ | 12 bayt rastgele IV, GCM (`field-cipher.ts:39-45`). |
| 6.2.4 | Algoritma/anahtar değiştirilebilir | ✅ | Sürümlü `v1:<kid>:…` biçimi. |
| 6.2.5 | Güvensiz algoritma yok | ✅ | HMAC-SHA1 yalnız Twilio imza şeması ve TOTP standardı gereği. |
| 6.2.6 | Nonce tekrar edilmez | ✅ | Her şifrelemede rastgele 96 bit IV. |
| 6.3.1 | CSPRNG | ✅ | `randomBytes`, `randomInt`. |
| 6.3.2 | GUID'ler rastgele | ✅ | `uuidv4`/`uuidv7` (kimlikler sır değil). |
| 6.4.1 | Sır yönetim çözümü | ❌ | Uygulanmadı; plan `sirlar.md` (G-7). |
| 6.4.2 | Anahtar materyali uygulamaya açık değil (HSM/KMS) | ❌ | Anahtarlar süreç belleğinde. |

## V7 Hata yönetimi ve log

| # | Gereksinim | Durum | Kanıt / not |
| --- | --- | --- | --- |
| 7.1.1 | Kimlik bilgisi/token log'da yok | ✅ | `oidc.guard.ts:36`, `enrollment.service.ts:88` ("kod, token, ad yok"). |
| 7.1.2 | Diğer hassas veri log'da yok | ✅ | `safeError` (`api/common/safe-error.ts`); otomatik denetim: `apps/api/test/pii-logs.spec.ts` (akış boyunca log taraması), CI `e2e`/`console-e2e`/`security`/`load-v1` işlerinde `pii-audit-cli.ts`, Semgrep `yanimda-no-pii-in-logs`. |
| 7.1.3 | Güvenlik olayları loglanır | ✅ | `common/security-events.ts`: 400/401/403/422/429 → `[güvenlik]` log'u (rota şablonu + istek kimliği, PII yok) ve `yanimda_security_events_total`; Keycloak olay kaydı açık. |
| 7.1.4 | Soruşturma için yeterli bağlam | ✅ | `X-Request-Id` korelasyon kimliği (`common/http-security.ts`; gelen geçerli değer korunur, yanıtta döner, güvenlik log'unda). |
| 7.2.1 | Tüm kimlik doğrulama kararları | ✅ | API 401'leri güvenlik olayı log'unda; Keycloak `LOGIN` / `LOGIN_ERROR` olayları (DB). |
| 7.2.2 | Erişim kontrol hataları | ✅ | 403'ler güvenlik olayı log'unda (rota şablonu) + metrik. |
| 7.3.1 | Log enjeksiyonu önlenir | ✅ | Log'a yalnız doğrulanmış kimlik/tür değerleri girer. |
| 7.3.3 | Log'lar değiştirilemez | ⚠️ | `audit.log` yalnız eklenebilir, tetikleyiciyle (`0002_event_persistence/up.sql:23-43`); uygulama log deposu repoda yok. |
| 7.3.4 | Saat eşitleme | ⚠️ | Altyapı; kanıt yok. |
| 7.4.1 | Beklenmeyen hatada genel mesaj | ✅ | `problem.filter.ts:35-38` ("Internal error"); `test/problem-filter.spec.ts`. |
| 7.4.2 | Tutarlı hata yönetimi | ✅ | Global `ProblemFilter` (`api/main.ts:12`), RFC 7807. |
| 7.4.3 | Son çare işleyici | ✅ | `@Catch()` tümü. |

## V8 Veri koruma

| # | Gereksinim | Durum | Kanıt / not |
| --- | --- | --- | --- |
| 8.1.1 | Sunucu/proxy önbelleğinden koruma | ✅ | API varsayılanı `Cache-Control: no-store` (`common/http-security.ts`); cihaz yapılandırması `private, no-cache` + ETag. |
| 8.1.2 | Önbellek kopyaları temizlenir | N/A | Sunucu tarafı önbellek yok. |
| 8.1.3 | Gereksiz veri istenmez/dönülmez | ✅ | Tıbbi özet aileye geri okunmaz; olay kartı yalnız üstlenen operatöre. |
| 8.1.4 | Anormal istek hacmi tespiti | ✅ | Uç bazlı hız sınırı (`common/rate-limit.ts`) + `SecurityEventsSpike` uyarısı (401/403/429 artışı). |
| 8.2.1 | Hassas yanıtlarda önbellek önleme başlıkları | ✅ | Tüm API yanıtlarında `no-store` (T-081). |
| 8.2.2 | Tarayıcı deposunda hassas veri yok | ⚠️ | Erişim/yenileme token'ı `sessionStorage`'da. |
| 8.2.3 | Oturum sonunda istemci verisi silinir | ✅ | `sessionStorage` sekmeyle silinir. |
| 8.3.1 | Hassas veri gövde/başlıkta | ✅ | Token başlıkta; URL'de yalnız UUID. |
| 8.3.2 | Kullanıcı verisini silebilir/dışa aktarabilir | ⚠️ | Tıbbi özet silme var (`profile.controller.ts:98-102`); dışa aktarma yok. |
| 8.3.3 | Açık bilgilendirme ve rıza | ✅ | Tıbbi özette rıza zamanı zorunlu (`profile.controller.ts:92`, `consent_at NOT NULL`). |
| 8.3.4 | Hassas veri ve politikası tanımlı | ✅ | `CLAUDE.md`, `api/modules/health/README.md`. |
| 8.3.5 | Hassas veri erişimi denetlenir | ✅ | `health.medical_viewed` (`profile.service.ts:346-353`). |
| 8.3.6 | Bellekteki hassas veri silinir | ⚠️ | Node.js'te pratik değil; risk kabulü kararı gerekli. |
| 8.3.7 | Onaylı şifreleme | ✅ | AES-256-GCM. |
| 8.3.8 | Saklama süreleri | ⚠️ | Görüşme kaydı `RECORDING_RETENTION_DAYS` + nesne kilidi ✅; diğer veriler için süre/temizlik işi yok. |

## V9 İletişim

| # | Gereksinim | Durum | Kanıt / not |
| --- | --- | --- | --- |
| 9.1.1 | İstemci bağlantıları TLS | ✅ | Caddy ACME + HTTP→HTTPS (`infra/caddy/Caddyfile`), Helm Ingress TLS; Keycloak `sslRequired: external`; mobil release HTTPS. |
| 9.1.2 | Güncel şifre takımları | ⚠️ | Kanıt yok (testssl / ZAP ile doğrulanacak). |
| 9.1.3 | Yalnız TLS 1.2/1.3 | ⚠️ | Kanıt yok. |
| 9.2.1 | Dış bağlantılarda sertifika doğrulama | ✅ | `fetch` varsayılan doğrulama; `rejectUnauthorized`/`NODE_TLS_REJECT_UNAUTHORIZED` kullanılmıyor. |
| 9.2.2 | İç bağlantılar (DB, Redis, izleme) şifreli | ⚠️ | Kanıt yok (G-11). |
| 9.2.3 | Dış sistem bağlantıları kimlik doğrulamalı | ⚠️ | Redis parolasız (yerel compose). |
| 9.2.4 | Sertifika iptal denetimi | ⚠️ | Altyapı. |
| 9.2.5 | Arka uç TLS hataları loglanır | ⚠️ | Hata adı loglanır, TLS ayrımı yok. |

## V10 Kötü amaçlı kod

| # | Gereksinim | Durum | Kanıt / not |
| --- | --- | --- | --- |
| 10.2.1 | İzinsiz dışa veri gönderimi yok | ✅ | Dış çağrılar yalnız yapılandırılmış sağlayıcılara. |
| 10.2.2 | Gereksiz izin istenmez | N/A | Sunucu; mobil MASVS kapsamında. |
| 10.3.1 | Otomatik güncelleme bütünlüğü | N/A | — |
| 10.3.2 | Bütünlük korumaları (kod imzası) | ✅ | cosign imza + doğrulama (`release-image.yml`). |
| 10.3.3 | Alt alan adı devralma koruması | ⚠️ | DNS envanteri ve izleme yok. |

## V11 İş mantığı

| # | Gereksinim | Durum | Kanıt / not |
| --- | --- | --- | --- |
| 11.1.1 | Adımlar sırayla | ✅ | `event-state-machine.ts`; zincir adımı sıra dışı 409 (`chain.controller.ts:69-70`). |
| 11.1.2 | Gerçekçi insan hızı | ✅ | Kayıt (IP 10/sa), SMS kodu (5/sa), doğrulama (10/sa), davet (10/sa), web push aboneliği (30/sa). |
| 11.1.3 | İş limitleri | ✅ | Test SOS kişi başına 6/sa (+ 10 dk kuralı), davet 10/sa, SMS 5/sa; cihaz token yenileme 30/sa. |
| 11.1.4 | Aşırı çağrıya karşı otomasyon önlemi | ✅ | `/signals` cihaz başına 600/dk (alarm sinyalleri muaf), test SOS, davet, kayıt, webhook'lar (IP 1200/dk); Redis yoksa açık (acil akışı durmaz). |
| 11.1.5 | İş mantığı sınırları doğrulanır | ✅ | Kural paketi şeması (`packages/rules/schema.json`), tek açık olay, SLA/amir uyarıları (`api/modules/metrics/sla.ts`, `supervisor.service.ts`). |
| 11.1.6 | Yarış durumu (TOCTOU) yok | ✅ | Satır kilidi, benzersiz indeks, idempotency. |
| 11.1.7 | Anormal olay izleme | ✅ | `yanimda_security_events_total{status,route}` + operasyonel amir uyarıları. |
| 11.1.8 | Otomatik saldırı uyarısı | ✅ | Prometheus `SecurityEventsSpike` (`infra/monitoring/alerts.yml`). |

## V12 Dosya ve kaynaklar

| # | Gereksinim | Durum | Kanıt / not |
| --- | --- | --- | --- |
| 12.1–12.5 | Dosya yükleme, saklama, indirme | N/A | Kullanıcı dosyası yok; görüşme kaydı sunucudan S3'e (`api/modules/telephony/recording-store.ts`). |
| 12.6.1 | SSRF izin listesi | ✅ | 5.2.6 ile aynı. |

## V13 API ve web servisleri

| # | Gereksinim | Durum | Kanıt / not |
| --- | --- | --- | --- |
| 13.1.1 | Tutarlı ayrıştırıcılar | ✅ | Express JSON/urlencoded. |
| 13.1.3 | URL'de sır/token yok | ✅ | — |
| 13.1.4 | URI ve kaynak düzeyinde yetki | ✅ | Guard + sahiplik denetimleri (V4). |
| 13.1.5 | Beklenmeyen içerik türü reddi | ⚠️ | JSON uçları urlencoded gövdeyi de ayrıştırır (Nest varsayılanı). |
| 13.2.1 | Yalnız gereken HTTP yöntemleri | ✅ | Nest rotaları. |
| 13.2.2 | JSON şema doğrulaması | ⚠️ | 5.1.4. |
| 13.2.3 | REST CSRF | ✅ | Bearer. |
| 13.2.5 | Content-Type denetimi | ⚠️ | 13.1.5. |
| 13.2.6 | Başlık/gövde bütünlüğü (TLS) | ⚠️ | 9.1.1. |
| 13.3.x / 13.4.x | SOAP / GraphQL | N/A | — |

Ek (ASVS dışı, sayılmadı): WebSocket `/v1/ws/queue` — ilk mesajla 5 sn içinde token, rol denetimi, token süresi
dolunca 4401 ile kapanış, `maxPayload` 16 KB (`queue.gateway.ts`); `Origin` denetimi yok, çerez kullanılmadığı için
gerekmez. CPaaS webhook'ları: imza zorunlu, `timingSafeEqual` (`cpaas.ts:70-80`, `telephony.controller.ts:50-51`,
`notify.controller.ts:67-69`); Twilio imzası zaman damgası içermediğinden tekrar oynatma koruması yok (G-17).

## V14 Yapılandırma

| # | Gereksinim | Durum | Kanıt / not |
| --- | --- | --- | --- |
| 14.1.1 | Tekrarlanabilir derleme/dağıtım | ✅ | Çok aşamalı `Dockerfile`, `pnpm install --frozen-lockfile`, `ci.yml`. |
| 14.1.2 | Derleyici güvenlik bayrakları | ✅ | TypeScript `strict` (`tsconfig.base.json:6`). |
| 14.1.3 | Sunucu yapılandırması sıkılaştırılmış | ✅ | Güvenlik başlığı ara katmanı (`common/http-security.ts`), `x-powered-by` kapalı, salt okunur kap (`docker-compose.prod.yml`). |
| 14.1.4 | Otomatik, güvenli yeniden dağıtım | ⚠️ | Dağıtım manifestleri repoda yok. |
| 14.1.5 | Güvenlik yapılandırması bütünlüğü | ⚠️ | — |
| 14.2.1 | Bileşenler güncel | ✅ | Trivy (`ci.yml` `image`), `apk upgrade` (`Dockerfile:22`); Dependabot CI güvenlik işlerine ekleniyor. |
| 14.2.2 | Gereksiz özellikler kaldırılmış | ✅ | npm/corepack/yarn imajdan silinmiş (`Dockerfile:20-24`); üretimde sahte CPaaS yasak (`telephony.module.ts:28`), simülatör kapalı. |
| 14.2.3 | Harici varlıklarda SRI | N/A | Konsol varlıkları paketlenmiş. |
| 14.2.4 | Bileşenler güvenilir kaynaktan | ✅ | Kilit dosyası; sürümü sabit imajlar (`trivy:0.56.2`, `timescaledb:2.17.2-pg16`). |
| 14.2.5 | Bileşen envanteri (SBOM) | ✅ | SPDX SBOM, cosign attest (`release-image.yml`); BuildKit `sbom: true`. |
| 14.2.6 | Saldırı yüzeyi daraltma (sandbox) | ✅ | non-root; `read_only: true`, `cap_drop: [ALL]` (`infra/docker-compose.prod.yml`), Helm `securityContext`. |
| 14.3.2 | Üretimde debug kapalı | ✅ | `NODE_ENV=production` (`Dockerfile:19`), log düzeyi `log/warn/error` (`api/main.ts:10`), MFA kapatma yasak (`oidc-verifier.ts:53`). |
| 14.3.3 | Sürüm bilgisi sızmaz | ✅ | `x-powered-by` kapalı (`configureHttpSecurity`), Caddy `-Server`. |
| 14.4.1 | Content-Type + charset | ✅ | `application/problem+json` (`problem.filter.ts:43`), TwiML `text/xml; charset=utf-8`. |
| 14.4.2 | API yanıtlarında `Content-Disposition` | ✅ | Varsayılan `Content-Disposition: attachment; filename="api.json"`; kayıt indirme kendi değerini yazar. |
| 14.4.3 | CSP | ✅ | Konsol CSP (`infra/caddy/Caddyfile`: `default-src 'self'`, Keycloak + Twilio kökenleri); API `default-src 'none'`. Aile web (Next.js) yalnız `frame-ancestors`/`object-src`/`base-uri`; Helm ingress'te CSP yok. |
| 14.4.4 | `X-Content-Type-Options: nosniff` | ✅ | Caddy `security_headers` parçası (`infra/caddy/Caddyfile`). API'nin kendisi başlık koymaz (G-5). |
| 14.4.5 | HSTS | ✅ | Caddy `security_headers` parçası (`infra/caddy/Caddyfile`). API'nin kendisi başlık koymaz (G-5). |
| 14.4.6 | `Referrer-Policy` | ✅ | Caddy `security_headers` parçası (`infra/caddy/Caddyfile`). API'nin kendisi başlık koymaz (G-5). |
| 14.4.7 | `frame-ancestors` / `X-Frame-Options` | ✅ | Caddy `security_headers` parçası (`infra/caddy/Caddyfile`). API'nin kendisi başlık koymaz (G-5). |
| 14.5.1 | Yalnız gereken HTTP yöntemleri | ✅ | — |
| 14.5.2 | `Origin` kimlik doğrulamada kullanılmaz | ✅ | — |
| 14.5.3 | CORS izin listesi | ✅ | CORS etkin değil (`api/main.ts`); tarayıcıdan çapraz köken engelli. |
| 14.5.4 | Proxy başlıklarına güven yapılandırılmış | ✅ | `TRUST_PROXY` (atlama sayısı; compose / Helm: 1) → `req.ip` vekil arkasında doğru. |

## Açıklar (öncelik sırasıyla)

"Kritik" = kimliksiz saldırganın sağlık/kişisel veri okuması veya sahte acil olay üretmesi. Doğrulanmış kritik: yok.

| # | Öncelik | Bulgu | Önerilen düzeltme | Alan |
| --- | --- | --- | --- | --- |
| G-1 | **Yüksek** (kritiğe yakın) | Cihaz eşleştirme: 6 haneli kod (10⁶), sayaç yalnız IP başına 10 hata/15 dk (`api/modules/device/enrollment.service.ts:31-33, 131-133, 209-227`), global/IPv6-ağ sayacı yok. Doğrudan erişimde dağıtık saldırgan (ör. IPv6 /64 dönüşümü) o an etkin bir davet kodunu tahmin edip cihaz token'ı alır → o kişi adına **sahte SOS** (`POST /v1/signals`) ve günlük özet okuma; meşru eşleşme de "kod kullanılmış" hatası alır. `trust proxy` olmadan (`api/main.ts`) proxy arkasında tüm istemciler tek IP görünür → 10 hatayla tüm eşleşmeler 15 dk kilitlenir (DoS). | Global hata sayacı + IPv6 /64 gruplama; `trust proxy` yalnız bilinen ingress için; kod uzunluğu ≥ 8 (veya harf-rakam); yeni cihazda aileye bildirim/onay; sızma testinde doğrula. | backend (device) + altyapı |
| G-2 | Yüksek | Hız sınırı yok: `/v1/signals`, test-SOS, davet, telefoni. Token'ı ele geçmiş cihaz/hesap sınırsız olay → operatör kuyruğu ve Twilio arama/SMS maliyeti. | Ingress ve uygulama düzeyinde (cihaz/kullanıcı başına) hız sınırı; olay başına arama kotası; aşımda amir uyarısı. | backend + altyapı |
| G-3 | Yüksek | Simülatör varsayılanı açık-başarısız: `SIMULATOR_ENABLED` boşsa `NODE_ENV !== 'production'` iken token'sız sinyal kabul (`api/modules/device/simulator-mode.ts:5-8`, `device-token.guard.ts:41-45`); kayıtsız `deviceId` ile istenen `protectedPersonId` için olay açılır (`enrollment.service.ts:271-287` yalnız kayıtlı/kaldırılmış cihazı reddeder). Üretim imajı `NODE_ENV=production` ile korunuyor (`Dockerfile:19`); staging/başka ortamda `NODE_ENV` farklıysa sahte acil olay. | Varsayılan kapalı (yalnız `SIMULATOR_ENABLED=true` açar); `production` + `true` → açılış hatası; staging için açık karar. | backend |
| G-4 | Yüksek | `ADMIN_TOKEN`: MFA'sız, paylaşımlı, süresiz sır; tüm profillere, kişi listesine, iletişim kişilerine ve tıbbi özet yazmaya erişir (`profile.controller.ts:45-49`, `oidc.guard.ts:70-81`). | Üretimde boş zorunlu (açılış denetimi) veya yalnız `admin/rules` ile sınırla; betikler için Keycloak hizmet hesabı (client credentials). | backend + ops |
| G-5 | Orta | Güvenlik başlıkları ve CSP/HSTS yok; konsol token'ı `sessionStorage`'da → bir XSS operatör oturumunu (sağlık verisine erişim) çalar. | API'de güvenlik başlıkları ara katmanı ve `x-powered-by` kapatma; konsolu sunan sunucuda `CSP default-src 'self'; connect-src <api> <wss>; frame-ancestors 'none'`, HSTS, `nosniff`, `Referrer-Policy: no-referrer`. | backend + console + altyapı |
| G-6 | Orta | Kimlik doğrulama/erişim hataları loglanmıyor; Keycloak olay kaydı kapalı. | Guard'larda PII'siz güvenlik olayı log'u (sonuç, neden kodu, realm, istek kimliği); realm'lerde `eventsEnabled`, `adminEventsEnabled`; korelasyon kimliği. | backend + Keycloak |
| G-7 | Orta | Sırlar ortam değişkeninde, Vault/KMS yok; `DEVICE_TOKEN_SECRET` tek anahtar; `FIELD_ENC_KEYS` için yeniden şifreleme işi yok (`field-cipher.ts:59` yalnız `isStale`). | `sirlar.md`: External Secrets + Vault/KMS; `DEVICE_TOKEN_SECRETS` + `kid`; yeniden şifreleme işi. | altyapı + backend |
| G-8 | Orta | DB rol ayrımı yok; `health` şeması DB düzeyinde korunmuyor (tek sahip rol, migration'ı uygulama çalıştırıyor). | `sirlar.md` §6 rol/GRANT tasarımı (T-083 ile). | backend (DB) |
| G-9 | Orta | `consumers` realm: parola 8, ihlal denetimi yok, oturum 30/90 gün, değişiklik bildirimi yok. | `length(12)`, ihlal/kara liste politikası, SMTP + bildirim; oturum sürelerine risk kabulü veya kısaltma. | Keycloak |
| G-10 | Orta | Ad, telefon, adres düz metin; disk şifreleme kanıtı yok. | Yönetilen DB'de depolama şifrelemesi (kanıtla); telefonlar için alan şifreleme değerlendirmesi. | altyapı + backend |
| G-11 | Orta | DB/Redis/metrik iç trafiği için TLS ve Redis kimlik doğrulama kanıtı yok. | `sslmode=verify-full`, Redis ACL + TLS, metrikleri ağ politikasıyla sınırla. | altyapı |
| G-12 | Orta | Kişisel/sağlık verisi dönen yanıtlarda `Cache-Control: no-store` yok. | Global `no-store` (yalnız cihaz `config` ETag'li kalır). | backend |
| G-13 | Orta | Tehdit modeli yok. | STRIDE oturumu: cihaz → API, konsol, telefoni, aile. | güvenlik |
| G-14 | Orta | Mobil sertifika sabitleme uygulanmadı. | `sertifika-sabitleme.md`. | mobil |
| G-15 | Düşük | Metrik ucu kimliksiz, `0.0.0.0` (`metrics.service.ts:132-141`). | Varsayılan `127.0.0.1`/pod ağı + ağ politikası. | backend + altyapı |
| G-16 | Düşük | `X-Powered-By`, `Content-Disposition`, `nosniff` eksik. | G-5 ile birlikte. | backend |
| G-17 | Düşük | Webhook tekrar oynatma (Twilio imzası zaman damgasız). SMS durumu geri gitmez (`notify.service.ts:465-476`); telefoni webhook'larının tekrarına dayanıklılık testle doğrulanmalı. | Sağlayıcı `CallSid`/durum sırası ile idempotent işleme testi. | backend |
| G-18 | Düşük | `.dockerignore` alt dizindeki `.env` dosyalarını dışlamıyor. | `**/.env`, `**/.env.*`. | altyapı |
| G-19 | Düşük | SBOM yok. | İmaj için SBOM (CI güvenlik işleri; cosign attest). | CI |
| G-20 | Düşük | Keycloak `redirectUris` yalnız geliştirme; üretim realm ayarları repoda değil. | Üretim realm'i için birebir URI, `webOrigins` birebir köken. | Keycloak |

## T-080/T-081/T-083 PR'ı ile güncellenenler (puana dahil)

İlk değerlendirme %57,4 (116/202) idi. Aynı PR'da gelen CI güvenlik işleri (paket H: cosign, SBOM, PII log
denetimi) ve T-083 altyapı dosyaları aşağıdaki maddeleri ✅ yaptı → **%62,9 (127/202)**. Ayrıca Semgrep'in bulduğu
GCM etiket uzunluğu eksiği düzeltildi (`field-cipher.ts`: `authTagLength: 16`; 6.2.1 zaten ✅ sayılmıştı).
Altyapı maddeleri:

| Madde | Olası yeni durum | Dayanak |
| --- | --- | --- |
| 9.1.1 TLS | ✅ | Caddy ACME, HTTP→HTTPS |
| 14.4.4 nosniff, 14.4.5 HSTS, 14.4.6 Referrer-Policy, 14.4.7 X-Frame-Options | ✅ | `security_headers` parçası |
| 14.2.6 sandbox | ✅ | `read_only: true`, `cap_drop: [ALL]` |
| 1.14.1 metrik ayrımı | ✅ | 9464 yalnız iç ağ, vekilde yayınlanmıyor |
| 14.4.3 CSP | ❌ kalır | Konsol Caddyfile'da CSP yok |
| 14.3.3 sürüm bilgisi | ⚠️ | `-Server` var; Express `X-Powered-By` vekilden geçer |

Hedef (≥ %90) yine karşılanmıyor. Ayrıca `docker-compose.prod.yml`
`env_file: [.env.prod]` kullanıyor: "`.env` üretimde yok" kuralıyla çelişmemesi için dosya repo dışında, dağıtım
anında sır deposundan üretilmeli ve 600 izinli olmalı (`sirlar.md` §2–3).

## T-081 ikinci tur (2026-11-11) — puana dahil

Paket A (güvenlik başlıkları, CSP, `no-store`), C (güvenlik olayı log'u, korelasyon kimliği, Keycloak olayları +
e-posta bildirimi), D (hız sınırı, `TRUST_PROXY`), F'nin parola kısmı ve G'nin tehdit modeli kısmı yapıldı:
**%62,9 → %74,8 (151/202)**, ❌ 19 → 4. Giderilen bulgular: G-2 (hız sınırı), G-5 (API başlıkları + konsol CSP),
G-6 (güvenlik olayı log'u; Keycloak olayları DB'de, log'a kullanıcı adı / IP yazılmaz), G-12 (`no-store`), G-13
(`tehdit-modeli.md`), G-16; G-1 kısmen (gerçek IP + IP başına kayıt sınırı; dağıtık saldırgan sızma testinde), G-9
kısmen (parola 12; ihlal listesi ve oturum süreleri açık).

Kalan ❌: 2.1.7 ihlal edilmiş parola listesi (Keycloak `passwordBlacklist` dosyası her ortamda bağlanmalı), 2.1.8
parola gücü göstergesi (Keycloak teması), 6.4.1 / 6.4.2 sır yönetimi ve KMS (paket E, `sirlar.md`). %90 için ayrıca
paket B (üretim altyapısı kanıtı) şart.

## %90'a giden yol

Hedef: 202 uygulanabilir gereksinimin en az 182'si ✅ (ilk değerlendirme 116; paket H ve altyapının bir kısmı bu PR'da yapıldı, bugün 127). Paketler birbirinden bağımsız
sayılmıştır (aynı gereksinim iki pakette yok):

| Paket | Kapattığı gereksinimler | + ✅ | Toplam sonrası |
| --- | --- | --- | --- |
| A Güvenlik başlıkları, CSP, HSTS, `no-store` (G-5, G-12, G-16) | 14.1.3, 14.3.3, 14.4.2–14.4.7, 3.2.3, 8.1.1, 8.2.1 | 11 | 127 (%62,9) |
| C Güvenlik olayı log'u, Keycloak olayları + SMTP, korelasyon kimliği (G-6) | 7.1.3, 7.1.4, 7.2.1, 7.2.2, 2.8.5, 2.2.3, 2.5.5, 11.1.7, 11.1.8 | 9 | 136 (%67,3) |
| D Hız sınırı, kayıt sertleştirme, `trust proxy` (G-1, G-2) | 2.2.1 (cihaz), 8.1.4, 11.1.2, 11.1.3, 11.1.4, 14.5.4 | 6 | 142 (%70,3) |
| E Sırlar: Vault/KMS, `kid`'li cihaz anahtarı, yeniden şifreleme, `ADMIN_TOKEN` kaldırma (G-4, G-7) | 1.6.1, 1.6.2, 1.6.3, 6.4.1, 6.4.2, 2.10.1, 2.10.3, 1.2.4, 2.5.4, 3.5.2, 4.3.1 | 11 | 153 (%75,7) |
| H ✔ CI güvenlik işleri (cosign, SBOM, PII log denetimi) — bu PR'da yapıldı | 1.14.2, 10.3.2, 14.2.5, 7.1.2 | 4 | 157 (%77,7) |
| I İstek doğrulama (OpenAPI şeması, içerik türü), çıkışta token iptali | 5.1.4, 13.2.2, 13.1.5, 13.2.5, 3.3.1 | 5 | 162 (%80,2) |
| B Altyapı kanıtı (üretim manifestleri/ingress: TLS, iç TLS, Redis ACL, log deposu, NTP, ağ politikası, salt okunur FS, disk şifreleme) (G-10, G-11) | 1.2.2, 1.7.2, 1.9.1, 1.9.2, 1.14.1, 1.14.5, 9.1.1–9.1.3, 9.2.2–9.2.5, 7.3.3, 7.3.4, 14.1.4, 14.1.5, 14.2.6, 13.2.6, 6.1.1 | 20 | 182 (%90,1) |
| F `consumers` realm politikası (G-9, G-20) | 2.1.1 (consumers), 2.1.7, 3.3.2 (consumers), 3.5.1, 5.1.5 | 5 | 187 (%92,6) |
| G Süreç ve belgeler (tehdit modeli, kurtarma süreçleri, saklama, risk kabulleri) (G-13) | 1.1.1, 1.1.2, 1.1.4, 1.1.5, 2.5.6, 2.5.7, 8.3.2, 8.3.6, 8.3.8, 10.3.3 | 10 | 197 (%97,5) |

Yalnız bu repodaki kod/CI işleriyle (A, C, D, E, H, I) üst sınır ≈ %80; %90 için üretim altyapısının kanıtı (B)
şart, güvenli pay için F ve G de gerekir. Tahmini sıra: D ve E'nin `ADMIN_TOKEN` kısmı (yüksek bulgular) → A → C →
B (altyapı reposu ile) → F → G.
