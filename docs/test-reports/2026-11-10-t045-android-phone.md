# T-045 Android telefon — cihaz laboratuvarı (2026-11-10)

Yapı: ana repo dalı claude/android-phone-docs-20bc3f, yanimda-android debug APK. Telefon: Android 16 (API 36) emülatörü; yığın stack:local (PGlite + Redis + API, gerçek kural süreleri). Saat: debug sahte saat (Engine.bridge yolu; BLE hop dahil değil). Emülatör saati ana makineye eşitlendi, kalan fark betikte düzeltildi. Ana makine yükü çok yüksekti (load avg ~50).

| # | saat → API (ms) | saat → olay (ms) |
| --- | --- | --- |
| 1 | 8086 | 8164 |
| 2 | 1611 | 1643 |
| 3 | 138 | 159 |
| 4 | 240 | 282 |
| 5 | 292 | 309 |
| 6 | 106 | 122 |
| 7 | 289 | 349 |
| 8 | 220 | 236 |
| 9 | 73 | 83 |
| 10 | 103 | 117 |
| 11 | 170 | 222 |
| 12 | 212 | 229 |
| 13 | 100 | 110 |
| 14 | 183 | 194 |
| 15 | 44 | 67 |
| 16 | 37 | 53 |
| 17 | 166 | 180 |
| 18 | 115 | 135 |
| 19 | 83 | 92 |
| 20 | 299 | 316 |

Tur: 20 · saat→API p50 166 ms, p95 1611 ms, maks 8086 ms · saat→olay p50 180 ms, p95 1643 ms, maks 8164 ms · çift sinyal: 0 · saat farkı düzeltmesi -741 ms (±19 ms)

Sonuç: p95 1643 ms < 5 sn (kabul). 1. tur 8 sn: soğuk başlangıç. D-07 nedeniyle 3. iptalden sonra açılan CALLBACK olayları turlar arasında kapatıldı (laboratuvar düzeni).

Yapılmadı: gerçek saat/BLE, gerçek telefon, uçak modu, servis öldürme, saat çıkarma, operatör araması ve 24 saat pil adımları (e2e-protokol.md 3–8).
