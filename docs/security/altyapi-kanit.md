# Altyapı ve kimlik kanıtı (ASVS paket B + F)

T-081. Tarih: 2026-11-13, dal `claude/t081-infra-keycloak`. `asvs-l2.md` (2026-11-10/11) "%90'a giden yol"
tablosundaki **paket B** (üretim altyapısı kanıtı) ve **paket F** (`consumers` realm politikası) satırları için
repodaki kanıtın tam yeri ve yalnız gerçek ortamda kanıtlanabilecek kısım. Puanlama `asvs-l2.md`'de yapılır; buradaki
"önerilen durum" bir girdidir.

Ölçüt: **✅** = yapılandırma repoda, statik doğrulamadan geçti (CI "altyapı" işi) ve mümkünse yerelde çalıştırılarak
denendi; **⚠️** = repoda kısmi, kalan iş belirtildi. Yollar repo köküne göredir. Hiçbir şey gerçek bulut hesabında
uygulanmadı (`infra/README.md` "Doğrulanmadı").

## Paket F — kimlik (Keycloak realm'leri)

| ASVS | Gereksinim | Önerilen | Repo kanıtı | Yalnız gerçek ortamda |
| --- | --- | --- | --- | --- |
| 2.1.1 (consumers) | Parola ≥ 12 | ✅ | `infra/keycloak/realm-consumers.json:20` `length(12) and maxLength(128) …`; test `infra/keycloak/keycloak.test.mjs:22` | — |
| 2.1.7 | İhlal edilmiş / yaygın parola denetimi | ✅ | Politika: `realm-consumers.json:20`, `realm-operations.json:19` `passwordBlacklist(yanimda-blacklist.txt)`. Liste: `infra/keycloak/password-blacklists/yanimda-blacklist.txt` (36 270 girdi, ≥ 12 karakter; kurallar `infra/keycloak/generate.mjs`, lisans: projenin kendi üretimi). Bağlama: `infra/docker-compose.yml:43`, `infra/docker-compose.prod.yml:150`, `infra/helm/yanimda/templates/keycloak.yaml:37-44,206`, CI `.github/workflows/ci.yml:90`. Gerçek ihlal listesiyle birleştirme: `generate.mjs --breached` (`infra/README.md` "Kara liste"; SecLists MIT). Keycloak 26.0.8'de denendi: `galatasaray1905` / `gALATASARAY1905` reddedildi, Türkçe hata `K-PWD-BLACKLISTED`. | Sürüm hazırlığında ihlal listesinin birleştirilip bağlandığı (`KC_BLACKLIST_DIR` / `keycloak.passwordBlacklist.existingConfigMap`) |
| 2.1.8 | Parola gücü göstergesi | ✅ | Tema `infra/keycloak/themes/yanimda/login/theme.properties:5,10` (keycloak.v2 üstüne), gösterge `…/resources/js/password-strength.js:150-151` (kayıt + parola güncelleme). Metinler `packages/messages/tr.json` `K-PWD-*` → üretilmiş `messages_tr.properties`, `strength-i18n.js`; kayma `generate.mjs --check` + `keycloak.test.mjs:18` (CI). Realm `loginTheme`: `realm-consumers.json:6`, `realm-operations.json:6`. Keycloak 26.0.8'de parola güncelleme sayfasında görüldü. | — |
| 3.3.2 (consumers) | Boşta / mutlak oturum süresi | ✅ (risk kabulüyle) | `realm-consumers.json:13-17` (SSO ve çevrimdışı 14 gün boşta / 30 gün mutlak, üst sınır açık), web istemcisi `:85-86` (30 dk / 12 sa = L2). Test `keycloak.test.mjs:34`. Gerekçe aşağıda "Oturum süreleri". | — |
| 3.5.1 | Token iptal edilebilir | ✅ | `realm-consumers.json:18-19` `revokeRefreshToken: true`, `refreshTokenMaxReuse: 0` (her yenilemede yeni token; eski token tekrar kullanılırsa oturum düşer). Cihaz token iptali zaten ✅. | — |
| 5.1.5 | Yönlendirme izin listesi | ✅ | `realm-operations.json:127-136`, `realm-consumers.json:46-49,80,84`: `${YANIMDA_*:geliştirme varsayılanı}`; üretim değerleri `infra/docker-compose.prod.yml:122-126`, `infra/helm/yanimda/templates/keycloak.yaml:138-147` (`https://console.<domain>/*`, `https://aile.<domain>/*`, uygulama şeması). `webOrigins: ["+"]` = yalnız bu kökenler. Test `keycloak.test.mjs:54`. Keycloak 26.0.8'de üretim değerleriyle içe aktarıldı: geliştirme adresi kalmadı. | Var olan realm'e uygulanması (içe aktarma yalnız realm yoksa çalışır; `infra/README.md` "Keycloak (T-081)") |

