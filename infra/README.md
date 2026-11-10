# infra — staging / üretim altyapısı (T-083)

Basit ama sağlam: **1 VPS + yönetilen Postgres/Redis + S3 uyumlu kova**, tek compose ile uygulama, tek compose ile
izleme. Faz 3'te aynı bileşenler Helm chart'ı ile Kubernetes'e taşınır. Bu dizindeki hiçbir şey gerçek bir bulut
hesabında **çalıştırılmadı**; yalnız statik doğrulama yapıldı (aşağıda "Doğrulama").

```
                 Internet ── DNS (api|console|auth|aile|status).<domain>
                                   │ 80/443 (tcp+udp)
 ┌──────────────── VPS 4 vCPU / 8 GB (ECS, tr-west-1) ─────────────────────────────────────────┐
 │ caddy (ACME TLS) ─┬─ api ×2 (OUTBOX_WORKER=off) ─┐        izleme (ayrı compose, aynı ağ):  │
 │                   ├─ console (statik)            │        prometheus · alertmanager ·      │
 │                   ├─ family-web (profil, kapalı) │        grafana · loki/promtail ·        │
 │                   ├─ keycloak                    │        pushgateway · uptime-kuma ·      │
 │                   └─ uptime-kuma (status.)       │        node/pg/redis/blackbox exporter  │
 │ worker (OUTBOX_WORKER=on, kira) ─────────────────┤                                          │
 │ synthetic (5 dk TEST SOS) · backup (günlük pg_dump → OBS)                                   │
 └──────────────────────────────────────────────────┼──────────────────────────────────────────┘
          VPC iç ağ                                  │
   RDS PostgreSQL 16 HA (2 AZ, PITR) · DCS Redis HA · OBS: recordings (WORM) + backups (yaşam döngüsü)
```

