# iOS simülatör koşusu — eşlikçi ve aile uygulaması (2026-11-15)

Yapı: ana repo `main` (94e4775) + bu dal; yerel depolar `yanimda-ios` t082-a11y (e0df839) + `pair-device-limit`,
`yanimda-family` t092-vital-settings (bbe215f), `yanimda-android` setup-watch-not-found + `pair-device-limit`.
Yığın: `stack:local` (PGlite + Redis + API), gerçek Keycloak, sahte CPaaS. Cihaz: iPhone 17 simülatörü, iOS 26.4;
Xcode 27.2, Flutter 3.41.6. Önceki koşuda (2026-11-14) iOS denenmemişti: simülatör erişim izni yoktu.

## Koşulan akış

| # | Adım | Sonuç |
| --- | --- | --- |
| 1 | Eşlikçi temiz kurulum, açılış | Eşleşme ekranı ("Aileniz size 6 haneli bir kod gönderdi…") |
| 2 | Aile API'siyle davet, `yanimda://invite?code=…` | Kod alana dolar, 6. hanede kendiliğinden gönderilir |
| 3 | Kişinin zaten Android telefonu var | **Bulgu 1** (aşağıda) |
| 4 | Telefonu olmayan ikinci kişiye davet | Eşleşti; izin adımları (bildirim, konum "Her zaman", Sağlık "Sonra") |
| 5 | Ana ekran | "Telefon koruyor"; Sağlık atlanınca "Bir izin eksik. Sorun yok, yardım edeceğiz." |
| 6 | YARDIM 3,6 sn basılı | "Yardım çağrılıyor. Operatörümüz birazdan arayacak."; sunucuda P1 SOS, `OPERATOR_QUEUE` |
| 7 | Aile uygulaması, "Giriş yap" | Uygulama içi tarayıcıda Keycloak `consumers` giriş sayfası; parola adımı denenmedi |

## Bulgular

1. **Telefon eşleşmesi (B-01 / T-085), orta:** kişinin zaten bir telefonu varken `POST /devices/enroll` 409
   `code: F-DEVICE-LIMIT` döner (davet kodu tüketilmez, aileye F-DEVICE-LIMIT gider). iOS ve Android telefon her
   409'u "bu deviceId sunucuda etkin" sayıp yeni deviceId ile bir kez daha deniyor, ikinci 409'da yaşlıya
   P-PAIR-WRONG ("Kod doğru değil veya süresi dolmuş. Ailenizden yeni kod isteyin.") gösteriyordu. Aile yeni kod
   üretse de sonuç aynı; asıl çözüm (eski telefonu kaldırmak) hiçbir yerde söylenmiyordu.
   Düzeltme: istemci 409'u `code` ile ayırır. F-DEVICE-LIMIT → yeni katalog mesajı P-PAIR-LIMIT ("Bu kişiye bağlı
   başka bir telefon var. Ailenizden eski telefonu uygulamadan kaldırmasını isteyin."), yeniden deneme yok; kodsuz
   409 eskisi gibi yeni kimlikle bir kez daha. Ana repoda katalog + OpenAPI notu; yerel `yanimda-ios` ve
   `yanimda-android` `pair-device-limit` dallarında istemci (testler önce kırmızı). Simülatörde doğrulandı: aynı
   adımda artık P-PAIR-LIMIT görünüyor.
2. **Aile uygulaması iOS simülatör derlemesi (araç), düşük:** `flutter build ios --simulator` Xcode 27.2'de
   `debug_unpack_ios` adımında kırılıyor: "Flutter.framework/Flutter does not contain architectures arm64 x86_64",
   oysa `lipo -info` iki mimariyi de gösteriyor. Neden: bu `lipo` sürümünde `-verify_arch` yalnız tek mimari kabul
   ediyor ("requires exactly one input file"); Flutter 3.41.6 iki mimariyi tek çağrıda denetliyor. `flutter clean`
   çözmez. Geçici: `FLUTTER_XCODE_ARCHS=arm64 flutter build ios --simulator --debug …`. Depoda değişiklik yok;
   Flutter/Xcode güncellemesiyle yeniden bakılmalı.

## Gözlem

- Simülatörde konum "Her zaman" yükseltmesi için sistem penceresi çıkmıyor; uygulama 8 sn bekleyip sonraki adıma
  geçiyor (`LocationService.requestAlways`, bilinçli sınır). Gerçek cihazda T-045 ile bakılmalı.
- Eski bir Debug kurulumunun üstüne kurulunca UserDefaults'taki demo kişi (`dev-pair`) kalıyor ve davet bağlantısı
  yok sayılıyor (Debug'da demo eşleşme "eşli" sayılır). Yalnız geliştirme; temiz kurulumda yok.

## Yapılmadı

- Aile uygulamasında giriş sonrası ekranlar (parola girişi kullanıcıya bırakıldı).
- Gerçek APNs, gerçek arama, gerçek cihaz.
