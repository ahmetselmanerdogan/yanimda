# Sırlar yönetimi ve `health` şeması erişimi

T-081 (3) ve (4). Kural: **sırlar koda, imaja ve repoya girmez; üretimde `.env` dosyası yoktur.** Sırlar KMS/Vault
kökenli bir sır deposundan çalışma anında ortam değişkeni (veya bağlanmış dosya) olarak gelir.

## 1. Envanter (API'nin okuduğu sırlar)

Kaynak: `apps/api/src` içinde `process.env.*` ve `env.*` erişimleri; açıklamalar `.env.example`'da.
"Sır değil" yapılandırmalar (port, aralıklar, `KEYCLOAK_URL`, `OIDC_*_ISSUER`, `CPAAS_WEBHOOK_BASE`,
`S3_ENDPOINT/BUCKET/REGION` …) tabloda yok; onlar ConfigMap/düz ortam değişkenidir.

| Değişken | Ne için | Okuyan kod | Üretimde | Rotasyon | Sızarsa etkisi |
| --- | --- | --- | --- | --- | --- |
| `DATABASE_URL` (parola içerir) | Postgres/TimescaleDB | `src/db/client.ts` | Zorunlu | 90 gün veya Vault dinamik kimlik (saatlik) | Tüm veriler (sağlık alanları şifreli) |
| `REDIS_URL` (parola/TLS) | İdempotency, BullMQ, WS yayını | `src/core.module.ts` | Zorunlu | 90 gün | Zamanlayıcı/kuyruk manipülasyonu |
| `FIELD_ENC_KEYS` | Tıbbi özet + kapı notu AES-256-GCM | `src/common/field-cipher.ts` | Zorunlu (yoksa açılmaz) | Yılda bir yeni `kid` (§3) | Sağlık verisi çözülebilir (DB'ye de erişim gerekir) |
| `DEVICE_TOKEN_SECRET` (≥ 32 kr.) | Cihaz token'ı HS256 | `src/modules/device/device-token.ts` | Zorunlu (yoksa açılmaz) | Yalnız sızıntıda (§4; çoklu anahtar desteği yok) | Her cihaz adına sahte sinyal/SOS |
| `ADMIN_TOKEN` | Betik/CI yönetici uçları | `src/modules/rules/admin-token.guard.ts` | **Boş bırakılmalı** (OIDC ADMIN yeter) | Kullanılıyorsa 30 gün | MFA'sız yönetici: tüm profiller, kural yükleme |
| `TWILIO_AUTH_TOKEN` | Twilio REST + webhook imzası | `src/modules/telephony/twilio.ts` | CPaaS açıksa | 180 gün (Twilio ikincil token ile kesintisiz) | Sahte webhook, arama/SMS (maliyet) |
| `TWILIO_ACCOUNT_SID` | Hesap kimliği | aynı | CPaaS açıksa | — (kimlik) | Tek başına düşük |
| `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET` | Konsol yazılım telefonu Voice token'ı | `src/modules/telephony/voice-token.ts` | Softphone açıksa | 180 gün | Sahte operatör Voice token'ı |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | Görüşme kayıtları (nesne kilidi) | `src/modules/telephony/recording-store.ts` | Twilio ile zorunlu | 90 gün; tercihen iş yükü kimliği (IRSA/Workload Identity) | Görüşme kayıtları okunur (silinemez: kilit) |
| `FCM_PRIVATE_KEY` / `FCM_CLIENT_EMAIL` / `FCM_CREDENTIALS_FILE` | FCM HTTP v1 hizmet hesabı | `src/modules/notify/fcm-client.ts` | Push açıksa | 90–180 gün; tercihen iş yükü kimlik federasyonu | Kullanıcılara sahte push |
| `APNS_PRIVATE_KEY` / `APNS_PRIVATE_KEY_FILE` (+ `APNS_KEY_ID`, `APNS_TEAM_ID`) | iPhone uyandırma/bildirim | `src/modules/device/apns/apns-client.ts` | iOS için | Yılda bir (Apple aynı anda 2 anahtar destekler) | Sahte push |
| `GOOGLE_GEOCODING_KEY` | Adres konumlama | `src/modules/profile/geocoder.ts` | İsteğe bağlı | Yılda bir; API + IP kısıtlı | Kota/maliyet |

Repo dışı, aynı kurallara tabi sırlar: Keycloak yönetici parolası ve realm istemci sırları, Postgres süper kullanıcı
parolası, MinIO/S3 kök kimliği, CI imzalama anahtarı (cosign; CI güvenlik işleri), mobil pin yedek anahtarları
(`sertifika-sabitleme.md` §2), Apple/Google mağaza imzalama anahtarları.

Temizlik notu: `.env.example`'daki `FCM_SERVER_KEY` (eski FCM API) ve `KAFKA_BROKERS` kod tarafından okunmuyor;
bir sonraki kod görevinde kaldırılmalı.

## 2. Nerede saklanır, nasıl gelir

| Ortam | Kaynak | Uygulamaya ulaşma |
| --- | --- | --- |
| Kubernetes (üretim, staging) | Vault (KV v2, KMS auto-unseal) veya bulut Secrets Manager; anahtar şifreleme KMS'te | External Secrets Operator → `Secret` → `envFrom.secretRef` / dosya olarak `volumeMount` (`*_FILE` biçimleri). `Secret` etcd'de KMS ile şifreli. |
| Docker Compose (yerel olmayan tek makine kurulumları) | `docker secret` veya repo **dışındaki** `env_file:` (izin 600, sahibi servis kullanıcısı) | Repo içinde `.env` yok. |
| Yerel geliştirme | `infra/docker-compose.yml` sabit geliştirme parolaları (`yanimda/yanimda`, `admin/admin`, `minio12345`) | Yalnız `localhost`. Bu değerler başka hiçbir ortamda kullanılamaz. |
| CI | İş başına rastgele (`openssl rand`), `::add-mask::` (`.github/workflows/ci.yml`, `image` ve `console-e2e` işleri) | Kalıcı sır yok. |

Erişim: üretim sırlarını okuma yetkisi yalnız dağıtım hizmet hesabı ve 2 kişilik "kırık cam" grubunda; her okuma
Vault denetim kaydında. Geliştiriciler üretim sırrını görmez.

## 3. `.env` üretimde yok — nasıl sağlanır

| Önlem | Durum | Kanıt / iş |
| --- | --- | --- |
| Uygulama `.env` okumaz (dotenv yok) | ✅ | `apps/api/package.json` bağımlılıkları; `src/main.ts` |
| `.env` git'e girmez | ✅ | `.gitignore` (`.env`, her dizinde) |
| İmaja girmez | ⚠️ | `.dockerignore` yalnız kökteki `.env`, `.env.*`'i dışlar; `apps/api/.env` gibi alt dizin dosyaları yapı aşamasına (`COPY . .`) girer. Çalışma imajına `pnpm deploy` paket listesiyle (`.gitignore`'a uyar) taşınmaması beklenir, doğrulanmadı. Öneri: `**/.env` ve `**/.env.*` (+ `!**/.env.example`). |
| Üretimde zorunlu sırlar yoksa açılmaz | ✅ | `field-cipher.ts` (`FIELD_ENC_KEYS`), `device-token.ts` (`DEVICE_TOKEN_SECRET` ≥ 32), `oidc-verifier.ts` (MFA kapatılamaz), `telephony.module.ts` (sahte CPaaS yasak). İmaj `NODE_ENV=production` (`apps/api/Dockerfile`). |
| Tek makine üretim kurulumu | ⚠️ | Çalışma ağacındaki (commit edilmemiş, T-083) `infra/docker-compose.prod.yml` `env_file: [.env.prod]` kullanıyor. Kabul koşulu: dosya repoda yok, dağıtım anında sır deposundan üretilir, izin 600, yedeklere/imaja girmez; tercihen `secrets:` ile dosya olarak bağlanır. |
| CI denetimi | öneri | CI güvenlik işlerinde: (a) repoda `.env.example` dışında `.env*` izlenmiyor, (b) imajda `find / -name '.env*'` boş, (c) gizli anahtar taraması. |