| Yol                                                               | İçerik                                                                                                                                             |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terraform/modules/yanimda-env`                                   | VPC, güvenlik grupları, ECS + veri diski + EIP, RDS PG (HA, yedek/PITR, hesap, veritabanı, `timescaledb`/`pgcrypto`), DCS Redis, OBS kovaları, DNS |
| `terraform/envs/staging`                                          | Staging kökü (S3/OBS uzak durum, `terraform.tfvars.example`, `backend.hcl.example`)                                                                |
| `docker-compose.prod.yml`, `caddy/Caddyfile`, `.env.prod.example` | Uygulama süreçleri, TLS, sağlık kontrolleri, `restart: unless-stopped`                                                                             |
| `console/`                                                        | Konsol imajı (Vite statik → Caddy, root değil, :8080)                                                                                              |
| `monitoring/`                                                     | İzleme compose'u, Prometheus kuralları, Alertmanager, Loki/Promtail, Grafana provizyonu, postgres_exporter iş sorguları                            |
| `backup/`                                                         | `pg-backup.sh`, `restore-drill.sh`, yedek kabı                                                                                                     |
| `synthetic/probe.mjs`                                             | Sentetik sonda (bağımlılıksız Node 20)                                                                                                             |
| `helm/yanimda`                                                    | Faz 3 chart'ı (API, worker, konsol, aile web, Keycloak, Timescale, Redis, MinIO, CronJob, Ingress, NetworkPolicy, PDB, ServiceMonitor)             |

## Bulut seçimi: Huawei Cloud İstanbul (`tr-west-1`)

KVKK veri yerleşimi için Türkiye bölgesi gerekir. Huawei Cloud İstanbul bölgesi gereken her yönetilen hizmeti (ECS,
RDS for PostgreSQL HA + PITR, DCS Redis, OBS S3 uyumlu + WORM, DNS) tek sağlayıcıda ve resmi Terraform sağlayıcısıyla
sunuyor. Sağlayıcıya özgü kod yalnız `terraform/`'dadır; compose ve Helm sağlayıcıdan bağımsızdır (başka bir TR bölgesi
için yalnız modül yeniden yazılır).

**Apply öncesi doğrulanacaklar** (hesap olmadan doğrulanamadı):

1. **TimescaleDB**: RDS PG 16'da `timescaledb` eklentisinin bu bölgede desteklendiği ve sürümünün (dev: 2.17.2) uyumlu
   olduğu. Değilse `enable_timescaledb=false` + Timescale'i ayrı ECS/EVS üzerinde (`timescale/timescaledb:2.17.2-pg16`,
   WAL-G ile S3'e sürekli arşiv) çalıştırın.
2. **OBS WORM**: `huaweicloud_obs_bucket` (sağlayıcı 1.100) nesne kilidi argümanı sunmuyor. API her kaydı
   `x-amz-object-lock-mode=COMPLIANCE` ile yazar; kovada kilit yoksa yazım başarısız olur. Kayıt kovasını önce S3 API ile
   kilitli oluşturup içe aktarın:
   ```sh
   aws --endpoint-url https://obs.tr-west-1.myhuaweicloud.com s3api create-bucket \
     --bucket yanimda-staging-recordings --object-lock-enabled-for-bucket
   terraform import module.env.huaweicloud_obs_bucket.recordings yanimda-staging-recordings
   aws ... s3api get-object-lock-configuration --bucket yanimda-staging-recordings   # Enabled olmalı
   ```
3. EIP hat tipi (`eip_type`, varsayılan `5_bgp`), ECS/RDS/DCS flavor'larının bölgede bulunması (veri kaynakları
   `plan`'da boş dönerse değişkenleri ayarlayın), Ubuntu 22.04 imaj adı.
4. RDS'te `pg_read_all_data` / `pg_monitor` rollerinin yedek ve izleme kullanıcılarına verilebildiği.

## Terraform (çalıştırılmadı)

```sh
cd infra/terraform/envs/staging
cp backend.hcl.example backend.hcl && cp terraform.tfvars.example terraform.tfvars   # ikisi de git dışı
export HW_ACCESS_KEY=… HW_SECRET_KEY=…                 # sağlayıcı
export AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=…     # OBS durum kovası (S3 backend)
export TF_VAR_db_password=… TF_VAR_db_app_password=… TF_VAR_redis_password=…
terraform init -backend-config=backend.hcl && terraform plan -out tf.plan && terraform apply tf.plan
```

- **PITR / RPO**: RDS otomatik tam yedek (günlük, `db_backup_keep_days`) + sürekli WAL arşivi → saniye hassasiyetinde
  zamana geri dönüş; `archive_timeout=300` en geç 5 dk'da bir WAL kapatır → **RPO ≤ 15 dk** (hedef ≈ 5 dk). HA
  `semisync`: birincil düşerse bekleme farklı AZ'de devralır (RPO ≈ 0).
- **Günlük döküm** (`backup/pg-backup.sh`): sağlayıcıdan bağımsız ikinci kopya; RDS hesabı/bölgesi kaybına karşı ve
  tatbikat girdisi. OBS `backups` kovası: sürümleme + `backup_retention_days` sonra silme.
- Prod: `envs/prod` aynı modülle (`db_backup_keep_days ≥ 14`, `db_ha_replication_mode = "sync"` değerlendirilmeli).

## Uygulama dağıtımı (VPS, compose — çalıştırılmadı)

```sh
# VPS'te (cloud-init Docker'ı kurar). Depo yalnız infra/ için gerekir; imajlar kayıt deposundan.
cp infra/.env.prod.example infra/.env.prod && chmod 600 infra/.env.prod   # değerleri sır yöneticisinden doldurun
docker build -f infra/console/Dockerfile --build-arg VITE_OIDC_AUTHORITY=https://auth.$DOMAIN/realms/operations \
  -t $CONSOLE_IMAGE .                                                       # CI'da; ortam başına imaj
