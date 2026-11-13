# T-082 Test raporu: erişilebilirlik (v1, otomatik denetim)

Tarih: 2026-11-11 · Dal: `claude/t082-a11y` · Kapsam: TASKS-DETAY T-082 adım (1) otomasyonu. Adım (2) kullanıcı testi
(5 yaşlı + 5 aile) **yapılmadı**: gerçek katılımcı ve oturum gerektirir (§4).

## Özet

| Yüzey | Araç | Sonuç |
| --- | --- | --- |
| Operatör konsolu (web) | axe-core (Playwright), CI `konsol uçtan uca` | ✅ ciddi/kritik ihlal 0: kuyruk + olay kartı (T-023'ten beri), **amir panosu** (bu PR'da eklendi) |
| Aile web (abonelik) | axe-core WCAG 2.1 A/AA (Playwright, API taklit), CI `lint · test` | ✅ 0 ihlal: kayıt sihirbazı her adım (paket, hesap formu, **hatalı gönderim**, telefon kodu), KVKK, Hesabım; klavyeyle tamamlanabilir, odak görünür; 320 px (≈ %400 yakınlaştırma) yatay kaydırma yok (WCAG 1.4.10) |
| Aile uygulaması (Flutter) | `meetsGuideline` (Android 48 dp / iOS 44 pt dokunma hedefi, etiketli hedef) + tema kontrast hesabı | ✅ giriş, ana sayfa, olaylar, profil, ayarlar. **2 bulgu düzeltildi** (§2) |
| Saat (Wear OS), Android telefon | Compose semantik denetimi (Robolectric; etiket, 48 dp, yazı 2,0, kontrast) | ✅ 12 bulgu düzeltildi (§5); cihazda TalkBack / Scanner turu açık |
| iOS (T-073) | XCUITest `performAccessibilityAudit()` + kontrast birim testleri | ✅ 9 bulgu düzeltildi (§6); cihazda VoiceOver turu açık |

## 1. Çalıştırma

```bash
pnpm --filter @yanimda/family-web test:a11y      # aile web (next build && next start; API taklit)
pnpm --filter @yanimda/console test:e2e          # konsol (Keycloak + API gerekir; CI'da)
cd ../yanimda-family && flutter test test/a11y_test.dart
```

## 2. Bulgular ve düzeltmeler

| # | Yüzey | Bulgu | Düzeltme |
| --- | --- | --- | --- |
| 1 | Aile uygulaması, açık tema | Birincil düğme ("Giriş yap" vb.) beyaz metin / zemin **3,66:1** (< 4,5). `ColorScheme.fromSeed` marka renginden daha açık bir ton türetiyordu | Açık temada birincil = marka rengi `#2F4F8F` (≈ 8:1) |
| 2 | Aile uygulaması, koyu tema | Hata zemini üstünde metin **2,33:1** (`onError` türetilmiş koyu ton) | `onError` beyaz (≈ 5,6:1) |

Web yüzeylerinde ciddi/kritik ihlal çıkmadı. Flutter widget testlerinde ekran görüntüsünden kontrast ölçümü
(`textContrastGuideline`) test yazı tipinin kenar yumuşatması yüzünden güvenilir değil (aynı düğme 4,22 ölçüldü,
hesap 8:1); kontrast bu yüzden tema renk çiftlerinden (birincil, yüzey, yüzey varyantı, hata, ikincil; açık ve koyu)
WCAG formülüyle hesaplanır.

## 3. Kontrol listesi (04 UX/UI) karşılığı

| Madde | Durum |
| --- | --- |
| Dokunma hedefi ≥ 48 dp (Android) / 44 pt (iOS) | ✅ aile uygulaması tüm ana ekranlar · saat, Android telefon (§5) · iOS (§6) |
| Ekran okuyucu etiketi (her dokunulabilir öğe) | ✅ aile uygulaması (`labeledTapTargetGuideline`), web (axe `button-name`, `label`, `link-name`), saat, telefon, iOS (§5, §6) |
| Metin kontrastı AA | ✅ web (axe `color-contrast`), aile uygulaması (tema çiftleri, 2 düzeltme), saat, telefon (açık + koyu), iOS (§5, §6) |
| Klavye ile kullanım, görünür odak | ✅ aile web kayıt · konsol klavye kısayolları T-023/T-026'da |
| Yeniden akış (320 px) | ✅ aile web |
| Form hataları alana bağlı | ✅ aile web (hatalı gönderimde axe 0) |
| Büyük yazı (sistem yazı boyutu 200%) | ✅ otomatik: saat ve telefon yazı 2,0, iOS AX5 (§5, §6) · ⏳ gerçek cihazda bakım |

## 4. Açık

- **Kullanıcı testi (adım 2):** 5 yaşlı + 5 aile ile 04 protokolü; kritik görevler %100. Katılımcı ve oturum
  gerekiyor; bulgular PRD'ye gereksinim olarak eklenecek (adım 3).
