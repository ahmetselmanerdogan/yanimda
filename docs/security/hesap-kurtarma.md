# Hesap kurtarma: parola ve OTP kaybı

T-081, ASVS 2.5.6 (unutulan parola akışı güvenli) ve 2.5.7 (OTP / MFA kaybında güvenli kurtarma). Tarih: 2026-11-13.
Kimlik sağlayıcı Keycloak'tır (`infra/keycloak/realm-operations.json`, `realm-consumers.json`); API parola veya OTP
görmez. Komutlar Keycloak yönetici CLI'ı (`kcadm.sh`) iledir; yönetici konsolu aynı işlemleri yapar.

## 1. İlkeler

- **Kurtarma, normal girişten zayıf olamaz.** operations realm'inde MFA (TOTP) zorunludur ve API üretimde MFA'sız
  token'ı reddeder (`oidc-verifier.ts`: `OIDC_REQUIRE_MFA=false` üretimde açılış hatası). Kurtarmada MFA geçici
  olarak kapatılmaz; yalnız kaybolan faktör sıfırlanıp yeniden kurdurulur.
- **Kimlik, talebin geldiği kanaldan bağımsız doğrulanır.** Talep e-posta / telefonla gelir; doğrulama, kayıtlı başka
  bir kanaldan (yüz yüze, İK'da kayıtlı numaraya geri arama) yapılır. Saldırgan çoğu zaman tek kanalı ele geçirmiştir.
- **Dört göz:** işlemi yapan, talep edenden farklıdır; ADMIN / SUPERVISOR hesabı için ikinci bir yöneticinin onayı.
- **Parola / OTP sırrı sohbetle, e-postayla, biletle iletilmez.** Keycloak'ın süreli eylem bağlantısı (e-posta)
  veya yüz yüze verilen geçici parola (ilk girişte değiştirme zorunlu) kullanılır.
- **Her kurtarma kayıtlıdır:** bilet numarası; Keycloak yönetici olayları (`adminEventsEnabled: true`) ve kullanıcı
  olayları (90 gün); parola / OTP değişikliği kullanıcıya e-postayla bildirilir (`eventsListeners: ["email"]`).
- Kurtarma sonrası tüm oturumlar kapatılır.

## 2. operations realm (operatör, amir, yönetici)

Self-servis kapalı: `resetPasswordAllowed: false`, `registrationAllowed: false`. Kurtarma yalnız yönetici destekli.

### 2.1 Kimlik doğrulama (her iki durumda)

1. Talep, kişinin amiri üzerinden açılır (bilet). Talep eden kişi kendi hesabının kullanıcı adını söyler.
2. Doğrulama: **yüz yüze** (çağrı merkezinde, kimlik kartı) veya **görüntülü görüşme + geri arama**: amir kişiyi
   tanır ve işlemi yapan yönetici kişiyi İK kaydındaki numaradan geri arar (talepte verilen numara kullanılmaz).
3. Hesap ADMIN / SUPERVISOR ise ikinci yönetici bilete onay yazar.
4. Doğrulama başarısızsa veya şüpheli (kişi vardiyada değil, alışılmadık saat, ısrarlı aciliyet): işlem yapılmaz,
   güvenlik olayı olarak kaydedilir; hesap geçici olarak devre dışı bırakılabilir (`-s enabled=false`).

### 2.2 Parolayı unuttu (2.5.6)

OTP cihazı kişide ve sağlamsa yalnız parola sıfırlanır; OTP kaydına dokunulmaz.

```sh
kcadm.sh config credentials --server "$KC_URL" --realm master --user "$KC_ADMIN"   # yönetici (kendi hesabıyla)
ID=$(kcadm.sh get users -r operations -q username="$KULLANICI" --fields id --format csv --noquotes)
# Tercih: kayıtlı e-postaya süreli "parola belirle" bağlantısı (15 dk)
kcadm.sh update "users/$ID/execute-actions-email" -r operations -q lifespan=900 -b '["UPDATE_PASSWORD"]'
# E-posta yoksa: yüz yüze verilen geçici parola, ilk girişte değiştirme zorunlu
kcadm.sh set-password -r operations --userid "$ID" --temporary   # parolayı istemle sorar; komut satırına yazılmaz
kcadm.sh create "users/$ID/logout" -r operations                   # tüm oturumları kapat
```

Yeni parola realm politikasına uyar (`length(12) and notUsername and passwordHistory(5)`). Giriş yine TOTP ister.

### 2.3 OTP cihazını kaybetti / değiştirdi (2.5.7)

1. §2.1 doğrulaması (yüz yüze tercih edilir).
2. Eski OTP kaydını sil, yeniden kurmayı zorunlu kıl, oturumları kapat:

```sh
kcadm.sh get "users/$ID/credentials" -r operations --fields id,type     # type=otp olanın id'si
kcadm.sh delete "users/$ID/credentials/$OTP_CRED_ID" -r operations
kcadm.sh update "users/$ID" -r operations -s 'requiredActions=["CONFIGURE_TOTP"]'
kcadm.sh create "users/$ID/logout" -r operations
```

3. Kişi bir sonraki girişte parola + yeni TOTP kurulumu yapar (`CONFIGURE_TOTP` zorunlu eylem).
4. Cihaz çalındıysa veya parola da açığa çıkmış olabilirse §2.2 da uygulanır; son 90 günün Keycloak giriş olayları ve
   API `audit.log` (`actor_id` = kişinin `sub`) incelenir; olağandışı erişim varsa `sirlar.md` sızıntı müdahalesi.

**Önerilen (sahip onayı bekliyor):** Keycloak "Recovery Authentication Codes" ikinci yedek faktör olarak açılsın;
böylece OTP kaybında kişi yönetici olmadan girer, yönetici süreci yalnız kodlar da kaybolunca işler. Keycloak realm
dosyaları ayrı iş paketinde değiştirilir.

## 3. consumers realm (aile hesabı) — self-servis

Aile hesabında OTP yoktur (2.5.7 bu realm için uygulanmaz); telefon kayıt sırasında bizim OTP'mizle doğrulanır
(`consumer-accounts.ts`, `phone_number_verified`) ama giriş faktörü değildir.

### 3.1 Parolayı unuttu (2.5.6)

Hedef akış Keycloak'ın yerleşik "Parolamı unuttum" akışıdır:

- Giriş sayfasında bağlantı → e-posta adresi → **hesap var olsun olmasın aynı yanıt** (kullanıcı sayımı yok) →
  kayıtlı adrese süreli, tek kullanımlık bağlantı → yeni parola (realm politikası: `length(12) and maxLength(128) and
  notUsername and notEmail and passwordHistory(3)`) → tüm oturumlar kapanır, değişiklik e-postayla bildirilir.
- Kaba kuvvet koruması (`bruteForceProtected`, `failureFactor: 10`) parola denemelerine uygulanır; sıfırlama
  bağlantısı tek kullanımlık ve sürelidir.

**Repo durumu (origin/main, 2026-11-13):** `realm-consumers.json`'da `resetPasswordAllowed` tanımlı değil
(Keycloak varsayılanı `false`) → bağlantı görünmez; SMTP tanımlı (`smtpServer`). Yapılacak: `resetPasswordAllowed:
true` ve eylem bağlantısı ömrü ≤ 15 dk (`actionTokenGeneratedByUserLifespan`). Keycloak dosyaları ayrı iş
paketinde değiştirilir; bu yapılana kadar §3.2 destek süreci uygulanır.

### 3.2 E-postaya erişimi yok / destekten yardım isteniyor

1. Talep destek hattına gelir; bilet açılır.
2. Kimlik doğrulama (en az ikisi): kayıtlı telefona gönderilen tek seferlik kod (kayıt akışındaki doğrulamayla aynı
   numara); abonelikteki son ödemenin tarihi ve tutarı (sağlayıcı panelinden); korunan kişinin adı ve kurulu cihaz
   sayısı. Sorular kişiye sorulur, cevap verilmez.
3. Destek yeni e-postayı yazar ve doğrulama + parola bağlantısı gönderir; eski adrese bildirim gider:

```sh
kcadm.sh update "users/$ID" -r consumers -s email="$YENI" -s emailVerified=false
kcadm.sh update "users/$ID/execute-actions-email" -r consumers -q lifespan=900 -b '["VERIFY_EMAIL","UPDATE_PASSWORD"]'
kcadm.sh create "users/$ID/logout" -r consumers
```

4. Şüpheli talepte (telefon da değişmiş, ödeme bilgisi tutmuyor) işlem yapılmaz; hesap sahibi yüz yüze / noter
   onaylı belgeyle başvurur. Korunma (SOS, düşme) bu sürede kesilmez: cihazlar aile hesabından bağımsız çalışır.

## 4. Cihaz (saat / telefon) — hesap kurtarma değil

Cihaz token'ı kaybolursa / cihaz çalınırsa: aile uygulamasından cihaz kaldırılır (`DELETE /v1/devices/{id}`, token
anında geçersiz), yeni cihaz yeni eşleştirme koduyla kaydedilir (`profile.controller.ts` `invite`).

## Açık işler

| # | İş |
| --- | --- |
| K-1 | consumers `resetPasswordAllowed: true` + eylem bağlantısı ömrü (Keycloak iş paketi) |
| K-2 | operations "Recovery Authentication Codes" kararı (sahip onayı) |
| K-3 | Destek hattı için kimlik doğrulama soru listesi ve bilet şablonu (operasyon) |