docker compose --env-file infra/.env.prod -f infra/docker-compose.prod.yml up -d
docker compose --env-file infra/.env.prod -f infra/monitoring/docker-compose.monitoring.yml up -d
```

- **Sağlık**: API'de ayrık `/health` yok → kap sağlık kontrolü kimliksiz `GET /v1/queue` (401 = ayakta, 5xx/bağlantı
  hatası = sağlıksız). Caddy iki API kopyasını Docker DNS'ten dinamik çözer, yanıt vermeyeni 30 sn dışarıda tutar.
- **Outbox işçisi**: `worker` servisi (`OUTBOX_WORKER=on`); API kopyaları `off`. Sıra garantisi `event.outbox_lease`
  kirasıyla (tek aktif işçi). `API_OUTBOX_WORKER=on` ile kopyalar sıcak yedek olur (işçi ölürse ≤ 30 sn'de devralır).
  `signal_to_screen_seconds` vb. geçiş metrikleri yalnız kirayı tutan süreçte ölçülür (Prometheus `api` ve `worker`'ı
  kazır).
- **Migration**: her süreç açılışta çalıştırır; advisory lock sıraya sokar.
- **Sırlar**: `.env.prod` tek dosya; api/worker kapları `env_file` ile alır. Sentetik ve yedek kapları yalnız kendi
  değişkenlerini alır. Prod'da `.env.prod` sır yöneticisinden (Huawei CSMS / Vault) üretilmeli.
- **Keycloak**: aynı RDS'te `keycloak` veritabanı + kullanıcı. `infra/keycloak/realm-*.json` ilk açılışta içe aktarılır;
  bu dosyalar **geliştirme yönlendirme adresleri** içerir (`localhost:5173`) → konsol istemcisine
  `https://console.<domain>/*` eklenmeli (realm üretim katmanı: Takip). Yönetim konsolu Caddy'de
  `KC_ADMIN_ALLOW_CIDRS` dışına 403.
- `family-web`: `--profile family-web` ile; imaj hazır değil (yer tutucu).

## Sentetik izleme

`synthetic/probe.mjs` (compose'da 5 dk döngü, Helm'de `*/5` CronJob) her turda: Keycloak well-known → API
erişilebilirliği → client-credentials token → `POST /v1/protected-persons/{id}/test-sos` → durum `OPERATOR_QUEUE`
(veya sonrası) olana kadar yoklama. Metrikler Pushgateway'e (`synthetic_success`, `synthetic_blocked`,
`synthetic_signal_to_queue_seconds`, `synthetic_last_run_timestamp`, `synthetic_check_success{check}`) ve isteğe
bağlı Uptime Kuma push izleyicisine. Token/sır/kişi verisi log'a yazılmaz. `node probe.mjs --dry` ağsız yapılandırma
denetimi.

Kurulum (bir kez, ortam başına):

1. Keycloak `consumers` realm'inde gizli istemci `yanimda-synthetic`: _Client authentication_ açık, yalnız _Service
   accounts_; servis hesabına realm rolü `FAMILY`; `family-app`'teki gibi `aud=yanimda-api` audience eşleyicisi.
2. Bu istemcinin token'ıyla 3 kişi oluşturun (servis hesabı OWNER olur):
   `curl -X POST https://api.$DOMAIN/v1/protected-persons -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{"displayName":"SENTETIK 1"}'`
   → dönen `id`'ler `SYNTHETIC_PERSON_IDS`.

**Bilinen ödünleşim (dürüst not):** `test-sos` gerçek bir TEST olayı açar ve olay **operatör kuyruğuna düşer**; 5 dk'da
bir staging operatörlerinin önüne iş çıkar. API kişi başına 10 dk bekleme ve "açık olay varken yeni test yok" kuralı
uygular; sonda bu yüzden ≥ 3 kişiyi döndürür, ama TEST olayları kapatılmazsa 3 tur sonra hepsi meşgul olur
(`synthetic_blocked=1`, `SyntheticBlocked` uyarısı). "7 gün kesintisiz sentetik" kabulü için uygulamada **sentetik
bayrağı + otomatik kapatma** (kuyruğa düşünce ölç, operatöre göstermeden kapat) özelliği önerilir (Takip). Ayrıca
uygulamanın `signal_to_screen_seconds`'ı test olaylarını bilerek dışlar; sentetik süre ayrı metriktir ve "ekrana
yayın"ı (WS) değil "kuyruğa düşüş"ü ölçer (operatör realm'i OTP istediği için servis hesabı WS'e bağlanamaz).
Görevdeki "simülatör TEST sinyali" yerine `test-sos` kullanıldı: üretimde `SIMULATOR_ENABLED=false`.

## Yedek ve geri yükleme tatbikatı