- **Saat ve Android telefon (gerçek cihaz):** TalkBack turu (YARDIM çift dokunma → SOS, düşme sorusu → İyiyim, gelen
  arama, kurulum sihirbazı, eşleşme kodu; odak sırası, canlı bölge duyuruları), Accessibility Scanner uygulaması
  (gerçek renkler, yuvarlak ekran köşeleri), en büyük yazı + ekran boyutu (Android 14+ doğrusal olmayan ölçekleme),
  döner taçla kaydırma, tile'ın TalkBack okunuşu.
- **iOS (gerçek cihaz):** VoiceOver turu (eşleşme → sihirbaz → ana ekran → YARDIM → İyiyim → Sensörler), %200 yazı ile
  SOS ve İyiyim, P-INACT-1 sesli okuma ile VoiceOver çakışması, gerçek Bluetooth izin durumu (simülatörde
  denetlenemedi), AX5 başlık bölünmesi kararı.

## 5. Saat (Wear OS) ve Android telefon — otomatik denetim (2026-11-13)

Dal: `yanimda-wear` ve `yanimda-android` depolarında `t082-a11y` (yerel). Çalıştırma: `./gradlew test` (JVM, Robolectric;
emülatör gerekmez). Testler: saat 87 → 97, telefon 113 → 121; `lint` ve `ktlintCheck` temiz.

### Araç

Compose UI testleri Robolectric'te (`@GraphicsMode(NATIVE)`: gerçek metin ölçümü); `A11yAudit` yardımcısı semantik ağacı
denetler. Accessibility Scanner kurallarının JVM karşılığı:

| Kural | Ölçüm |
| --- | --- |
| Etiket (SpeakableTextPresent) | Dokunulabilir her öğede metin ya da contentDescription |
| Dokunma hedefi | ≥ 48 dp (Android, Wear) |
| Büyük yazı | Yazı ölçeği 1,0 ve 2,0: metin kesilmez, kısa etiket sözcük ortasından bölünmez, ekran dışı metin kaydırılabilir |
| Kontrast | Tema/token renk çiftlerinden WCAG 2.1 (4,5:1; büyük metin 3:1), telefonda açık + koyu tema |

ATF (`AccessibilityValidator`) Robolectric'te Compose düğümlerini görmüyor (kasıtlı hatalı öğede 0 sonuç); bu yüzden
semantik ağaç denetimi kullanıldı. Cihazda Scanner turu ayrıca gerekir.

### Kapsanan ekranlar

- **Saat** (192 dp yuvarlak): ana ekran (YARDIM, Beni arayın), şarj, geri arama, izin, eşleşme, düşme ve hareketsizlik
  sorusu (geri sayım + İyiyim), SOS gönderildi / Saate bakın / Teşekkürler, gelen arama (operatör, diğer), test menüsü,
  tile düğmeleri.
- **Telefon** (360 dp): eşleşme, kurulum sihirbazının 12 adımı, ana ekran (çalarken dahil), İyiyim, Sensörler. Açık ve
  koyu tema.

### Bulgular ve düzeltmeler

| # | Yüzey | Bulgu | Düzeltme |
| --- | --- | --- | --- |
| 1 | Saat, YARDIM | Basılı tutma düğmesinin semantiği yoktu: TalkBack bulamıyor ve tetikleyemiyordu | Düğme rolü + etiket; çift dokunma tetikler (telefonla aynı) |
| 2 | Saat, tema | `onPrimary` / `onError` siyah: marka mavisinde 2,64:1, kırmızıda 3,74:1 | Beyaz: 7,97:1 ve 5,62:1 |
| 3 | Saat, "Saate bakın" (amber) | Beyaz metin 2,35:1 | Koyu metin (`neutral.textLight`): 7,42:1 |
| 4 | Saat, yazı 2,0 | Sabit yükseklikli düğmelerde etiket kesiliyor; soru, bilgi, arama, izin, eşleşme, geri arama ekranlarında taşma | Düğmeler `heightIn(min = 64 dp)`; ekranlar kaydırılabilir (dokunma + döner taç); İyiyim her boyutta görünür |
| 5 | Saat, yazı 2,0 | "YARDIM" sözcük ortasından bölünüyordu | Daire 1,5 kata kadar büyür, etiket tek satır ve sığacak kadar küçülür |
| 6 | Saat, gelen arama | Operatör dışı aramada cevapla düğmesi yalnız simge | Etiket "Cevapla" (W-CALL-1 eylemi) |
| 7 | Saat, gelen arama | Kapat düğmesi yalnız simge | Etiket "Aramayı bitir" (`W-CALL-END`) |
| 8 | Saat, tile | Düğmelerde rol/etiket yok | ProtoLayout semantiği: düğme rolü + görünen etiket |
| 9 | Telefon, düğmeler | Amber "İzin ver" ve "SOS kuyrukta" şeridinde beyaz metin 2,35:1 | Koyu metin: 7,42:1 |
| 10 | Telefon, renkli metin | Açık temada amber uyarı 2,35:1; koyu temada kırmızı hata 3,33:1, gri özet 3,52:1, ikincil düğme 2,35:1 | Renk zeminle AA tutmuyorsa tema metin rengi |
| 11 | Telefon, eşleşme | Kod alanının ekran okuyucu etiketi yok | Görünür alan etiketi "Eşleştirme kodu" (`P-PAIR-CODE`); P-PAIR yönerge olarak üstte |
| 12 | Telefon, YARDIM | İç "YARDIM" ve ipucu ayrı odak: aynı metin iki kez okunuyordu | Tek odak; etiket tek satır; TalkBack ipucu `P-SOS-HOLD-VO` (çift dokunma) |