## 4. Rotasyon runbook'ları

### 4.1 `FIELD_ENC_KEYS` (çoklu anahtar)

Biçim (`src/common/field-cipher.ts`): `FIELD_ENC_KEYS="<kid>:<base64 32 bayt>[,<kid>:<…>]"`. **İlk anahtar yazar**,
hepsi okur. Şifreli değer `v1:<kid>:<base64(iv|tag|şifreli)>` — hangi anahtarla yazıldığı değerde yazılı. AAD
(`medical:<kişi>`) değeri satıra bağlar.

Planlı rotasyon (örnek: `k1` → `k2`):

1. Anahtar üret (sır deposunda, kimsenin terminaline düşmeden): `echo "k2:$(openssl rand -base64 32)"`.
   `kid` yalnız `[A-Za-z0-9_-]`; tarih içeren ad önerilir (`k2027a`).
2. **Faz 1 — okuyabilir hale getir:** `FIELD_ENC_KEYS="k1:<eski>,k2:<yeni>"` ile tüm örnekleri yeniden başlat.
   Yazan hâlâ `k1`. (Bu faz, kayan dağıtım sırasında `k2`'yi henüz bilmeyen bir örneğin `k2` ile yazılmış veriyi
   okuyamaması durumunu önler.)
3. Tüm örnekler yeni sürümde mi → **Faz 2 — yazanı değiştir:** `FIELD_ENC_KEYS="k2:<yeni>,k1:<eski>"`.
4. **Yeniden şifreleme:** Kodda yalnız `FieldCipher.isStale()` yardımcısı var; toplu yeniden şifreleme işi **yok**
   (izleyen kod görevi). O gelene kadar eski anahtar kaldırılamaz. Kalan eski kayıtlar:
   ```sql
   SELECT count(*) FROM health.medical_summary WHERE ciphertext NOT LIKE 'v1:k2:%';
   SELECT count(*) FROM profile.protected_person
    WHERE door_access_note_enc IS NOT NULL AND door_access_note_enc NOT LIKE 'v1:k2:%';
   ```
