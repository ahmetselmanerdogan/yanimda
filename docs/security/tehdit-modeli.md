# Tehdit modeli (STRIDE)

T-081, ASVS 1.1.2 (G-13). Kapsam: v1.0 mimarisi (`docs/03-teknik-mimari.md`). Tarih: 2026-11-11. Her tasarım
değişikliğinde (yeni uç, yeni dış servis, yeni veri türü) ilgili bölüm güncellenir; PR açıklamasında "tehdit modeli
etkisi: yok / bölüm X güncellendi" yazılır.

## Varlıklar

| Varlık | Neden değerli | Nerede |
| --- | --- | --- |
| Acil olayın zamanında işlenmesi | Hayati: gecikme veya kayıp doğrudan zarar | `signal` → outbox → `event`, operatör kuyruğu |
| Sağlık verisi (tıbbi özet) | Özel nitelikli kişisel veri (KVKK m.6) | `health.medical_summary` (AES-256-GCM alan şifreleme) |
| Kişi, adres, kapı erişim notu, iletişim zinciri | Kişisel veri; adres + kapı notu fiziksel risk | `profile` şeması (kapı notu şifreli) |
| Görüşme kayıtları | Ses (sağlık bilgisi içerebilir) | S3 nesne kilidi, yalnız gerekçeli erişim + audit |
| Operatör / yönetici oturumu | Tüm kişilere ve sağlık verisine erişim | Keycloak `operations` (MFA), konsol `sessionStorage` |
| Cihaz token'ı | Kişi adına sinyal üretme | Saat / telefon güvenli depolama |
| Arama / SMS bütçesi | Maliyet ve hat kapasitesi | CPaaS hesabı |

## Güven sınırları

1. Saat / telefon → API (`/v1/signals`, `/v1/devices/*`): cihaz token'ı (JWT, `kid`'siz tek anahtar — G-7).
2. Aile uygulaması / aile web → API: Keycloak `consumers` realm (FAMILY).
3. Konsol → API + WebSocket: Keycloak `operations` realm (OPERATOR / SUPERVISOR / ADMIN, MFA zorunlu).
4. CPaaS / SMS / ödeme / ön eleme sağlayıcısı → webhook uçları: sağlayıcı imzası.
5. API → veri depoları (Postgres, Redis, S3): iç ağ (TLS kanıtı G-11).
6. Operatör → 112: insan, telefon (sistem dışı; süreç takibi `dispatch` modülünde).

## STRIDE

