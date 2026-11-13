# Kişisel veri yaşam döngüsü: saklama süreleri ve dışa aktarma

T-081, ASVS 8.3.8 (saklama) ve 8.3.2 (dışa aktarma / silme), KVKK m.4/2-ç (gerektiği kadar saklama), m.7 (silme),
m.11 (erişim hakkı). Tarih: 2026-11-13. Süreler **teknik varsayılandır**; hukuki süreler (özellikle olay kaydı,
görüşme kaydı, denetim kaydı, muhasebe) hukuk görüşüyle kesinleşir — o satırlar "hukuk kararı bekliyor" işaretlidir.
Yeni tablo / veri türü ekleyen görev bu tabloya satır ekler.

## 1. Saklama tablosu

"Mekanizma" sütunu kodda neyin sildiğini gösterir. "Taban": o veriyi okuyan kodun en uzun penceresi; ortam değeri
(0 = kapalı hariç) tabanın altındaysa API açılmaz (`retentionConfigFromEnv`).

| Veri sınıfı | Tablo / yer | Süre (varsayılan) | Ortam değişkeni (taban) | Mekanizma | Not |
| --- | --- | --- | --- | --- | --- |
| Ham sinyal (cihaz, ortak) | `signal.signal` | 400 gün | `SIGNAL_RETENTION_DAYS` (35) | `RetentionService` | Yönetim ölçüleri en çok 365 gün geriye bakar (`admin.controller.ts` `range`); öğrenme 14, şarj öğrenmesi 15 gün |
| Değer sinyalleri (SPO2, SKIN_TEMP_DEVIATION; bayrak açıkken HEART_RATE) | `signal.signal` | 30 gün | kural paketi `vitals.retention.rawDays` | `VitalsService.purge` | Migration 0037; bayraktan bağımsız çalışır |
| Sinyaldeki konum | `signal.signal.payload.location` | 30 gün (satır kalır) | `SIGNAL_LOCATION_RETENTION_DAYS` (1) | `RetentionService` | Aile "son konum" 24 saat (`protection.service.ts` `locationOf`); olay konumu olayın kendisinde (`event.event.location`) |
| Günlük özet (adım, nabız özeti) | `signal.daily_summary` | 400 gün | `DAILY_SUMMARY_RETENTION_DAYS` (31) | `RetentionService` | Aile ekranı en çok 31 gün (`daily-summary.service.ts` `recent`) |
| Değer örnekleri | `health.vital_sample` | 30 gün | kural paketi `vitals.retention` | `VitalsService.purge` | 0037 |
| Değer günlük özeti, uyarı, çözülmüş inceleme | `health.vital_daily`, `vital_alert`, `vital_review` | 13 ay | kural paketi `vitals.retention.summaryMonths` | `VitalsService.purge` | 0037 |
| Değer susturma | `health.vital_silence` | bitişinde | — | `VitalsService.purge` | |
| Görüşme kaydı (ses) | S3 / OBS `recordings` | 365 gün (staging 30) | `RECORDING_RETENTION_DAYS` | Nesne kilidi COMPLIANCE `retain-until` (`recording-store.ts`) | **Açık:** kilit bitince silen kova yaşam döngüsü kuralı yok (`infra/terraform/modules/yanimda-env/main.tf` `recordings`); hukuk kararı bekliyor (`docs/telefoni-tr.md`) |
| Outbox (işlenmiş) | `event.outbox`, `event.outbox_side` | 7 gün | `OUTBOX_RETENTION_DAYS` (1) | `RetentionService` | İşlenmemiş satır, `event.outbox_dlq` ve ölü side satırı (`dead_at`) **asla** otomatik silinmez (olay kaybı sıfır; elle inceleme) |
| Cihaz eşleştirme kodu | `profile.invite` | geçerlilik (15 dk) + 30 gün | `INVITE_RETENTION_DAYS` (1) | `RetentionService` | Yalnız sha256 saklanır |
| Aile üyesi daveti | `profile.member_invite` | geçerlilik (72 sa) + 30 gün | `INVITE_RETENTION_DAYS` (1) | `RetentionService` | Süre sonrası kod "geçersiz" görünür ("süresi doldu" yerine) |
| Bildirim kaydı | `notify.notification` | 365 gün | `NOTIFICATION_RETENTION_DAYS` (30) | `RetentionService` | Yalnız son durum (`sent`/`delivered`/`failed`); takılı (`queued`/`sending`) kalmış satır silinmez; yedeği (`fallback_of`) saklanan asıl satır silinmez. Metin ve numara zaten yok |
| Ortak webhook nonce | `device.partner_delivery` | 7 gün | `PARTNER_NONCE_RETENTION_DAYS` (1) | `RetentionService` | İmza penceresi ±5 dk: daha eski teslim zaman damgasıyla reddedilir |
| Push token (aile uygulaması) | `notify.push_target` | sağlayıcı geçersiz dedikçe | — | `notify.service.ts` (`invalidTarget` → silme) | Zaman tabanlı silme yok (kayıp bildirim riski) |
| Personel web push aboneliği | `identity.web_push_subscription` | sağlayıcı hata verdikçe | — | `webpush.service.ts` | |
| İdempotency anahtarı | Redis | 24 saat | — | `IDEM_TTL_SEC` | |
| Hız sınırı sayaçları | Redis | pencere süresi | — | `rate-limit.ts` | |
| **Olay kaydı** (olay, geçiş, zincir, arama, 112 süreci, ön eleme, cihaz sorusu, düzenli arama) | `event.*`, `chain.*`, `telephony.call`, `telephony.inbound_call` | **silinmez** (önerilen: 10 yıl) | — | yok | **Hukuk kararı bekliyor.** Acil müdahale delil kaydı; TBK m.146 genel zamanaşımı 10 yıl. Karar sonrası: kapanıştan N yıl sonra anonimleştirme işi (konum, not, operatör kimliği boşaltılır, sayımlar kalır) |
| **Denetim kaydı** | `audit.log` | **silinmez** (önerilen: 10 yıl) | — | append-only tetikleyici (`0002_event_persistence/up.sql`) | Uygulama silemez (UPDATE/DELETE/TRUNCATE tetikleyiciyle reddedilir, süper kullanıcı dahil). Arşivleme yalnız DB sahibinin değişiklik kaydıyla (tetikleyiciyi kaldırma, dışa aktarma, geri koyma) — **hukuk kararı bekliyor**. Saklama turu kendi özetini (`privacy.retention_purged`, yalnız sayılar) buraya yazar |
| Profil, rehber, aile üyeliği, tıbbi özet, cihaz, kapsama, plan | `profile.*`, `health.medical_summary`, `device.*`, `event.coverage_*` | hizmet süresince | — | yok | **Açık:** abonelik iptalinden sonra silme / anonimleştirme işi yok (önerilen: iptal + 30 gün; ödeme anlaşmazlığı penceresi). Bugün: tıbbi özet `DELETE /protected-persons/{id}/medical`, cihaz `DELETE /devices/{id}`, üyelik `DELETE .../members/{id}`; tam hesap silme operasyon süreci (§3) |
| Abonelik, ödeme webhook kaydı | `profile.subscription`, `profile.payment_webhook` | silinmez | — | yok | **Hukuk kararı bekliyor** (VUK m.253 / TTK m.82 muhasebe saklama). Kart verisi hiç tutulmaz (sağlayıcıda) |
| Keycloak olayları | Keycloak DB | 90 gün | realm `eventsExpiration` | Keycloak | `infra/keycloak/realm-*.json` |
| Uygulama log'u | Loki | 14 gün | `infra/monitoring/loki-config.yml` | Loki | Log'da PII yok (CI denetimi) |
| Metrikler | Prometheus | 30 gün / 20 GB | `docker-compose.monitoring.yml` | Prometheus | |
| Veritabanı yedeği | OBS `backups` (`pg/`), RDS otomatik yedek | 35 gün (staging 14), PITR penceresi | `BACKUP_RETENTION_DAYS`, `backup_retention_days` | Kova yaşam döngüsü + `pg-backup.sh` | Silinen veri yedekte en çok bu kadar kalır; geri yüklemede silme kayıtları (audit) yeniden uygulanır |

