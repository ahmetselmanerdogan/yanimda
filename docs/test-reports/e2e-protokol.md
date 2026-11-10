# T-045 Uçtan uca cihaz testi — protokol

Amaç: saat → telefon → API → konsol zincirinin gecikmesi (kabul: 20 tekrar sahte düşmede **p95 < 5 sn**), tamponun
kayıpsız ve çiftsiz teslimi, 24 saat pil payı. Sonuç raporları bu klasörde `YYYY-AA-GG-t045-*.md`.

## Cihaz laboratuvarı

| Rol | Cihaz | Not |
| --- | --- | --- |
| Telefon (emülatör) | Android 16 (API 36) Google APIs arm64, Pixel 6 profili | yerel yığına `10.0.2.2` |
| Telefon (gerçek) | Samsung Galaxy A-serisi (Android 14+), Pixel (Android 15+) | sahada; pil ve hoparlör testi |
| Saat (gerçek) | Galaxy Watch 6/7 (Wear OS 5) | Galaxy Wearable ile telefona eşli |
| Saat (emülatör) | Wear OS 5 emülatörü | telefon emülatörüyle eşleştirme Android Studio "Pair Wearable" sihirbazı |
| Sunucu | `stack:local` (Redis + PGlite + API) veya staging | gerçek kural süreleri |

## Adımlar

1. **Hazırlık** — ana repo `pnpm install`; Android: `./gradlew :phone:installDebug -PyanimdaApi=http://10.0.2.2:3300/v1/`
   (gerçek cihazda bilgisayarın LAN adresi veya staging). İzinler kurulum sihirbazıyla ya da `adb shell pm grant`.
2. **Otomatik ölçüm (sahte saat)** — `LAB_RUNS=20 STACK_API_PORT=3300 pnpm --filter @yanimda/api exec tsx
   test/e2e/device-lab.ts`. Betik yığını açar, kişi + davet üretir, `adb` ile davet bağlantısını açar (telefon
   eşleşir), debug "sahte saat"i tanıtır (telefon saati `companions` ile kaydeder), sonra 20 kez FALL → olay → CANCEL
   yapar. Ölçülen: saatin sinyal anı → API'ye kalıcı yazılış (`signal.received_at`) ve → olayın oluşması
   (`event.created_at`, konsolda DEVICE_PROMPT olarak görünür). Sahte saat Data Layer yerine aynı `Engine.bridge`
   yolunu çağırır; BLE gecikmesi (tipik 50–300 ms) ölçüme dahil değildir.
3. **Gerçek saat** — saatte test menüsü "Sahte düşme" (T-030), konsolda olayın görünme anı kronometreyle; 20 tekrar;
   telefon `adb logcat -s Yanimda` köprü/teslim satırları zaman damgalı.
4. **Çevrimdışı tampon** — telefon uçak modunda 10 sahte sinyal → `signal_queue` 10 satır; uçak modu kapanınca
   sırayla teslim, sunucuda `duplicates` hariç çift yok.
5. **Servis dayanıklılığı (B-05)** — `adb shell am kill app.yanimda.device` ve son uygulamalardan kaydırma → servis
   bildirimi ≤ 1 dk içinde geri; `adb reboot` → açılışta servis.
6. **Saat çıkarma (B-06)** — saat bilekten çıkarılınca ≤ 30 sn'de telefon şeridi amber (P-HOME-WATCH-OFF); 2 saat →
   P-WATCH-OFF-2H bildirimi (test için saat ileri alınabilir).
7. **Operatör araması (T-054)** — `OPERATOR_CALLER_IDS` numarasından arama (emülatörde
   `adb emu gsm call <numara>`): cevaplanınca hoparlör açık, ses en yüksek; saatte "telefonunuzu açın".
8. **Pil 24 saat** — telefon ve saat tam şarj, normal kullanım; `adb shell dumpsys batterystats --reset`, 24 saat
   sonra `dumpsys batterystats` + Battery Historian; uygulama payı < %10 (saat T-034 ile ortak rapor).

## Kayıt

Her koşu için: tarih, yapı (git sha), cihazlar, tur sayısı, p50/p95/maks, çift sayısı, başarısız adımlar ve nedeni.
Log'larda PII yok (kişi adı "Lab", konum yok).
