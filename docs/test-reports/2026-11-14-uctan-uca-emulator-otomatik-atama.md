# Uçtan uca emülatör koşusu 2 — otomatik atama açık (2026-11-14)

Yapı: ana repo `main` (067ef01) + bu dal; yerel depolar `yanimda-wear` t095-e2e-fixes (b2523c6, aşağıdaki saat
düzeltmesi dahil), `yanimda-android` t082-a11y (d8acc40), `yanimda-family` t092-vital-settings, `yanimda-ios` t082-a11y.
Yığın: `stack:local` (PGlite + Redis + API, gerçek kural süreleri), gerçek Keycloak (operator1, supervisor1, family1),
sahte CPaaS, MinIO; konsol Vite ile, Playwright ile gerçek Keycloak girişi (parola + OTP). Cihazlar: Android 16 telefon
emülatörü, Wear OS 5 saat emülatörü (debug `DEV_CONFIG` ile kendi token'ıyla doğrudan). Amir panosunda otomatik atama
açık, tek operatör. Ana makine çok yüklüydü (yük ortalaması 12–88; aynı anda ölçüm oturumu, Gradle ve Xcode derlemeleri).

## Koşulan akış

| # | Adım | Sonuç |
| --- | --- | --- |
| 1 | Aile hesabı kişi + rehber + davet; telefon davet bağlantısıyla eşleşti, sihirbaz, "Deneme gönder" | ✔ TEST olayı 1,6 sn'de operatöre teklif |
| 2 | Teklif 20 sn kabul edilmedi | ✔ olay kuyruğa döndü, operatör molaya (`status_by` system), amir panosunda "cevapsız" |
| 3 | Moladan dönüş ("Müsait") → teklif → Enter | ✘ → düzeltildi (bulgu 2) |
| 4 | Saatte YARDIM 3 sn → SOS | ✔ basmadan 4,8 sn sonra olay (bırakmadan ~1,3 sn), 0,4 sn sonra teklif, Enter ile kabul |
| 5 | Zincir: saati ara → ulaşıldı → acil durum → 112 metni (GPS konumu) → sabit hat → DISPATCH → kapat (takip 24 sa) | ✔ |
| 6 | Saat test menüsü sahte düşme → 60 sn soru → cevap yok | ✔ FALL 0,7 sn'de; 60,8 sn'de kuyruk, 0,7 sn sonra teklif, Enter ile kabul |
| 7 | Telefonda YARDIM 3 sn (açık düşme olayı varken) | ✔ SOS 6,7 sn'de, düşme olayına eklendi (yeni olay yok) |
| 8 | Saat "Beni arayın" | ✔ istek 1 sn'de, onay ekranı, CALLBACK olayı otomatik atandı |
| 9 | Aile bildirimleri | ✔ F-EVT-SOS, F-EVT-112, F-EVT-FALL: iki yakına SMS, birinciye sesli arama |
| 10 | Konsol olay okuması (kişi kartı, metin) teklifi kabul saymıyor | ✔ bekleyen teklif 5 sn sonra hâlâ açık |
| 11 | Telefon `adb reboot` → koruma servisi | ⚠ süreç açılıştan ~3 dk sonra başladı (BOOT_COMPLETED yük altında gecikti), başlangıçta ANR |

Otomatik atama: 9 teklif; 5 kabul (teklif → kabul 0,2–0,7 sn, geri arama 16,8 sn), 4 cevapsız (biri bulgu 2, üçü
bilerek veya sürücü gecikmesiyle). Teklif olay kuyruğa düştükten 0,4–1,9 sn sonra geldi.

## Bulgular

1. **Saat (yerel `yanimda-wear`, A-09), orta:** 401'de token siliniyor ama teslim döngüsü kuyruğu **token'sız**
   göndermeyi sürdürüyordu. Simülatörü açık sunucu (yerel geliştirme) bunları kabul etti: saat önceki koşunun kişi
   kimliğiyle 280 HEARTBEAT gönderdi, sunucu veritabanında olmayan kişi için operatöre "Yerinde kontrol" ve "Kapsama
   boşluğu" olayları açtı ("Kişi bilgisi yok", metinde "bilinmiyor"). Staging ve üretimde `SIMULATOR_ENABLED=false`
   olduğundan orada hayalet olay oluşmaz, ama saat token'sız isteklerle sonsuz 401 döngüsündeydi. Telefon ve iOS
   etkilenmiyor (401'de token'ı tutup yeniden eşleşme ister). Düzeltme: `RoutingTransport` token yoksa doğrudan yola
   çıkmaz (`Retry(401)`, sinyal kuyrukta bekler); token'sız gönderim yalnız debug token'sız eşleşmede. Test: `ApiTest`
   (2 yeni; önce kırmızı).
2. **Konsol (E-02), ciddi:** operatör moladan dönerken "Müsait"e tıklıyor, odak orada kalıyor. Teklif gelince Enter
   (kartta "Kabul et Enter" yazıyor) odaklı düğmede kısayol olarak çalışmadığından yeniden "Müsait"e basılıyor; teklif
   20 sn sonra cevapsız düşüyor, operatör molaya alınıyordu. Koşuda 1 sn kala basılan Enter kabul etmedi. Düzeltme:
   yeni teklif açılınca odak "Kabul et"e taşınır; operatör bir alana yazıyorsa odak alınmaz (Enter yanlışlıkla kabul
   etmesin). Test: Playwright otomatik atama senaryosu artık "Müsait" tıklar, odağın "Kabul et"te olduğunu denetler ve
   Enter ile kabul eder (düzeltmesiz kırmızı).

## Açık (gözlem / karar)

- Teklif edilmiş ama kabul edilmemiş olayın durum rozeti "Üstlenildi" (durum OPERATOR_ASSIGNED). "Teklif edildi" gibi
  ayrı bir rozet amir ve operatör için daha doğru olur.
- Simülatör modunda (yalnız geliştirme) token'sız sinyal, veritabanında olmayan kişi için de kabul ediliyor ve kapsama
  denetimi bu kişi için olay açıyor. Üretimi etkilemez; geliştirmede kayıtsız kişiyi reddetmek değerlendirilebilir.
- Telefon kurulumunda "Kontrol et": saat bulunamadığında ekranda hâlâ geri bildirim yok (önceki koşudan açık).
- Telefon emülatöründe tekrarlanan ANR'ler (`onStartJob` yanıtı yok, giriş zaman aşımı, açılışta 30 sn) aynı anda
  Google Play hizmetleri ve sistem sürecinde de görüldü; emülatör 3 gündür açıktı ve ana makine aşırı yüklüydü.
  Gerçek cihazda T-045 protokolüyle (adım 5) yeniden bakılmalı.
- Yapılmadı:
  - iOS eşlikçi: derlendi ve ayrı simülatöre kuruldu, eşleşme ekranı açıldı; davet bağlantısının sistem onayına
    ("Yanımda ile açılsın mı?") dokunmak için simülatör erişim izni gerekiyordu.
  - Aile uygulaması: iOS simülatör derlemesi eski derleme çıktısındaki mimari denetiminde kırıldı (`flutter clean`
    gerekir); Android derlemesi kuruldu, giriş emülatördeki Chrome'un ilk açılış (hizmet şartları) ekranında kaldı.
  - Gerçek Data Layer eşleşmesi, gerçek arama (CPaaS), FCM/APNs push.
