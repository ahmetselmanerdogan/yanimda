# Risk kabulü kaydı

T-081, ASVS 8.3.6 / 3.3.2 / 8.2.2 / 3.5.1. Tarih: 2026-11-13 (R-4: 2026-11-17). Bir ASVS gereksinimi bilinçli olarak tam karşılanmıyorsa
burada gerekçe, telafi edici kontroller, önerilen karar ve gözden geçirme tarihiyle kaydedilir. **Kabul yalnız
hizmet sahibinin (ürün sahibi + güvenlik sorumlusu) adı, tarihi ve imzasıyla geçerlidir.** Bu belgedeki hiçbir
madde henüz imzalanmamıştır: R-1–R-3 **sahip onayı bekliyor** ("Önerilen karar" mühendislik önerisidir); R-4 sahibin
sözlü kararıdır (rotasyon operations'ta kapalı kalsın), imza alanı doldurulmalıdır.

Durum değerleri: `sahip onayı bekliyor` → `kabul edildi (ad, tarih)` / `reddedildi → iş açıldı (#)` / `süresi doldu`.

| # | ASVS | Konu | Önerilen karar | Gözden geçirme | Durum |
| --- | --- | --- | --- | --- | --- |
| R-1 | 8.3.6 | Node.js'te bellekteki hassas veri silinemiyor | Kabul, telafi kontrolleriyle | 2027-05 | **sahip onayı bekliyor** |
| R-2 | 3.3.2 | consumers realm oturum süreleri (14 gün boşta / 30 gün mutlak, çevrimdışı 14 gün boşta / 30 gün mutlak) | Koşullu kabul (yalnız mobil aile uygulaması) + 3 koşul (1. uygulandı) | 2027-02 | **sahip onayı bekliyor** |
| R-3 | 8.2.2 | Tarayıcıda token `sessionStorage`'da (konsol, aile web) | Geçici kabul, BFF'ye geçişe kadar | 2027-05 veya v2.0 | **sahip onayı bekliyor** |
| R-4 | 3.5.1 | operations realm'inde yenileme token'ı rotasyonu kapalı | Kabul (sahip kararı: kapalı kalsın) | 2027-05 | **kabul edildi** (sahip kararı 2026-11-17; ad/imza: —) |

---

## R-1 · Bellekteki hassas verinin silinmesi (ASVS 8.3.6)

**Gereksinim:** Hassas veri artık gerekmediğinde bellekten silinmeli (sıfırlanmalı).

**Durum:** Node.js / V8'de `string` değişmezdir ve çöp toplayıcının ne zaman sileceği belirsizdir; çözülmüş tıbbi
özet (`profile.service.ts` `eventCard`), kapı notu, telefon numarası ve JWT'ler `string` olarak yaşar. `Buffer`
sıfırlanabilir ama JSON ayrıştırma ve HTTP katmanı yine `string` üretir. Tam uyum dil değişikliği gerektirir.

**Tehdit:** Bellek dökümüne (core dump, heap snapshot, swap, süreç belleğini okuma) erişen saldırgan son çözülen
verileri okur. Bu erişim zaten konteyner / sunucu kökü düzeyinde ele geçirme demektir.

**Telafi edici kontroller (repoda):**

- Çözme yalnız olay anında, olayı üstlenen operatör için ve istek kapsamında; sonuç önbelleğe alınmaz, her çözüm
  `audit.log`'a yazılır (`health.medical_viewed`).
- Konteyner sertleştirme: root olmayan kullanıcı, `read_only: true`, `tmpfs: [/tmp]`, `cap_drop: [ALL]`
  (`infra/docker-compose.prod.yml`, Helm `securityContext`); `CMD ["node", "dist/main.js"]` — `--inspect` ve
  `--heapsnapshot-signal` yok (`apps/api/Dockerfile`).
- Log'da PII yok (CI denetimi), hata log'u `safeError` ile yalnız ad + kod.

**Önerilen karar:** Kabul. Koşullar: (a) üretim sunucusunda / düğümde çekirdek dökümü kapalı (`ulimit -c 0`,
`kernel.core_pattern` boşaltma) ve takas (swap) kapalı veya şifreli — altyapı kanıtı eklenir; (b) heap snapshot / debug
bayrağı üretim imajında yasak kalır (imaj testi `ci.yml` `image` ile denetlenebilir); (c) alan şifreleme anahtarları
KMS'e taşınınca (`sirlar.md`, G-7) anahtar materyali süreçte tutulmaz.

**Kalan risk:** Düşük (önkoşul: sunucu ele geçirilmiş). Sahip: — · Onay tarihi: —

---

## R-2 · consumers realm oturum süreleri (ASVS 3.3.2)

**Gereksinim:** L2 için boşta kalma ve mutlak oturum süresi risk değerlendirmesine göre belirlenir; uzun süreler
gerekçelendirilir.

**Durum:** `infra/keycloak/realm-consumers.json`: `ssoSessionIdleTimeout` 14 gün, `ssoSessionMaxLifespan` 30 gün,
`offlineSessionIdleTimeout` 14 gün, `offlineSessionMaxLifespan` 30 gün (`offlineSessionMaxLifespanEnabled: true`),
`offline_access` isteğe bağlı kapsam (mobil aile uygulaması). Erişim token'ı 5 dk. `family-web` istemcisi ayrıca
30 dk boşta / 12 sa mutlak. Aile web bu sürelerden etkilenmez: token `sessionStorage`'da, yenileme yok, 5 dk sonra
yeniden giriş (`apps/family-web/src/lib/oidc.ts`). Yenileme token'ı rotasyonu **yalnız consumers realm'inde açık**:
`revokeRefreshToken: true`, `refreshTokenMaxReuse: 0` (ASVS 3.5.1 ✅; operations realm'i için R-4).
`infra/keycloak/keycloak.test.mjs` bu sınırları denetler.

**Gerekçe:** Aile uygulaması acil durumda açılır (bildirimden olay ayrıntısı, "yoldayım", 112 süreci). Kullanıcı
çoğunlukla yaşlı yakınıdır; o anda parola sorulması müdahaleyi geciktirir. Push bildirimi oturumdan bağımsız gelir ama
ayrıntı ekranı token ister.

**Tehdit:** Çalınan / kaybolan telefonda 30 güne kadar (boşta 14 gün) geçerli çevrimdışı token ile kişinin adresi, kapı notu, olay
geçmişi görülür ve (OWNER ise) güvenlik ayarları değiştirilir.

**Önerilen karar:** Yalnız mobil aile uygulaması için koşullu kabul; boşta kalma 14 güne, mutlak süre 30 güne
indirildi (uygulandı). Koşullar:

1. `revokeRefreshToken: true` (her yenilemede dönüşüm; çalınan eski token kullanılınca oturum düşer) — **uygulandı**.
2. Uygulamada etkin oturumları görme / kapatma (ASVS 3.3.4) ve yeni cihazdan girişte e-posta bildirimi (Keycloak
   `email` dinleyicisi zaten açık).
3. Yenileme token'ı yalnız güvenli depoda (iOS Keychain `ThisDeviceOnly`, Android Keystore) ve uygulama kilidinde
   cihaz biyometrisi / ekran kilidi şartı (`sertifika-sabitleme.md` ile aynı mobil sürüm).

Alternatif (reddedilirse): `ssoSessionIdleTimeout` 7 gün, `ssoSessionMaxLifespan` 30 gün, `offline_access` kaldırılır.

**Kalan risk:** Orta → koşullarla düşük. Sahip: — · Onay tarihi: —

---

## R-3 · Token'ların tarayıcı `sessionStorage`'ında tutulması (ASVS 8.2.2)

**Gereksinim:** Kimlik doğrulama token'ları gibi hassas veriler tarayıcı depolarında (localStorage, sessionStorage,
IndexedDB) tutulmamalı.

**Durum:**

- Konsol (`apps/console/src/lib/auth.ts`): oidc-client-ts, `userStore: sessionStorage`, `automaticSilentRenew` ile
  yenileme token'ı da `sessionStorage`'da; operations realm oturumu 1 saat boşta / 12 saat mutlak, MFA zorunlu.
- Aile web (`apps/family-web/src/lib/oidc.ts`): yalnız erişim token'ı (5 dk), yenileme yok.

**Tehdit:** Başarılı bir XSS, `sessionStorage`'dan token'ı okuyup dışarı taşır. Konsolda bu, olay anında tıbbi
özete erişen operatör yetkisidir (I3).

**Telafi edici kontroller (repoda):** Konsol CSP `script-src 'self'`, `frame-ancestors 'none'`, HSTS
(`infra/caddy/Caddyfile`); üçüncü taraf betik yok (paketlenmiş varlıklar); React kaçışlama; `sessionStorage`
sekmeye özgü ve sekme kapanınca silinir (`localStorage` değil); erişim token'ı 5 dk; API'de tıbbi özet yalnız
üstlenilen olayda ve her çözüm denetimde; ZAP baseline her PR'da.

**Önerilen karar:** v2.0'a kadar geçici kabul. Kalıcı çözüm: BFF (sunucu tarafı oturum, `HttpOnly; Secure;
SameSite=Strict` çerez, token tarayıcıya hiç gelmez) — konsol ve aile web için ayrı iş. Ara adım (önerilir): konsolda
yenileme token'ı yerine Keycloak oturumuyla sessiz yenileme (`prompt=none`) ve `userStore` bellek içi; aile web zaten
yenilemesiz. Koşul: CSP'de `unsafe-inline` / `unsafe-eval` eklenmez; eklenirse kabul düşer.

**Kalan risk:** Orta (XSS önkoşulu, CSP ile azaltılmış). Sahip: — · Onay tarihi: —

---

## R-4 · operations realm'inde yenileme token'ı rotasyonu kapalı (ASVS 3.5.1)

**Gereksinim:** OAuth yenileme token'ları iptal edilebilir olmalı; L2 için her kullanımda döndürme (rotasyon) ve
tekrar kullanımda oturumun düşmesi önerilir.

**Durum:** Rotasyon yalnız `consumers` realm'inde açık (R-2). `infra/keycloak/realm-operations.json`'da
`revokeRefreshToken` tanımlı değil (Keycloak varsayılanı: kapalı). Operasyon oturumu: SSO 1 sa boşta / 12 sa mutlak,
OTP zorunlu (API `amr` içinde `otp` ister), erişim token'ı 5 dk; token yalnız `sessionStorage`'da (R-3).

**Gerekçe:** Konsol birden çok sekmede (kuyruk, olay kartı, amir panosu) aynı istemci oturumunu paylaşır. Rotasyonda
bir sekmenin sessiz yenilemesi diğer sekmenin elindeki yenileme token'ını geçersiz kılar ve operatör **acil olayın
ortasında** oturumdan düşer; yeniden giriş (parola + OTP) müdahaleyi geciktirir.

**Tehdit:** Sızan bir yenileme token'ı (XSS, R-3) oturum süresince (en çok 12 sa) yeni erişim token'ı almak için
kullanılabilir; meşru oturum bunu fark etmez.

**Karar:** Sahip kararı (2026-11-17): rotasyon operations realm'inde **kapalı kalır**. Dengeleyiciler: 12 sa mutlak /
1 sa boşta SSO, zorunlu OTP, 5 dk erişim token'ı, CSP `script-src 'self'` (XSS önkoşulunu daraltır), Keycloak
olayları ve yönetici oturum kapatma. Yeniden değerlendirme: BFF'ye geçişte (R-3) veya oturum hırsızlığı olayında.

**Kalan risk:** Düşük–orta (XSS önkoşulu, 12 sa ile sınırlı). Sahip: ürün + güvenlik · Karar tarihi: 2026-11-17 ·
İmza: —
