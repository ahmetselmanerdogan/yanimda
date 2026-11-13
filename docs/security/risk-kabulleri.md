# Risk kabulü kaydı

T-081, ASVS 8.3.6 / 3.3.2 / 8.2.2. Tarih: 2026-11-13. Bir ASVS gereksinimi bilinçli olarak tam karşılanmıyorsa
burada gerekçe, telafi edici kontroller, önerilen karar ve gözden geçirme tarihiyle kaydedilir. **Kabul yalnız
hizmet sahibinin (ürün sahibi + güvenlik sorumlusu) adı, tarihi ve imzasıyla geçerlidir.** Bu belgedeki hiçbir
madde henüz onaylanmamıştır: hepsi **sahip onayı bekliyor**; "Önerilen karar" mühendislik önerisidir.

Durum değerleri: `sahip onayı bekliyor` → `kabul edildi (ad, tarih)` / `reddedildi → iş açıldı (#)` / `süresi doldu`.

| # | ASVS | Konu | Önerilen karar | Gözden geçirme | Durum |
| --- | --- | --- | --- | --- | --- |
| R-1 | 8.3.6 | Node.js'te bellekteki hassas veri silinemiyor | Kabul, telafi kontrolleriyle | 2027-05 | **sahip onayı bekliyor** |
| R-2 | 3.3.2 | consumers realm oturum süreleri (30 gün boşta / 90 gün mutlak, çevrimdışı 90 gün) | Koşullu kabul (yalnız mobil aile uygulaması) + 3 koşul | 2027-02 | **sahip onayı bekliyor** |
| R-3 | 8.2.2 | Tarayıcıda token `sessionStorage`'da (konsol, aile web) | Geçici kabul, BFF'ye geçişe kadar | 2027-05 veya v2.0 | **sahip onayı bekliyor** |

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

**Durum:** `infra/keycloak/realm-consumers.json`: `ssoSessionIdleTimeout` 30 gün, `ssoSessionMaxLifespan` 90 gün,
`offlineSessionIdleTimeout` 90 gün, `offline_access` isteğe bağlı kapsam (mobil aile uygulaması). Erişim token'ı 5 dk.
Aile web bu sürelerden etkilenmez: token `sessionStorage`'da, yenileme yok, 5 dk sonra yeniden giriş
(`apps/family-web/src/lib/oidc.ts`). `revokeRefreshToken` kapalı (yenileme token'ı dönüşümlü değil, ASVS 3.5.1 ⚠️).

**Gerekçe:** Aile uygulaması acil durumda açılır (bildirimden olay ayrıntısı, "yoldayım", 112 süreci). Kullanıcı
çoğunlukla yaşlı yakınıdır; o anda parola sorulması müdahaleyi geciktirir. Push bildirimi oturumdan bağımsız gelir ama
ayrıntı ekranı token ister.

**Tehdit:** Çalınan / kaybolan telefonda 90 güne kadar geçerli çevrimdışı token ile kişinin adresi, kapı notu, olay
geçmişi görülür ve (OWNER ise) güvenlik ayarları değiştirilir.

**Önerilen karar:** Yalnız mobil aile uygulaması için koşullu kabul; koşullar karşılanana kadar boşta kalma 14 güne
indirilir. Koşullar:

1. `revokeRefreshToken: true` (her yenilemede dönüşüm; çalınan eski token kullanılınca oturum düşer).
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
