## Epik 2 · Operatör konsolu çekirdek (S2)

### T-020 Kimlik ve erişim (E-01)
- **Amaç:** Operatör MFA ile girer; her istek rolüyle yetkilendirilir; cihazlar ayrı token alır.
- **Adımlar:** (1) Keycloak realm'leri `infra/keycloak/realms.json`: `consumers` (ELDER, FAMILY), `operations` (OPERATOR, SUPERVISOR, ADMIN); operations'ta OTP zorunlu. (2) API'de `OidcGuard` (JWKS doğrulama, realm/rol kontrolü) ve `@Roles()` dekoratörü; cihaz token'ı için ayrı `DeviceTokenGuard` (T-041). (3) Konsol: `oidc-client-ts` ile PKCE giriş, 12 saat oturum, sessiz yenileme. (4) `X-Operator-Id` başlığı kaldırılır; operatör kimliği token'dan.
- **Dosyalar:** infra/keycloak/realms.json, apps/api/src/modules/identity/*, apps/console/src/auth/*.
- **Kabul:** Token'sız `GET /v1/queue` 401; FAMILY rolü 403; OTP olmadan operations girişi reddedilir.

### T-021 Prosedür ve zincir (D-03, D-04)
- **Adımlar:** (1) 05'teki olay tipi tablosunu `packages/rules/procedures.tr.yaml` olarak yaz: her tip için adım listesi (kind, label, scriptRef, timeoutSec, required). (2) `chain` modülü: olay OPERATOR_ASSIGNED olunca `chain_run` + `chain_step` satırları üretilir. (3) `POST /v1/events/{id}/chain/steps/{n}/result` (REACHED | NO_ANSWER | BUSY | WRONG_NUMBER | SKIPPED + note); sıra zorunlu, SKIPPED gerekçe ister. (4) `POST /v1/events/{id}/escalate-112` kısayolu: gerekçe zorunlu, kalan adımlar SKIPPED(reason=escalate) olur. (5) Operatör kilidi Redis `SET lock:<olay> <op> NX EX 300`; her istekte uzatılır; kilit düşerse olay OPERATOR_QUEUE'ya döner ve amir uyarısı outbox'a. (6) Adım sonuçları olay geçişlerini tetikler: herhangi bir adımda "kullanıcı iyi" → CONFIRMED_OK; 112 adımı → CONFIRMED_EMERGENCY→DISPATCH.
- **Kabul:** Şablon testi: her olay tipi için adım sayısı ve sırası; sıra dışı sonuç 409; kilit süresi dolunca kuyruğa dönüş testi (fake timers).

### T-022 Canlı kuyruk (E-02)
- **Adımlar:** (1) `GET /v1/queue` sayfalı, öncelik → yaş sıralı, `lockedBy` dahil. (2) WebSocket `/v1/ws/queue` (socket.io veya ws): `event.created/transitioned` outbox mesajlarını operasyon odasına yayınla; yeniden bağlanınca tam liste. (3) `POST /v1/events/{id}/claim` 409 çakışma; `POST /unclaim` (amir).
- **Kabul:** İki istemci aynı olayı aynı anda üstlenmeye çalışır → biri 200 biri 409; WS'de 1 sn içinde yeni olay görünür.

### T-023 Konsol arayüzü (E-03, E-04, E-08, E-10)
- **Adımlar:** (1) `apps/console`: Vite + React + TS; tokens `packages/ui-tokens`; koyu tema varsayılan. (2) Düzen 04'teki gibi: üst bar, kuyruk (240 px), olay kartı, kişi paneli (260 px), telefon barı (yer tutucu). (3) Bileşenler: QueueRow, EventCard (SLA sayaçları canlı), StepRow (Ara/sonuç/not), ScriptPanel (05 script'leri `packages/rules/scripts.tr.json`'dan), ClosePanel. (4) Klavye: Enter üstlen, A ara, 1–5 sonuç, N not, C kapat, Ctrl+1 112. (5) Yeni olay ses uyarısı (tip bazlı ses dosyaları) ve üst bar yanıp sönme. (6) Kişi paneli tıbbi özet yalnız olay açıkken `GET /v1/events/{id}` ile gelir; kopyalama engeli (CSS user-select none + uyarı).
- **Kabul:** Playwright: giriş → simülatör olayı → Enter → adım 1 "cevap yok" → adım 2 açılır → C ile kapat → kuyruktan düşer; erişilebilirlik: axe ciddi hata 0.

### T-024 Kapatma ve 112 şablonu (E-06, E-07)
- **Adımlar:** (1) Kapatma formu: sonuç zorunlu, not ≤ 2000, takip aramasını planla (varsayılan 24 saat, EMERGENCY'de zorunlu). (2) 112 şablonu `GET /v1/events/{id}/script?kind=dispatch112` ülke paketinden doldurulur (adres, yaş, hastalık, ilaç, alerji, kapı notu); kopyala butonu; okundu zaman damgası chain_step'e. (3) FOLLOW_UP olayı T-013 zamanlayıcısıyla üretilir ve kuyruğa P4 düşer.
- **Kabul:** EMERGENCY kapatınca 24 saat sonra FOLLOW_UP olayı oluşur (fake timers); şablon tüm alanları doldurur, boş alan "bilinmiyor".

### T-025 SLA ve metrikler (E-09, D-11)
- **Adımlar:** (1) Prometheus `prom-client`: `signal_to_screen_seconds` (histogram), `operator_claim_seconds`, `event_decision_seconds`, `queue_depth`, `false_alarm_ratio`. (2) Olay kartında sayaçlar: olay yaşı, üstlenmeye kalan (10 sn), ilk aramaya kalan (20 sn). (3) `GET /v1/supervisor/dashboard` özet; `/metrics` uç noktası (iç ağ).
- **Kabul:** Metrikler sentetik testte artar; Grafana panosu JSON `infra/grafana/konsol.json`.

### T-026 Konsol uçtan uca ve eğitim modu
- **Adımlar:** (1) Playwright senaryoları: S3, S4, S5 (SOS konuşabilen, sahte CPaaS), S6 (sessiz hat → Ctrl+1). (2) Eğitim modu: `?training=1` ile sahte olaylar üreten yerel mod; gerçek API'ye yazmaz (05 tatbikat).
- **Kabul:** CI'da 4 senaryo yeşil; eğitim modu üretimde kapalı.
