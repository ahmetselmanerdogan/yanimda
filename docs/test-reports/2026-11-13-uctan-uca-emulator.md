# Uçtan uca emülatör koşusu — saat, telefon, sunucu, konsol, aile (2026-11-13)

Yapı: ana repo `main` (ec33de4) + bu dal; yerel depolar `yanimda-wear` t095-e2e-fixes, `yanimda-android` t082-a11y.
Yığın: `stack:local` (PGlite + Redis + API, gerçek kural süreleri), gerçek Keycloak (operator1, family1), sahte CPaaS,
MinIO. Cihazlar: Android 16 telefon emülatörü, Wear OS 5 saat emülatörü. Emülatörler Data Layer ile eşleşemediği için
saat debug `DEV_CONFIG` ile kendi token'ıyla doğrudan (LTE yolu) gönderdi. Ana makine yükü yüksekti (8 çekirdek, swap).

## Koşulan akış

| # | Adım | Sonuç |
| --- | --- | --- |
| 1 | Aile hesabı kişi + rehber + davet; telefon davet bağlantısıyla eşleşti, kurulum sihirbazı, "Deneme gönder" | ✔ TEST olayı kuyrukta |
| 2 | Saat kaydı (davet → `WEAROS_WATCH`), varsayılan arama uygulaması rolü, ana ekran "Korunuyor" | ✔ |
| 3 | Operatör TEST çağrısını üstlendi; saatte YARDIM 3 sn → SOS + taze konum | ✔ sinyaller ulaştı, olay SOS P1'e yükseldi |
| 4 | Konsol: yükseltilmiş olayın zinciri | ✘ → düzeltildi (bulgu 1) |
| 5 | Zincir: saati ara → ulaşıldı → acil durum → 112 metni → masa hattı → ulaşıldı → DISPATCH → kapat (takip 24 sa) | ✔ (DISPATCH'te bulgu 2) |
| 6 | Aile bildirimleri | ✔ F-EVT-SOS ve F-EVT-112 (sesli + SMS, 2 yakın); aile API'si olayı DISPATCH görür |
| 7 | Saat test menüsü sahte düşme → 60 sn soru → cevap yok → kuyruk | ✘ → düzeltildi (bulgu 3); sonra ✔ (FALL ~1,7 sn'de, 60. sn'de kuyruk, F-EVT-FALL) |
| 8 | Saat "Beni arayın" | ✘ → düzeltildi (bulgu 3) |
| 9 | Telefon YARDIM 3 sn | ✔ SOS ~2 sn'de, açık düşme olayına eklendi (FALL + SOS = FALL, P1) |

## Bulgular

1. **Sunucu (D-03), ciddi:** operatördeki TEST olayına SOS gelince olay SOS'a yükseliyor ama zincir yalnız adım işleminin
   içinde yeniden planlanıyordu. Konsol eski adım numarasını gönderince 409 "Sıra dışı adım" ve yeniden planlama geri
   alınıyordu: operatör zinciri hiç ilerletemiyor, GET eski TEST metnini (`O-SCRIPT-TEST`) ve 112'siz planı gösteriyordu.
   Düzeltme: `ChainService.replanIfStale` — olay okunurken ve adım işleminden önce, olayı tutan operatör adına ayrı
   transaction'da yeniden planlama. Test: `event-upgrade.spec.ts` (konsol yolu, 2 yeni).
2. **Konsol (E-06), ciddi:** DISPATCH'te `DevicePanel` ve `DispatchPanel` aynı React anahtarını (olay kimliği) kullanıyordu;
   cihaz paneli her yenilemede çoğalıyor (40 kopya), konsol başka olay seçemiyordu. Düzeltme: ayrı anahtarlar. Test:
   Playwright T-052 ve S3'e "DISPATCH'ten 2,5 sn sonra tek cihaz paneli" (düzeltmesiz 10 kopya).
3. **Saat (yerel `yanimda-wear`):** ekran düğmeleri işi ekranın coroutine kapsamında başlatıp hemen ana ekrana dönüyordu.
   Test menüsü sahte düşme/SOS hiç sinyal yazmıyordu; "Beni arayın" isteği anında gönderilmiyor (~35 sn sonra
   WorkManager) ve onay ekranı çıkmıyordu. Düzeltme: uygulama ömürlü `graph.scope`.
4. **Saat durum rozeti:** HEARTBEAT'ler bilerek 30 dk toplu bekletilirken 2 dk'dan eski her bekleyen sinyal "Dikkat ·
   Bağlantı yok" sayılıyordu; saat çalışırken çoğu zaman sarı görünüyordu. Düzeltme: HEARTBEAT ancak toplu bekleme + 2 dk
   aşılınca.
5. **Saat eşleşme ekranı:** yapılandırma DataItem ile geldiğinde telefona "hello" başarılı olana kadar W-PAIR'de kalıyordu.
   Düzeltme: eşleşme gerekmiyorsa döngüden çık.

## Açık (karar / iz)

- Yükseltilen olayda (TEST → SOS) yaş, ilk arama ve 112 son sınırı ilk olayın (TEST) zamanından sayılıyor; SOS ilk
  anda "süre aşıldı" görünür. Alarm saatlerinin yükseltme anından başlaması ürün kararı.
- Telefon kurulumunda "Kontrol et": saat bulunamaz ve Wear OS eşlikçi uygulaması yoksa ekranda geri bildirim yok.
- Konsol değer özelliği kapalıyken her yenilemede `/events/{id}/vitals` çağırıp 404 alıyor (zararsız gürültü).
- Yerelde `packages/contracts/dist` eski kalırsa `ladder.spec.ts` (SILENT) kırılır; CI derlediği için etkilenmez. Depoda
  `packages/contracts/src/index.js` / `.d.ts` derleme çıktısı izleniyor (eski, SILENT yok).
- Yapılmadı: gerçek Data Layer eşleşmesi, gerçek arama (CPaaS), FCM/APNs push, aile uygulaması/web arayüzü (aile tarafı
  API ve bildirim kayıtlarıyla doğrulandı), iOS.