5. İki sayı da 0 → `FIELD_ENC_KEYS="k2:<yeni>"`, eski anahtar sır deposunda devre dışı (silme değil: yedeklerden
   geri dönüş için süreli saklama, KVKK saklama süresiyle uyumlu).

Doğrulama: rotasyon sonrası bir test kişisinde olay kartı (`GET /v1/events/{id}/person`) tıbbi özeti gösteriyor;
log'da `Tıbbi özet çözülemedi` yok.

### 4.2 `DEVICE_TOKEN_SECRET`

Durum: tek anahtar, token başlığında `kid` yok (`device-token.ts`: başlık sabit `{"alg":"HS256","typ":"JWT"}`,
doğrulama birebir başlık karşılaştırır). Anahtar değişirse **tüm cihaz token'ları anında geçersiz** olur (401);
cihazlar yeni davet koduyla yeniden eşleşmek zorundadır. Yaşlı kullanıcılar için ağır bir işlem — bu yüzden planlı
rotasyon yapılmaz, yalnız sızıntıda.

Acil rotasyon:

1. Yeni sır: `openssl rand -hex 32` → sır deposu.
2. Tüm API örneklerini yeni sırla yeniden başlat (eski sır hiçbir örnekte kalmamalı).
3. Operasyon: etkin kişilerin ailelerine yeniden eşleşme bildirimi (katalog metniyle), destek hattı hazır; saatlik
   "sessiz cihaz" uyarılarının toplu artacağı amire önceden bildirilir.
4. İzleme: 401 oranı, yeniden eşleşen cihaz sayısı, koruması düşen kişi sayısı (`protection` durumu).

İzleyen kod görevi (öneri): `DEVICE_TOKEN_SECRETS="kid:sır,…"` + başlıkta `kid`; yeni token ilk anahtarla, doğrulama
hepsiyle. Token 1 yıllık ve bitişe 30 gün kala yenilendiği için planlı rotasyon en geç 12 ay örtüşmeyle (veya
istemciye "şimdi yenile" sinyaliyle) kesintisiz yapılabilir.

### 4.3 Diğerleri (kısa)

- **DB parolası:** yeni rol parolası → sır deposu → kayan yeniden başlatma → eski parola `ALTER ROLE … PASSWORD`
  ile geçersiz. Hedef: Vault veritabanı motoru ile kısa ömürlü kimlik.
- **Twilio auth token:** Konsolda ikincil token oluştur → API'ye ver (REST + webhook imzası yeni token'la) → birincil
  yap → eskisini sil. Webhook imzası tek token'la doğrulandığı için geçiş anı tek dağıtımdır.
