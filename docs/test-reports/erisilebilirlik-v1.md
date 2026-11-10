# T-082 Test raporu: erişilebilirlik (v1, otomatik denetim)

Tarih: 2026-11-11 · Dal: `claude/t082-a11y` · Kapsam: TASKS-DETAY T-082 adım (1) otomasyonu. Adım (2) kullanıcı testi
(5 yaşlı + 5 aile) **yapılmadı**: gerçek katılımcı ve oturum gerektirir (§4).

## Özet

| Yüzey | Araç | Sonuç |
| --- | --- | --- |
| Operatör konsolu (web) | axe-core (Playwright), CI `konsol uçtan uca` | ✅ ciddi/kritik ihlal 0: kuyruk + olay kartı (T-023'ten beri), **amir panosu** (bu PR'da eklendi) |
| Aile web (abonelik) | axe-core WCAG 2.1 A/AA (Playwright, API taklit), CI `lint · test` | ✅ 0 ihlal: kayıt sihirbazı her adım (paket, hesap formu, **hatalı gönderim**, telefon kodu), KVKK, Hesabım; klavyeyle tamamlanabilir, odak görünür; 320 px (≈ %400 yakınlaştırma) yatay kaydırma yok (WCAG 1.4.10) |
| Aile uygulaması (Flutter) | `meetsGuideline` (Android 48 dp / iOS 44 pt dokunma hedefi, etiketli hedef) + tema kontrast hesabı | ✅ giriş, ana sayfa, olaylar, profil, ayarlar. **2 bulgu düzeltildi** (§2) |
| Saat (Wear OS), Android telefon | Accessibility Scanner / Espresso `AccessibilityChecks` | ⏳ yapılmadı (§4) |
| iOS (T-073) | Xcode Accessibility Inspector | ⏳ yapılmadı (iOS uygulaması cihazda denenmedi) |

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
| Dokunma hedefi ≥ 48 dp (Android) / 44 pt (iOS) | ✅ aile uygulaması tüm ana ekranlar · ⏳ saat, telefon |
| Ekran okuyucu etiketi (her dokunulabilir öğe) | ✅ aile uygulaması (`labeledTapTargetGuideline`), web (axe `button-name`, `label`, `link-name`) |
| Metin kontrastı AA | ✅ web (axe `color-contrast`), aile uygulaması (tema çiftleri, 2 düzeltme) |
| Klavye ile kullanım, görünür odak | ✅ aile web kayıt · konsol klavye kısayolları T-023/T-026'da |
| Yeniden akış (320 px) | ✅ aile web |
| Form hataları alana bağlı | ✅ aile web (hatalı gönderimde axe 0) |
| Büyük yazı (sistem yazı boyutu 200%) | ⏳ elle denetim (saat ve telefon) |

## 4. Açık

- **Kullanıcı testi (adım 2):** 5 yaşlı + 5 aile ile 04 protokolü; kritik görevler %100. Katılımcı ve oturum
  gerekiyor; bulgular PRD'ye gereksinim olarak eklenecek (adım 3).
- **Saat ve Android telefon:** Espresso `AccessibilityChecks.enable()` ile Compose ekran testleri ve Accessibility
  Scanner turu; sistem yazı boyutu 200% ve TalkBack ile SOS / "İyiyim" akışı.
- **iOS:** Xcode Accessibility Inspector ve VoiceOver turu (T-073 cihazda denenince).