| # | Sınır | Tehdit | Örnek senaryo | Önlem (repoda) | Kalan risk / iş |
| --- | --- | --- | --- | --- | --- |
| S1 | 1 | **Kimlik sahteciliği** | Ele geçirilmiş / tahmin edilen eşleştirme kodu ile sahte cihaz kaydı → sahte SOS | 6 haneli kod 15 dk, tek kullanım; IP başına hata sayacı; `POST /devices/enroll` hız sınırı (IP, 20/10 dk); `TRUST_PROXY` ile gerçek IP | Dağıtık saldırgan (G-1): sızma testinde doğrulanacak |
| S2 | 1 | Kimlik sahteciliği | Bir cihazın token'ıyla başka kişinin sinyalini göndermek | `assertOwnBatch` + köprü denetimi (`CompanionService`) → 403 | — |
| S3 | 3 | Kimlik sahteciliği | Operatör parolası oltalaması | MFA (TOTP) zorunlu, `bruteForceProtected`, parola ≥ 12 | WebAuthn (v2) |
| S4 | 4 | Kimlik sahteciliği | Sahte CPaaS webhook'u ile arama sonucunu "cevaplandı" göstermek | Twilio imza doğrulaması; webhook hız sınırı | Zaman damgasız imza → tekrar oynatma (G-17) |
| T1 | 1 | **Kurcalama** | Sinyal içeriğinin (konum, tür) yolda değişmesi | TLS (Caddy ACME, HSTS); şema doğrulaması | Mobil sertifika sabitleme (G-14) |
| T2 | 5 | Kurcalama | Audit kaydının silinmesi | `audit.log` yalnız ekleme (append-only) | DB rol ayrımı (G-8) |
| R1 | 3 | **İnkâr** | Operatörün "112'yi aradım" demesi, aramamış olması | Her geçişte `actorKind`/`actorId`/`at`; 112 bildirimi kaydı, kapanışta `event.closed_without_112` + amir uyarısı; kayıt erişimi gerekçeli + audit | 112 tarafı teyidi sistem dışı (manuel prosedür) |
| R2 | 2 | İnkâr | Aile "test SOS'u ben başlatmadım" | Test SOS idempotency + audit (aktör kimliği) | — |
| I1 | 1–3 | **Bilgi ifşası** | Log'a ad / telefon / adres yazılması | Log'da PII yok kuralı; `safeError`; CI PII log denetimi (e2e); güvenlik olayı log'u yalnız rota şablonu + istek kimliği | — |
| I2 | 2 | Bilgi ifşası | Başka ailenin kişisini görmek (IDOR) | Sahiplik denetimi → 404; MEMBER yazamaz (403) | — |
| I3 | 3 | Bilgi ifşası | XSS ile konsol token'ının çalınması → sağlık verisi | CSP `script-src 'self'` (Caddy), React kaçışlama, `frame-ancestors 'none'` | Helm ingress'te CSP yok (Caddy dağıtımı esas) |
| I4 | 1–3 | Bilgi ifşası | Paylaşılan / vekil önbelleğinde profil yanıtı | API varsayılanı `Cache-Control: no-store` | — |
| I5 | 5 | Bilgi ifşası | Yedekten / diskten sağlık verisi | Alan şifreleme (sağlık, kapı notu); S3 nesne kilidi | Disk şifreleme kanıtı (G-10), KMS (G-7) |
| D1 | 1 | **Hizmet engelleme** | Kötü niyetli / bozuk cihaz saniyede yüzlerce sinyal → kuyruk taşması | `/signals` cihaz başına 600/dk; **alarm sinyalleri (SOS, FALL, INACTIVITY, CANCEL, OK, CALLBACK_REQUEST) hiç sınırlanmaz**; Redis yoksa sınır açık | — |
| D2 | 2 | Hizmet engelleme / maliyet | Kayıt akışında SMS bombalama, test SOS ile arama maliyeti | Kayıt IP başına 10/sa, SMS kodu 5/sa, test SOS kişi başına 6/sa (ve 10 dk kuralı), davet 10/sa | — |
| D3 | 5 | Hizmet engelleme | Redis / Postgres kesintisi | Outbox (olay kaybı 0), Postgres kapalıyken 503 + cihaz tamponu; kaos testleri CI'da | — |
| E1 | 3 | **Yetki yükseltme** | OPERATOR'ün yönetim uçlarına erişmesi | Rol denetimi (`Roles`, `MANAGEMENT_ROLES`); 403 güvenlik olayı olarak loglanır | — |
| E2 | — | Yetki yükseltme | `ADMIN_TOKEN` sızıntısı → tüm profiller | Üretimde kısıtlama planı | G-4: hizmet hesabına geçiş |

## İzleme

- API: `yanimda_security_events_total{status,route}` (400/401/403/422/429). `SecurityEventsSpike` uyarısı
  (`infra/monitoring/alerts.yml`): 10 dk'da 200'den fazla 401/403/429. İlk adım: Grafana'da rota kırılımı; tek
  rotada 401 artışı → kimlik bilgisi denemesi / süresi dolmuş istemci; 429 artışı → hız sınırına takılan cihaz
  sürümü veya saldırı; istek kimliği (`X-Request-Id`) ile API log'una git.
- Keycloak: realm olay kaydı açık (`eventsEnabled`, 90 gün, DB'de; log'a yazılmaz çünkü kullanıcı adı / IP içerir),
  yönetici olayları açık (ayrıntısız). Parola / OTP değişikliği ve hatalı giriş kullanıcıya e-posta ile bildirilir
  (`email` dinleyicisi).

## Gözden geçirme

Sızma testi planı (`sizma-testi-plani.md`) bu tablodaki "kalan risk" sütununu öncelik sırası olarak kullanır.