Bulgu çıkmayanlar: telefonda 2,0 yazıda kesilme yok (ekranlar zaten kaydırılabilir); dokunma hedefleri ≥ 48 dp. 192 dp
saatte 2,0 yazıda satırdan uzun sözcükler ("Telefonunuzdaki") bölünüyor; metin kesilmiyor, gerçek saatte bakılmalı.

## 6. iOS eşlikçi (T-073) — Xcode erişilebilirlik denetimi (2026-11-13)

Dal: `yanimda-ios` `t082-a11y` (yerel). Araç: XCUITest `performAccessibilityAudit()` (Xcode 27.2, iPhone 17 simülatörü,
iOS 27.2) + YanimdaKit kontrast birim testleri (WCAG 2.1, tokens.json çiftleri). Birim testler 104 → 109; UI denetimi
17 test, 0 hata; SwiftLint temiz.

**Ekranlar:** eşleşme, izin sihirbazı (bildirim, konum, Sağlık, hazır), ana ekran (durum kartı, P-PERM, YARDIM),
Sensörler, SOS tamponda, "İyiyim". Her biri normal yazı, en büyük erişilebilirlik boyutu (AX5) ve koyu temada.
Uygulama Debug'daki `-YanimdaUITestScenario` ile belirlenimli açılır (API yok, sinyal yok); Release'de bu kip yok.

    xcodebuild test -scheme Companion -destination 'platform=iOS Simulator,name=iPhone 17'

| # | Ekran | Bulgu | Düzeltme |
| --- | --- | --- | --- |
| 1 | Sihirbaz "Sonra", ana ekran "Sensörler", Sensörler "Kapat"/"Kaldır" | Dokunma alanı 24–26 pt (< 44) | İkincil düğme stili: satır ≥ 56 pt |
| 2 | SOS tamponda kartı | Amber zeminde beyaz metin 2,35:1 | Zemine göre metin rengi: 7,4:1 |
| 3 | Ana ekran P-PERM, eşleşme uyarıları, P-INACT-OK | Amber metin açık zeminde 2,13:1; yeşil metin 4,29:1 | Metin birincil renkte, simge renkli |
| 4 | Koyu tema ikincil düğmeler | Marka rengi siyah zeminde 2,64:1 | Koyu temada `neutral.textDark` |
| 5 | YARDIM, eşleşme kod alanı | Dynamic Type yok (sabit 40/44 pt) | `@ScaledMetric`; daire en çok 320 pt |
| 6 | İzin sihirbazı | Başlık kırpılıyor, kaydırma yok | Kaydırılabilir düzen |
| 7 | Ana ekran durum kartı (AX5) | "Telefonunuz" sözcük ortasından bölünüyordu | AX boyutlarında simge metnin üstünde |
| 8 | Sensörler izin düğmesi | Boş etiket: P-PERM-BLUETOOTH-IOS'un eylem metni yoktu | Katalogda `action: "İzin ver"` (bu PR) |
| 9 | VoiceOver (kod incelemesi) | Sihirbaz adımı ve SOS kartı duyurulmuyor | `ScreenChanged` / `Announcement`, başlık özelliği |

VoiceOver metinleri: YARDIM ipucu `P-SOS-HOLD-VO` "Yardım çağırmak için iki kez dokunun." (VoiceOver'da çift dokunma
hemen gönderir; "3 saniye basılı tutun" ipucu yanıltıcıydı), "İyiyim" geri sayımının etiketi `P-PROMPT-LEFT`
"{sec} saniye kaldı." Birim testler 109.

**Açık:** AX5'te uzun Türkçe sözcükler başlıkta bölünüyor ("Operatörümü/z"); başlığı sınırlamak denetimde Dynamic Type
hatası veriyor. Karar: tasarım sınırı (denetim istisnası), heceleme veya kısa metin.