- **S3, FCM, APNs:** önce yeni anahtar eklenir (sağlayıcılar aynı anda iki anahtara izin verir), dağıtım, sonra
  eskisi iptal.
- **`ADMIN_TOKEN`:** üretimde boş. Doluysa: yeni değer → dağıtım → eski geçersiz (tek değer; örtüşme yok).

## 5. Sır sızıntısı olay müdahalesi

1. **Sınıfla (15 dk):** hangi sır, hangi ortam, ne zamandan beri açıkta (git geçmişi, CI log'u, imaj katmanı, ekran
   görüntüsü, destek talebi). Güvenlik nöbetçisi olay kaydı açar.
2. **Kes (1 saat):** sırrı sağlayıcıda iptal et / döndür (§4). Git'e girdiyse: döndürme şart; geçmiş temizliği
   (`git filter-repo`) ikincildir, sır her durumda yanmış sayılır.
3. **Etki analizi:** sağlayıcı denetim kayıtları (Twilio arama/SMS, S3 erişim, Vault, Keycloak olayları),
   `audit.log` (`health.medical_viewed`, `profile.*`), olağan dışı sinyal/olay hacmi.
4. **Bildirim:** kişisel/sağlık verisine yetkisiz erişim olasılığı varsa KVKK (72 saat) ve sözleşmesel bildirimler;
   hukuk + veri sorumlusu kararı.
5. **Kök neden ve önlem:** tarama kuralı, `.dockerignore`, erişim daraltma; bulgu `asvs-l2.md` açıklar tablosuna.

| Sır | İlk eylem |
| --- | --- |
| `FIELD_ENC_KEYS` | DB erişimi de sızdı mı? Yeni anahtarla Faz 1–2 + acil yeniden şifreleme (araç yoksa elle betik); eski anahtar imha. |
| `DEVICE_TOKEN_SECRET` | §4.2 acil rotasyon; sahte sinyal analizi (`signal.signal`, beklenmeyen `SOS`). |
| `TWILIO_*` | Token döndür; Twilio'da giden arama/SMS geçmişi; maliyet uyarısı. |
| `ADMIN_TOKEN` | Değeri boşalt (yönetici uçları yalnız OIDC); `audit.log` ve kural yükleme geçmişi. |
| DB parolası | Rol parolası değiştir, bağlantıları düşür (`pg_terminate_backend`), ağ erişimini doğrula. |

## 6. `health` şeması erişimi (T-081 (3))

### 6.1 Bugünkü durum

- Veritabanında **tek uygulama rolü** var (geliştirme/CI'da `yanimda`, `infra/docker-compose.yml`, `ci.yml`). Bu
  rol tüm şemaların sahibidir; migration'ları da uygulama açılışta aynı rolle çalıştırır (`DB_MIGRATE_ON_START`,
  `src/core.module.ts`).
- Migration'larda rol/GRANT tanımı yok. Tek istisna: `audit.log` için `REVOKE UPDATE, DELETE, TRUNCATE … FROM PUBLIC`
  ve değişikliği reddeden tetikleyiciler (`drizzle/migrations/0002_event_persistence/up.sql`). `infra/init.sql`
  yalnız uzantıları kurar.
- Uygulama katmanı denetimi var ve sıkı:
  - `health.medical_summary.ciphertext` AES-256-GCM, AAD ile kişiye bağlı (`0009_profile/up.sql`, `field-cipher.ts`).
  - Çözme yalnız olay kartında ve 112 şablonunda; yalnız olayı üstlenmiş operatör, yalnız olay operatör
    durumundayken (`event.service.ts` `operate()` + `OPERATOR_STATES`; `chain.controller.ts` `GET :id/person`);
    her çözüm `audit.log`'a `health.medical_viewed` (`profile.service.ts` `eventCard`).
  - Aile tıbbi özeti yazar/siler ama geri okuyamaz (`profile.controller.ts` `PUT/DELETE :id/medical`).
- Sonuç: DB kimliği veya SQL enjeksiyonu (bugün bilinen yok; Drizzle parametreli) ele geçirilirse `health` dahil her
  şey okunur/değiştirilir; şifreleme anahtarı ayrı tutulduğu sürece tıbbi içerik okunamaz, ancak kişi–tıbbi kayıt
  varlığı ve meta veri görünür. "Yalnız `event` ve `console` rolü, zamanla sınırlı" **DB düzeyinde karşılanmıyor**.