### Oturum süreleri (3.3.2 risk kabulü)

ASVS L2: 12 saat mutlak veya 30 dk boşta.

| İstemci | Boşta | Mutlak | L2 |
| --- | --- | --- | --- |
| `operations` / konsol | 1 sa | 12 sa | ✅ |
| `consumers` / `family-web` (tarayıcı) | 30 dk | 12 sa | ✅ |
| `consumers` / `family-app` (mobil; çevrimiçi ve çevrimdışı oturum aynı sınırda) | 14 gün | 30 gün | risk kabulü |

Önceki değer 30 / 90 gün (çevrimdışı 90 gün, üst sınırsız) idi. Mobil aile uygulamasında 30 dk/12 sa uygulanmaz:
uygulama günlerce açılmadan durur ve **acil durumda** (bildirime dokunulduğunda) yeniden giriş istemek yakının olaya
yetişmesini geciktirir. Kabul edilen kalan risk: çalınmış/kilitsiz telefonda 14 güne kadar oturum. Dengeleyiciler:
erişim token'ı 5 dk (`accessTokenLifespan: 300`); yenileme token'ı her kullanımda döner, tekrar kullanımı oturumu
düşürür (`revokeRefreshToken`, `refreshTokenMaxReuse: 0`); kaba kuvvet koruması; kullanıcı ve yönetici oturumu
kapatabilir (Keycloak hesap konsolu / yönetici API'si); Keycloak olayları e-postayla bildirilir. Mobil uygulama
kodu bu repoda değil: cihaz kilidi/biyometrik uygulama kilidi MASVS kapsamında doğrulanmalı. Gözden geçirme: yılda
bir veya oturum hırsızlığı olayında. Sahibi: ürün + güvenlik.

Bilinçli fark: `operations` realm'inde `revokeRefreshToken` açılmadı. Konsol birden çok sekmede aynı istemci
oturumunu paylaşır; döndürmede bir sekmenin yenilemesi diğerininkini geçersiz kılar ve operatör olay ortasında
oturumdan düşer. Operasyon oturumu zaten 1 sa boşta / 12 sa mutlak ve OTP zorunlu.

## Paket B — altyapı

| ASVS | Gereksinim | Önerilen | Repo kanıtı | Yalnız gerçek ortamda |
| --- | --- | --- | --- | --- |
| 1.2.2 | Bileşenler arası kimlik doğrulama | ✅ | Postgres: yalnız `hostssl` + `scram-sha-256` (`infra/terraform/modules/yanimda-env/main.tf:231-241`), uygulama hesabı `:244-249`. Redis: DCS ACL hesapları uygulama `write` / izleme `read` (`main.tf:308-322`), `REDIS_URL=rediss://yanimda-app:…` (`infra/.env.prod.example:27`), dışa aktarıcı `infra/monitoring/docker-compose.monitoring.yml:145`; küme içi Redis varsayılan kullanıcı kapalı + ACL (`infra/helm/yanimda/templates/datastores.yaml:171-174`, Redis 7.4'te denendi). Keycloak DB ayrı kullanıcı. Metrik ucu kimliksiz, yalnız ağla sınırlı (1.14.1). | `ACL WHOAMI`, `SELECT ssl FROM pg_stat_ssl` ile oturumların doğrulanması |
| 1.7.2 | Log'lar güvenli şekilde merkeze | ✅ (compose) | Promtail → Loki (`infra/monitoring/docker-compose.monitoring.yml:92-114`, `infra/monitoring/promtail-config.yml:10-11`), Loki/Grafana dışa kapalı (yalnız 127.0.0.1, `:29,47,84`), saklama 14 gün (`loki-config.yml:31`). | Kubernetes'te log toplayıcı küme eklentisi (Grafana Alloy/Promtail DaemonSet) chart'ta yok: küme kurulumunda doğrulanır |
| 1.9.1 | Bileşenler arası şifreli iletişim | ⚠️ (veri katmanı ✅) | Sunucu tarafı zorunlu TLS: RDS `hostssl` (`main.tf:231-241`), DCS `ssl_enable` (`main.tf:289`). İstemci: `sslmode=verify-full` (`infra/.env.prod.example:23,71,96,109`, `infra/helm/yanimda/values-staging.yaml:35`), `rediss://`, API'de `PGSSLMODE=verify-full` (`infra/docker-compose.prod.yml:57,73`, `infra/helm/yanimda/templates/api.yaml:110-113`). **Kalan:** vekil/ingress → api/konsol/keycloak ve Prometheus → metrik kap içi düz HTTP (tek VPS'te Docker köprüsü; K8s'te pod ağı). Kanca: `global.podAnnotations` (`values.yaml:19`, ör. Linkerd mTLS). | Servis ağı (mTLS) kurulumu |
| 1.9.2 | Karşı taraf doğrulanır | ✅ | Tüm TLS bağlantılarında sunucu doğrulaması: `verify-full` + iç CA (`docker-compose.prod.yml:14`, Helm `global.internalCa` `values.yaml:23-25`, `_helpers.tpl` `yanimda.internalCaMount`), Node `NODE_EXTRA_CA_CERTS`, Keycloak JDBC `sslrootcert`. `rejectUnauthorized`/`NODE_TLS_REJECT_UNAUTHORIZED` kapatılmıyor. Üretimde iç CA zorunlu (`templates/validate.yaml:20`). | RDS/DCS CA'larının `INTERNAL_CA_FILE`'a eklendiği |
| 1.14.1 | Farklı güven düzeyleri ayrık | ✅ | Metrik ayrı port, Ingress/Caddy'de yok, NetworkPolicy yalnız izleme ad alanı (`templates/networkpolicy.yaml:51-53`), compose'da yayınlanmaz (`docker-compose.prod.yml:30`). | — |
| 1.14.5 | Ağ düzeyinde yalıtım | ✅ | NetworkPolicy giriş varsayılan red + bileşen izinleri, **çıkış** varsayılan red + DNS/veri deposu/HTTPS/SMTP (`templates/networkpolicy.yaml:26-46` varsayılan red + DNS, `:86-104` giriş, `:105-169` çıkış; staging/prod açık `values-staging.yaml:58-61`, `values-production.yaml:65`; production'da zorunlu `validate.yaml:14`). Bulut: DB güvenlik grubu yalnız VPS'ten (`main.tf:92-107`), DCS beyaz liste (`:287`). Kap sertleştirmesi 14.2.6. | CNI'nin NetworkPolicy uyguladığı (Calico/Cilium); izinsiz pod'dan bağlantı denemesi |
| 9.1.1 | İstemci bağlantıları TLS | ✅ | Caddy ACME + HTTP→HTTPS, Ingress TLS (`templates/ingress.yaml:24-27`) + `force-ssl-redirect` (`values.yaml:235`, production'da zorunlu `validate.yaml:38`), Keycloak `sslRequired=all` (`docker-compose.prod.yml:122`, `values-staging.yaml:38`). | — |
| 9.1.2 | Güncel şifre takımları | ✅ | Caddy `tls_policy` (`infra/caddy/Caddyfile:14-20`, tüm sitelere `:23`): TLS 1.2'de yalnız ECDHE + AES-GCM/ChaCha20; ingress-nginx `infra/helm/ingress-nginx-values.yaml:9-11`. Yerelde (Caddy 2.8.4, OpenSSL 4.1): TLS 1.2 `ECDHE-ECDSA-AES128-GCM-SHA256`, CBC (`AES128-SHA256`, `ECDHE-RSA-AES128-SHA`) el sıkışma hatası. | `testssl.sh https://{api,console,auth,aile,status}.<domain>` |
| 9.1.3 | Yalnız TLS 1.2/1.3 | ✅ | `Caddyfile:16` `protocols tls1.2 tls1.3`; `ingress-nginx-values.yaml:9`. Yerelde TLS 1.0/1.1 `protocol version` uyarısıyla reddedildi. | `testssl.sh` |
| 9.2.2 | İç bağlantılar şifreli | ⚠️ | 1.9.1 ile aynı: DB, Redis, SMTP (STARTTLS, `docker-compose.prod.yml` `YANIMDA_KC_SMTP_STARTTLS`), Vault (HTTPS) ✅; kalan izleme kazıması ve vekil→uygulama düz HTTP. | Servis ağı |
| 9.2.3 | Dış sistemlere kimlikli bağlantı | ✅ | Redis ACL + parola (prod `main.tf:308-322`; yerel compose geliştirme içindir), Postgres SCRAM, SMTP kimlik doğrulamalı (`YANIMDA_KC_SMTP_AUTH: 'true'`), sağlayıcılar API anahtarıyla. | — |
| 9.2.4 | Sertifika iptal denetimi | ⚠️ | Caddy OCSP zımbalama varsayılan, ingress `enable-ocsp` (`ingress-nginx-values.yaml:14`). Ancak Let's Encrypt 2025'te OCSP'yi kaldırdı (iptal yalnız CRL; Caddy yerelde "no OCSP server specified" uyarısı verdi); Node istemcileri iptal denetlemez. Kısa ömürlü sertifika (≤ 90 gün) dengeleyici. | CA seçimi (OCSP/CRL) ve `TlsCertExpiringSoon` |
| 9.2.5 | Arka uç TLS hataları loglanır | ✅ | Uygulama hata kodunu loglar (`apps/api/src/common/safe-error.ts`: ör. `Error(SELF_SIGNED_CERT_IN_CHAIN)`); Promtail sayacı `promtail_custom_backend_tls_errors_total` (`infra/monitoring/promtail-config.yml:35-46`), Prometheus işi (`prometheus.yml:66`), uyarı `BackendTlsErrors` (`alerts.yml:176`). | Uyarının bir kez tetiklendiğinin görülmesi (yanlış CA ile) |
| 7.3.3 | Log'lar yetkisiz erişim/değişikliğe karşı korunur | ✅ (L2) | Loki/Grafana dışa kapalı (`docker-compose.monitoring.yml:29,47,84`; Loki'nin portu yok), Grafana parolalı, Promtail docker.sock salt okunur (`:113`); uygulama denetim kaydı yalnız eklenebilir (`apps/api/drizzle/migrations/0002_event_persistence/up.sql:23-43`). Öneri (L3): log kopyası sunucu dışında WORM kovada. | VPS kök erişiminin yalnız yönetici CIDR + anahtarla olduğu (`main.tf:80-89` `vps_ssh`) |
| 7.3.4 | Saat eşitleme | ✅ | chrony + bulut NTP + UTC (`infra/terraform/modules/yanimda-env/user_data.sh.tftpl:8-18`, `variables.tf` `ntp_servers`), uyarılar `ClockNotSynchronised` / `ClockSkew` (`infra/monitoring/alerts.yml:162-174`). RDS saat dilimi sabit. | `chronyc tracking`; K8s düğümleri (yönetilen küme) |
| 14.1.4 | Otomatik, güvenli yeniden dağıtım | ✅ | Terraform (`infra/terraform`), compose + runbook (`infra/README.md`), Helm (`infra/helm/yanimda`), GitOps otomatik eşitleme (`infra/k8s/argocd-yanimda-staging.yaml:24-27`), yedek + haftalık geri yükleme tatbikatı (`infra/backup/restore-drill.sh`). | Tam kurulum süresinin ölçülmesi (RTO < 1 sa) |
| 14.1.5 | Güvenlik yapılandırması bütünlüğü | ✅ | Argo CD `selfHeal` (kurcalama geri alınır, `argocd-yanimda-staging.yaml:27`), Kyverno yalnız cosign imzalı + SBOM tasdikli imaj (`infra/k8s/kyverno-verify-images.yaml:24-44`, `validationFailureAction: Enforce`), production ön koşulları şablonda zorlanır (`infra/helm/yanimda/templates/validate.yaml:9-40`; CI negatif test `ci.yml`), CI statik doğrulama. | Argo CD / Kyverno kurulumu; imzasız imajın reddi |
| 14.2.6 | Saldırı yüzeyi daraltma | ✅ | Pod: `runAsNonRoot`, seccomp, `drop: [ALL]`, `allowPrivilegeEscalation: false` (`templates/_helpers.tpl:49-54`, `values.yaml:13-16`); salt okunur kök api/worker/web/sentetik/redis ve **Keycloak** (`templates/keycloak.yaml:76-98`, docker `--read-only` ile Keycloak 26.0 `start` denendi). Compose: api/worker/konsol/sentetik + **caddy** (`docker-compose.prod.yml:172-176`, yerelde çalıştı) + **backup** (`:226-227`) salt okunur / `cap_drop: ALL`; keycloak `cap_drop: ALL` (`:119`). | — |
| 13.2.6 | Başlık/gövde bütünlüğü (TLS) | ✅ | 9.1.1–9.1.3. | `testssl.sh` |
| 6.1.1 | Düzenlenmiş kişisel veri durağanda şifreli | ✅ (altyapı) | Müşteri yönetimli KMS anahtarı, yıllık rotasyon (`main.tf:12-25`): ECS sistem diski (`:136`), veri diski (`:153`), RDS diski + yedekleri (`:214`), OBS kovaları SSE-KMS (`:337-338,350-351`). Sağlık/kapı notu ayrıca alan şifreli. Ad/telefon/adres alan şifrelemesi uygulama kararı (G-10). | Konsolda disk/RDS/OBS "şifreli" durumu (`terraform show`) |
| 6.4.1 | Sır yönetim çözümü | ✅ (Kubernetes) / ⚠️ (compose) | External Secrets Operator: her `existingSecret` için `ExternalSecret` (Vault KV v2), isteğe bağlı Vault `SecretStore` (`infra/helm/yanimda/templates/externalsecrets.yaml:25-67`), staging/prod açık, production'da zorunlu (`validate.yaml:17`). Tek VPS compose yolu hâlâ `.env.prod` dosyası (`docs/security/sirlar.md` §3). | Vault (KMS auto-unseal, denetim kaydı) kurulumu; ESO `SecretSynced` |
| 6.4.2 | Anahtar materyali uygulamaya açık değil (KMS/HSM) | ⚠️ | Durağan veri anahtarı KMS'te (6.1.1), Vault kökü KMS ile mühürlenir. **Kalan:** `FIELD_ENC_KEYS`/`DEVICE_TOKEN_SECRET` süreç belleğinde; zarf şifreleme (KMS/Vault Transit) uygulama değişikliği ister (paket E). | — |

## Gerçek ortamda yapılacak doğrulamalar

1. `testssl.sh --severity LOW https://<host>` beş genel ad için: yalnız TLS 1.2/1.3, CBC/RSA anahtar değişimi yok,
   HSTS, sertifika zinciri; sonuç `docs/security/` altına.
2. VPS'ten: `psql "postgres://…?sslmode=verify-full&sslrootcert=…" -c 'select ssl,version from pg_stat_ssl where pid=pg_backend_pid()'`;
   `sslmode=disable` ile bağlantının **reddedildiği** (pg_hba hostssl); `redis-cli --tls --cacert … --user yanimda-app ACL WHOAMI`;
   parolasız/`default` ile reddi.
3. `terraform plan/apply` sonrası disk, RDS ve OBS şifreleme durumunun KMS anahtarını gösterdiği.
4. Kubernetes: Argo CD `Synced/Healthy`, elle değiştirilen Deployment'ın geri alındığı; Kyverno'nun imzasız imajı
   reddettiği; NetworkPolicy'nin izinsiz pod'dan Postgres/metrik erişimini engellediği; ESO Secret'larının eşlendiği.
5. Keycloak: var olan realm'lere politika ve yönlendirme değişikliklerinin uygulandığı (yönetici API'si); ihlal
   listesi birleştirilmiş dosyanın bağlı olduğu (açılış log'unda `Loading blacklist finished … passwords=<n>`).
6. `chronyc tracking` sapma < 50 ms; `ClockSkew` uyarısı sessiz.

## Notlar

- `ingress-nginx` projesi 2026'da bakım dışı kaldı (Kubernetes SIG Network duyurusu). Chart `className: nginx`
  kullanıyor; Gateway API tabanlı bir denetleyiciye geçişte `ingress-nginx-values.yaml` politikası taşınmalı.
- Keycloak `--import-realm` yalnız realm yoksa içe aktarır; bu daldaki realm değişiklikleri var olan ortamlara
  kendiliğinden gelmez.

## Yerel doğrulama (2026-11-13)

| Komut | Sonuç |
| --- | --- |
| `terraform fmt -check -recursive`, `terraform init -backend=false` + `validate` (hashicorp/terraform:1.9.8, huaweicloud 1.100.0) | geçti |
| `helm lint --strict` (values, values-staging, values-production), `helm template \| kubeconform -strict` (28 / 32 / 31 kaynak) | geçti |
| `helm template -f values-production.yaml --set redis.enabled=true` (ve 6 benzer ihlal) | beklendiği gibi reddedildi |
| `promtool check config` / `check rules`, `amtool check-config`, `loki -verify-config`, `promtail -check-syntax`, blackbox `--config.check`, `caddy validate` (iki Caddyfile) | geçti |
| `docker compose config -q` (prod, prod + family-web, izleme, geliştirme) | geçti |
| shellcheck (backup, scripts) | geçti |
| `node infra/keycloak/generate.mjs --check`, `node --test infra/keycloak/keycloak.test.mjs` (8 test) | geçti |
| Keycloak 26.0.8 geçici kap: içe aktarma (geliştirme ve üretim yer tutucularıyla), kara liste, tema/gösterge, salt okunur kök | çalıştı |
| Caddy 2.8.4 sertleştirilmiş kap (`--read-only --cap-drop ALL --cap-add NET_BIND_SERVICE`) + openssl TLS sürüm/takım denemesi | çalıştı; TLS 1.0/1.1 ve CBC reddedildi |
| Redis 7.4 ACL dosyası (varsayılan kapalı; FLUSHALL/KEYS/CONFIG reddi; INFO/EVAL/SET açık) | çalıştı |