- `backup` kabı her gün `BACKUP_AT` (UTC) `pg-backup.sh`: `pg_dump -Fc` → `s3://$BACKUP_S3_BUCKET/$PREFIX/YYYY/MM/DD/`
  - `.manifest` (sha256, boyut, döküm öncesi/sonrası satır sayımları). `backup_last_success_timestamp_seconds` →
    Pushgateway (`BackupStale` > 26 saat). Kullanıcı: `CREATE ROLE yanimda_backup LOGIN PASSWORD '…'; GRANT pg_read_all_data TO yanimda_backup;`
- `restore-drill.sh` (VPS'te haftalık, ör. systemd timer `OnCalendar=Sun 04:00`): en yeni dökümü indirir, ağsız geçici
  `timescale/timescaledb:2.17.2-pg16` kabına `timescaledb_pre_restore()`/`post_restore()` ile geri yükler,
  `schema_migrations` + `event.event`/`signal.signal`/`event.transition` sayımlarını manifest aralığıyla karşılaştırır,
  süreyi yazar; **> 3600 sn veya uyuşmazlıkta çıkış 1** ve `restore_drill_*` metrikleri.
- PITR tatbikatı (RDS'te yeni örneğe zamana geri dönüş) çeyrekte bir elle; RTO hedefi < 1 saat.

## İzleme

`monitoring/alerts.yml` (promtool ile doğrulandı): kuyruk gecikmesi (`QueueWaitTooLong` gerçek olay > 20 sn,
`SignalToScreenSlow`, `OperatorClaimSlow`), outbox birikimi (`OutboxBacklog`, `OutboxStalled`, `OutboxDeadLetters`,
`OutboxWorkerDown`), CPaaS/bildirim hata oranı, disk (%15/%5, 24 saatte dolma), Postgres/Redis/API/dış uç/TLS, sentetik,
yedek/tatbikat. critical → PagerDuty + Telegram + e-posta, warning → Telegram + e-posta (`monitoring/alertmanager.yml`;
sırlar `monitoring/secrets/` dosyaları).

Uygulamada outbox/CPaaS metriği olmadığı için bunlar `postgres_exporter` özel sorgularından gelir
(`monitoring/postgres-exporter-queries.yml`, yalnız sayım). İzleme kullanıcısı:

```sql
CREATE ROLE yanimda_monitor LOGIN PASSWORD '…';
GRANT pg_monitor TO yanimda_monitor;
GRANT USAGE ON SCHEMA event, telephony, notify TO yanimda_monitor;
GRANT SELECT ON event.outbox, event.outbox_dlq, event.event, telephony.call, notify.notification TO yanimda_monitor;
```

Grafana `127.0.0.1:3001` (SSH tüneli), `infra/grafana/konsol.json` otomatik yüklenir. Dış uç hedefleri:
`monitoring/targets/*.yml.example` → `.yml`. Uptime Kuma (`status.<domain>`): HTTP izleyiciler (konsol, auth
well-known, API `/v1/queue` 401 kabul) + sentetik için _Push_ izleyici (URL'i `UPTIME_KUMA_PUSH_URL`), herkese açık
durum sayfası.

## Helm (Faz 3)

```sh
kubectl create configmap yanimda-realms --from-file=infra/keycloak/realm-operations.json --from-file=infra/keycloak/realm-consumers.json
helm upgrade --install yanimda infra/helm/yanimda -n yanimda-staging -f infra/helm/yanimda/values-staging.yaml
```

- Sırlar **yalnız** `existingSecret` adlarıyla (`yanimda-api`, `yanimda-keycloak`, `yanimda-synthetic`, küme içi
  depolar açıksa `yanimda-timescaledb`/`-redis`/`-minio`); anahtar listesi `values.yaml` yorumlarında. Önerilen:
  External Secrets Operator (Huawei CSMS/Vault → Secret) veya SOPS (age) ile şifreli manifest + Flux/Argo.
- Üretimde `timescaledb/redis/minio.enabled=false` → yönetilen hizmetler (`DATABASE_URL`/`REDIS_URL`/`S3_*` Secret'ta).
- NetworkPolicy: sürümde varsayılan red; HTTP yalnız ingress denetleyici ad alanından; Postgres/Redis/MinIO yalnız
  `api`/`worker`/`keycloak`'tan; metrik portları yalnız `monitoring` ad alanından. Ingress'te metrik yolu yok.
- `files/` altındaki `probe.mjs`, `alerts.yml`, `konsol.json` tek kaynağa sembolik bağdır (Helm içeriği dahil eder).
- Prob'lar: API TCP (Nest portu ancak tüm modüller ve migration hazır olunca açar), Keycloak `/health/*` (9000).

## Doğrulama (yerel, yalnız Docker)

```sh
R=$PWD   # repo kökü
docker run --rm -v "$R":/w -w /w/infra/terraform hashicorp/terraform:1.9.8 fmt -check -recursive
docker run --rm -v "$R":/w -w /w/infra/terraform/envs/staging hashicorp/terraform:1.9.8 init -backend=false -input=false
docker run --rm -v "$R":/w -w /w/infra/terraform/envs/staging hashicorp/terraform:1.9.8 validate
docker run --rm -v "$R/infra":/infra -w /infra/helm alpine/helm:3.16.2 lint yanimda --strict
docker run --rm -v "$R/infra":/infra -w /infra/helm alpine/helm:3.16.2 lint yanimda --strict -f yanimda/values-staging.yaml
docker run --rm -v "$R/infra":/infra -w /infra/helm alpine/helm:3.16.2 template yanimda yanimda -f yanimda/values-staging.yaml \
  | docker run --rm -i ghcr.io/yannh/kubeconform:v0.6.7 -strict -summary -ignore-missing-schemas -kubernetes-version 1.29.0 -
docker run --rm -v "$R/infra/monitoring":/m -v "$R/infra/monitoring/alerts.yml":/etc/prometheus/alerts.yml \
  --entrypoint promtool prom/prometheus:v2.55.1 check config /m/prometheus.yml
docker run --rm -v "$R/infra/monitoring":/m --entrypoint promtool prom/prometheus:v2.55.1 check rules /m/alerts.yml
docker run --rm -v "$R/infra/monitoring":/m --entrypoint amtool prom/alertmanager:v0.27.0 check-config /m/alertmanager.yml
docker run --rm -v "$R/infra/monitoring":/m grafana/loki:3.2.1 -config.file=/m/loki-config.yml -verify-config
cp infra/.env.prod.example infra/.env.prod   # yalnız doğrulama için; git dışı
docker compose --env-file infra/.env.prod -f infra/docker-compose.prod.yml config -q
docker compose --env-file infra/.env.prod -f infra/monitoring/docker-compose.monitoring.yml config -q
docker run --rm -v "$R/infra":/mnt koalaman/shellcheck:v0.10.0 backup/pg-backup.sh backup/restore-drill.sh backup/schedule.sh
node --check infra/synthetic/probe.mjs
```

**Doğrulanmadı** (gerçek ortam yok): `terraform plan/apply` (sağlayıcı API'si, flavor/imaj/EIP tipleri, RDS
`timescaledb` eklentisi, OBS WORM), ACME sertifikası alımı, Keycloak `start` ile üretim kipi, konsol imajının tam
derlemesi, Kubernetes'e kurulum (ServiceMonitor/PrometheusRule CRD şemaları kubeconform'da atlandı), Alertmanager'ın
gerçek kanallara gönderimi, Uptime Kuma yapılandırması (arayüzden).

## Takip

- API'de ayrık, kimliksiz **`/health` (canlılık) ve `/ready` (DB + Redis)** uçları; prob'lar ona geçsin.
- Uygulama metrikleri: **outbox birikimi/yaşı, DLQ, işçi kirası sahibi**, **CPaaS istek/hata sayaçları** (sağlayıcı ve
  durum etiketiyle), bildirim kanal hataları — şimdilik postgres_exporter sorgularıyla.
- **Sentetik bayrağı + otomatik kapatma** (TEST olayı operatöre gösterilmeden ölçülüp kapatılır) — 7 gün kabulünün ön
  koşulu.
- Keycloak realm **üretim katmanı** (yönlendirme adresleri, `sslRequired=all`, `yanimda-synthetic` istemcisi).
- Egress NetworkPolicy (Twilio/FCM/APNs/OBS izin listesi); konsol için CSP başlığı (Twilio Voice SDK uçlarıyla).
- `envs/prod`, CI'da imaj imzalama (cosign) ve Trivy taraması; compose → Helm geçişinde External Secrets kurulumu.