### 6.2 Önerilen tasarım (izleyen görev — migration bu görevde yazılmadı)

Roller:

| Rol | Tür | Yetki |
| --- | --- | --- |
| `yanimda_owner` | NOLOGIN | Tüm şemaların sahibi. Kimse bununla bağlanmaz. |
| `yanimda_migrator` | LOGIN | `yanimda_owner` üyesi; yalnız migration işi (Job). Üretimde `DB_MIGRATE_ON_START=false`. |
| `yanimda_app` | NOLOGIN | `health` dışındaki şemalarda USAGE + gereken DML. `audit.log` için yalnız INSERT/SELECT. |
| `event` | LOGIN | `yanimda_app` üyesi + `health.medical_for_event()` EXECUTE. Olay motoru/işçi süreci. |
| `console` | LOGIN | `yanimda_app` üyesi + `health.medical_for_event()` EXECUTE. Operatör konsolu uçlarını sunan süreç. |
| `profile` (veya `yanimda_app`) | — | `health.medical_summary` üzerinde INSERT, DELETE, UPDATE (`ciphertext`, `consent_at`, `consent_by`, `updated_at`) ve **yalnız** `SELECT (protected_person_id, consent_at, updated_at)`; `ciphertext` okunamaz ("yazar ama geri okumaz" kuralının DB karşılığı). |

`health` şemasında `ciphertext` sütununa doğrudan SELECT yetkisi yalnız `yanimda_owner`'da kalır. Okuma tek kapıdan:

```sql
-- Taslak: izleyen görevde migration olarak, testleriyle birlikte yazılacak.
CREATE FUNCTION health.medical_for_event(p_event uuid, p_operator text, p_purpose text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_person text; v_cipher text;   -- event.protected_person_id text (0002)
BEGIN
  SELECT e.protected_person_id INTO v_person
    FROM event.event e
   WHERE e.id = p_event
     AND e.operator_id = p_operator
     AND e.state IN ('OPERATOR_ASSIGNED', 'CONTACT_CHAIN', 'CONFIRMED_OK' /* … OPERATOR_STATES ile aynı */)
     AND e.created_at > now() - interval '24 hours';           -- zamanla sınır: yalnız etkin, yeni olay
  IF v_person IS NULL THEN RAISE EXCEPTION 'erişim yok' USING ERRCODE = '42501'; END IF;
  SELECT m.ciphertext INTO v_cipher FROM health.medical_summary m WHERE m.protected_person_id::text = v_person;
  INSERT INTO audit.log (actor_kind, actor_id, action, entity_type, entity_id, data)
       VALUES ('OPERATOR', p_operator, 'health.medical_viewed', 'event', p_event::text,
               jsonb_build_object('purpose', p_purpose, 'db', true));
  RETURN v_cipher;                                              -- çözme uygulamada (anahtar DB'de değil)
END $$;
REVOKE ALL ON FUNCTION health.medical_for_event(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION health.medical_for_event(uuid, text, text) TO event, console;
```

Notlar:
- Sütun adları, durum listesi ve 24 saat süresi uygulamadaki `OPERATOR_STATES` ve PRD kabul kriterleriyle eşlenmeli
  (tek kaynak); süre sonrası erişim yalnız amir onayıyla ayrı bir fonksiyondan (denetim kayıtlı).
- `0002_event_persistence/up.sql` notu: üretimde API süper kullanıcı olmayan rolle bağlanır (T-083) — bu tasarım o
  görevle birlikte ele alınmalı.
- Bugün API tek süreç (modüler monolit) olduğundan `event` ve `console` aynı süreçte ayrı bağlantı havuzu demektir.
  Ara adım: önce sahip/migrator/uygulama ayrımı (`yanimda_owner` / `yanimda_migrator` / `yanimda_app`), sonra
  `health` okumasının fonksiyona taşınması, süreçler ayrıldığında `event`/`console` giriş rolleri.
- Test: `yanimda_app` ile `SELECT ciphertext FROM health.medical_summary` → `42501`; üstlenmemiş operatör ve kapanmış
  olay için fonksiyon → `42501`; başarılı çağrı `audit.log`'a satır ekler.
