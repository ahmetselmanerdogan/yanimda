# Android telefon eşlikçisi — T-042, T-043, T-044, T-045, T-054 (telefon)

Yerel depo: `/Users/hedef/Projects/yanimda-android` (GitHub'a gönderilmez). Modüller `core` (saf Kotlin, birim testli)
ve `phone` (Compose, Room, WorkManager, Wearable Data Layer, FCM). applicationId `app.yanimda.device` — Wear OS saat
uygulaması (`yanimda-wear`) ile aynı; Data Layer yalnız aynı paket adı ve imza arasında konuşur.

## Telefon ↔ saat Data Layer sözleşmesi

Gövdeler UTF-8 JSON. Yetenekler (`res/values/wear.xml`): saat `yanimda_watch`, telefon `yanimda_phone`.

| Yol | Yön | API | Gövde | Cevap |
| --- | --- | --- | --- | --- |
| `/yanimda/signal` | saat → telefon | `MessageClient.sendRequest` | `Signal[]` (signal.schema.json; `deviceId` saatin, küçük harf UUID) — tek nesne de olur | `{"stored":[anahtar…],"rejected":[…]}` telefon Room tamponuna kalıcı yazınca. Saat `stored` anahtarlarını kuyruğundan düşer; 3 sn'de cevap yoksa LTE ile kendisi gönderir (aynı anahtar → sunucu `duplicates`). |
| `/yanimda/signal/delivered` | telefon → saat | `sendMessage` | `{"delivered":[…],"at":"ISO"}` | bilgi (tile "son başarılı gönderim") |
| `/yanimda/config` | saat → telefon | `sendRequest` | `{"deviceId":"<saatin UUID'si>","model","osVersion","appVersion"}` | `WatchConfig`; telefon saati `POST /devices/{telefon}/companions` ile kaydeder |
| `/yanimda/config` | telefon → saat | `DataClient` DataItem, anahtar `json` | `WatchConfig` | bağlantı dönünce senkron |
| `/yanimda/prompt` | telefon → saat | `sendMessage` | `{"type":"PROMPT","promptId","code","windowSec"}` · `{"type":"CALL","operator"}` · `{"type":"CANCEL","promptId"}` | — |

`WatchConfig`: `{apiBaseUrl, protectedPersonId, phoneDeviceId, watch: {deviceId, token, expiresAt} | null, config:
<GET /devices/{saat}/config gövdesi> | null, autoAnswerSec, testMode, updatedAt}`. Saatin cevapları (İyiyim → OK,
iptal → CANCEL) ayrı yol değil, `/yanimda/signal` ile gelir. Saat bilek/pil durumunu ayrıca bildirmez: OFF_BODY /
ON_BODY / BATTERY sinyalleri köprüden geçerken telefon durum şeridini günceller (saat çıkarılınca anında amber).

## Sunucu (bu dal)

- `POST /v1/devices/{telefonId}/companions` — telefon token'ıyla saat kaydı (saatte kod yazılmaz). Yeniden → 200 +
  yeni token; kaldırılmış saat yeniden etkinleşir; başka kişinin cihazı 409; telefon olmayan token 403.
- `POST /v1/signals` köprü yetkisi — telefon token'ı aynı kişinin etkin WEAROS_WATCH cihazlarının sinyallerini saatin
  kimliğiyle iletebilir (`CompanionService.assertBatchAllowed`); sinyal saat adaptöründen geçer.
- `PATCH /v1/devices/{id}/setup-state` + aile `GET /v1/protected-persons/{id}/setup-state` — kurulum durumu Redis'te
  (şema değişikliği yok); eksik izinle biten kurulum aileye **F-PERM** (gün + eksik kümesi başına bir kez).
- `GET /v1/devices/{id}/status` — koruma durumu cihaz token'ıyla.
- `GET /devices/{id}/config` → `operator {name, callerIds}` (`OPERATOR_CALLER_IDS`, `OPERATOR_DISPLAY_NAME`;
  .env.example) ve telefonlara `familyContact` (ilk yakın).
- Katalog: P-SETUP-*, P-PERM-LOC-BG / -BATTERY / -CALLS / -FIX, P-SERVICE, P-CHANNEL-*, P-HOME-WATCH-OFF /
  -WATCH-BATTERY, P-CALLBACK(-SENT), P-FAMILY, P-SUMMARY-*, P-CALL-SPEAKER, P-CONTACT-NAME, F-PERM.

## Görevler ve sapmalar

- **T-042**: sihirbaz 04'teki 7 ekranı izler; Android'e özgü iki ek adım var: *arama izni* (T-054 operatör numarasını
  tanımak için READ_PHONE_STATE + READ_CALL_LOG) ve *rehbere ekle* (yalnız yapılandırmada operatör numarası varsa).
  Her ekran tek ana düğme (≥ 56 dp, 22/28 sp) + "Sonra"; ilerleme kalıcı, her adım `PATCH /setup-state`. Play Store
  yönlendirme sayfası (`https://yanimda.app/invite/<kod>` → mağaza) ve `assetlinks.json` web tarafının işi (T-060).
- **T-043**: acil sinyaller (SOS, FALL, CANCEL, OK, CALLBACK_REQUEST, TEST) beklemeden ve kuyruğun önünde; diğerleri
  2 sn pencerede toplu. Geçici hatada aynı anahtarlarla üstel geri çekilme (2…300 sn, Retry-After), ağ dönünce hemen;
  süreç ölse de WorkManager (ağ kısıtı) tamponu boşaltır.
- **T-044**: koruma modu hareketi ivmeölçer varyansı + adım sayacıyla ölçülür (ActivityRecognition geçiş API'si
  kullanılmadı; ACTIVITY_RECOGNITION izni adım sayacı için). Telefon 10 dk'da bir HEARTBEAT gönderir (sunucu
  `protection_state` telefonu görür). "Yanımda sizi koruyor" bildirimi o anki durum cümlesini taşır.
- **T-054 (telefon)**: InCallService yok; standart arama ekranı. Operatör numarasından gelen arama cevaplanınca
  hoparlör + konuşma sesi en yüksek, bitince eski düzey. Otomatik cevap yalnız saatte. Bazı üreticiler başka
  uygulamanın aramasında hoparlör değişikliğine izin vermeyebilir — gerçek cihazda doğrulanmalı.