### Temizlik işi (`apps/api/src/modules/privacy/retention.service.ts`)

- Desen: diğer taramalarla aynı (süreç içi zamanlayıcı, `RETENTION_SWEEP_MS`, varsayılan 6 saat, ilk tur açılıştan
  ≤ 10 dk sonra; 0 kapatır). BullMQ değil: tur idempotent ve kaçırılırsa bir sonrakinde telafi edilir.
- Birden çok API örneği: tur tek transaction'da `pg_try_advisory_xact_lock(4200181)` alır; alamayan örnek turu atlar.
- Parçalı: her ifade ≤ 5000 satır, sınıf başına tur başına ≤ 200 parça (sorgu zaman aşımı 30 sn); kalan sonraki tura.
- İş yapıldıysa `audit.log`'a `SYSTEM` / `privacy.retention_purged` (yalnız sınıf başına sayı ve süreler) yazılır;
  log satırı da yalnız sayılar.
- Testler: `apps/api/test/retention.spec.ts` (sınır değerleri, DLQ / ölü side / takılı bildirim korunur, FK'li
  bildirim zinciri, audit'e dokunulmaz, PII taraması, yapılandırma tabanları).

## 2. Dışa aktarma (KVKK m.11, ASVS 8.3.2)

`GET /v1/family/data-export` (`apps/api/src/modules/privacy/`; aile web "Aboneliğim" → "Verilerimi indir").

- **Kim:** consumers realm FAMILY hesabı, yalnız kendi verisi ve üyesi olduğu (OWNER / MEMBER) korunan kişiler.
  Yönetici (OIDC ADMIN, `x-admin-token`) 403. Kullanıcı başına saatte 5.
- **İlke — yeni okuma yetkisi yok:** her kişi bölümü, aynı hesabın mevcut aile uçlarından zaten okuyabildiğinin
  toplamıdır (profil, üyeler, rehber, cihazlar, olaylar, günlük özet, abonelik). Erişim denetimi `ProfileService`
  (başka ailenin kişisi 404).
- **Karar — tıbbi özet içeriği dışa aktarılmaz.** CLAUDE.md: "Sağlık verisi (health şeması) yalnızca olay anında
  çözülür"; mevcut aile ucu da yalnız var/yok + rıza zamanı döner (`profile.service.ts` `get`). Dışa aktarma bu
  kuralı gevşetmez: dosyada `medical.present`, `consentAt`, `updatedAt` vardır, içerik yoktur
  (`withheld: MEDICAL_CONTENT`). Gerekçe: tıbbi özeti zaten aile kendisi girer; dosya e-posta / bulut klasörüne
  taşınabilir ve şifresizdir. İlgili kişi içeriği isterse §3'teki operasyon süreciyle, kimlik doğrulamasından sonra
  tek seferlik verilir (çözüm `audit.log`'a yazılır).
- **Bilerek verilmeyenler** (`withheld`): tam rehber numarası (aile ekranı son 2 hane; numara üçüncü kişinin), değer
  (health) verisi, görüşme kaydı, denetim kaydı, operatör kimliği / notları, ham konum geçmişi (olay konumu dahil).
  Push token'ı, cihaz numarası, davet kodu, üretici hesap kimliği de yoktur.
- **Hesap kimlik bilgileri** (ad, e-posta, telefon) DB'de değil, Keycloak `consumers` realm'inde; dosyada yalnız
  `sub`. Kullanıcı Keycloak hesap konsolunda görür.
- **Denetim:** her indirme `audit.log` → `privacy.data_exported` (aktör `sub`, kişi kimlikleri, sayılar; içerik yok).
- Testler: `apps/api/test/data-export.spec.ts`, `apps/family-web/src/lib/data-export.test.ts`. Sözleşme:
  `packages/contracts/openapi.yaml` (`/family/data-export`, `DataExport`), `packages/contracts/src/index.ts`.

## 3. Operasyon süreci: KVKK başvurusu (silme, tam içerik, aile dışı ilgili kişi)

Uygulamada self-servis olmayan talepler (hesabın tamamen silinmesi, korunan kişinin kendisinin veya rehberdeki
üçüncü kişinin başvurusu, tıbbi özet içeriği) için:

1. Başvuru kanalı (KVKK aydınlatma metninde yazılı; metin hukuk onayında — `F-WEB-KVKK-BODY` yer tutucu). Kayıt
   numarası verilir; yasal süre 30 gün (KVKK m.13).
2. Kimlik doğrulama `hesap-kurtarma.md` §3 ile aynı: hesap sahibiyse oturum açmış hesaptan talep + kayıtlı telefona
   OTP; değilse kimlik belgesi + vekâlet / velayet.
3. Silme: bugün tek uçta yok, sıralı silme gerekir. `profile.protected_person` silinince `ON DELETE CASCADE` ile
   aile üyeliği, tıbbi özet, abonelik, üye daveti, düzenli arama planı gider; ama `device.device` ve
   `profile.invite` kaskatsız FK ile silmeyi engeller (önce silinir / cihaz `DELETE /devices/{id}` ile kaldırılır),
   `profile.contact` FK'sizdir (kişi kimliğiyle ayrıca silinir). Olay ve denetim kaydı §1'deki karar gereği kalır
   (kişi kimliği UUID, ad yok). Keycloak hesabı realm yöneticisince silinir. İşlem `audit.log`'a yazılır. Betik
   S-3 ile gelir.
4. Yedekler: silinen veri yedekte en çok `BACKUP_RETENTION_DAYS` kalır; başvuru cevabında belirtilir.

## Açık işler

| # | İş | Sahip |
| --- | --- | --- |
| S-1 | Olay kaydı, denetim kaydı, görüşme kaydı, muhasebe süreleri için hukuk görüşü | hukuk |
| S-2 | Görüşme kaydı kovasına `RECORDING_RETENTION_DAYS` + 1 gün yaşam döngüsü kuralı | altyapı |
| S-3 | Abonelik iptali + 30 gün sonra kişi verisini silen / anonimleştiren iş (S-1 sonrası) | backend |
| S-4 | Olay anonimleştirme işi (S-1 sonrası) | backend |
| S-5 | `event.coverage_history`, `device.partner_latency`, `event.supervisor_alert` için süre (önerilen 13 ay) | backend |
