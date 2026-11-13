# Güvenli yazılım geliştirme yaşam döngüsü (SDLC)

T-081, ASVS 1.1.1. Tarih: 2026-11-13. Bu belge **bugün fiilen uygulananı** anlatır; her adımın kanıtı repodaki
dosyadır. Repoda kanıtı olmayan ayarlar (GitHub dal koruması, mobil imzalama) ayrıca işaretlidir. Kapsam: bu monorepo
(API, konsol, aile web, sözleşmeler, kural paketi, altyapı). Mobil uygulamalar (`yanimda-ios`, `yanimda-android`,
`yanimda-wear`) ayrı depolardadır; aynı ilkeler oralarda ayrı belgelenir.

## 1. Aşamalar ve güvenlik etkinlikleri

| Aşama | Etkinlik | Kanıt (dosya) | Zorunlu mu |
| --- | --- | --- | --- |
| Gereksinim | PRD kimlikli görev (A-01, D-03 …); görev başına kabul kriteri; güvenlik / KVKK kuralları ("olay kaybı sıfır", "log'da PII yok", "sağlık verisi yalnız olay anında", "metin yalnız katalogdan") | `CLAUDE.md`, `docs/TASKS-DETAY.md`, `docs/tasks/*.md` | evet (görev şablonu) |
| Tasarım | Tehdit modeli (STRIDE), güven sınırları ve bileşen analizi; yeni uç / dış servis / veri türü ekleyen PR açıklamasında "tehdit modeli etkisi" | `docs/security/tehdit-modeli.md` | evet (PR açıklaması) |
| Tasarım | Mimari kararlar ve risk kabulleri yazılı | `docs/decisions/`, `docs/security/risk-kabulleri.md` | karar başına |
| Geliştirme | Önce test (birim + gerekirse entegrasyon), sonra kod; OpenAPI sözleşmesi güncellenir | `CLAUDE.md` "Kurallar"; `apps/api/test/*.spec.ts`; `packages/contracts/openapi.yaml` | evet |
| Geliştirme | TypeScript strict, ESLint + Prettier; commit öncesi `lint-staged` (prettier + eslint --fix) | `tsconfig.base.json`, `eslint.config.js`, `.husky/pre-commit`, `package.json` `lint-staged` | evet (kanca) |
| Geliştirme | Commit biçimi `<alan>(<PRD/görev>): <özet>` → her değişiklik bir gereksinime izlenir | `commitlint.config.js`, `.husky/commit-msg` | evet (kanca) |
| Geliştirme | Sırlar repoda yok; `.env.example` yalnız boş / geliştirme değerleri; üretimde zorunlu sır yoksa API açılmaz | `docs/security/sirlar.md`, `.env.example`, `field-cipher.ts` `fromEnv` | evet |
| Doğrulama (her push / PR) | Lint, tip denetimi, birim + entegrasyon testleri (PGlite), kural paketi doğrulaması, derleme, erişilebilirlik (axe) | `.github/workflows/ci.yml` → `check` | evet (CI kırmızı = birleşmez*) |
| Doğrulama | Uçtan uca + kaos (Redis / Postgres kesintisi, `kill -9`) ve bu akışların API log'unda PII denetimi | `ci.yml` → `e2e`, `console-e2e`; `apps/api/test/e2e/pii-audit-cli.ts` | evet |
| Doğrulama | Log'da PII birim denetimi (kişi, tıbbi özet, rehber, SOS, 112, arama akışları) | `apps/api/test/pii-logs.spec.ts`, `test/support/pii-scan.ts` | evet |
| Doğrulama | SAST: Semgrep (proje kuralları: log'da PII alanı, gövde log'u, `Math.random`, sır varsayılanı + TS/Node/React/JWT/sır setleri), ERROR'da kırmızı | `ci.yml` → `sast`, `.semgrep/yanimda.yml` | evet |
| Doğrulama | Sır taraması: gitleaks tüm git geçmişi; bilinen sahte test sırları gerekçeli istisna | `ci.yml` → `sast`, `.gitleaksignore` | evet |
| Doğrulama | Altyapı: terraform fmt/validate, helm lint + kubeconform, Prometheus / Alertmanager / Loki / Caddy yapılandırma denetimi, compose config, shellcheck | `ci.yml` → `infra` | evet |
| Doğrulama | İmaj: boyut sınırı, gerçek TimescaleDB'de açılış + uçtan uca, üretim imajında token'sız sinyal 401, Trivy (HIGH/CRITICAL, düzeltmesi olan) | `ci.yml` → `image`, `apps/api/Dockerfile` | evet |
| Doğrulama (PR + haftalık) | DAST: ZAP API taraması (OpenAPI'den, üretim imajı) + konsol baseline; saldırı yükü altında PII log denetimi | `.github/workflows/security.yml` (her PR, pazartesi 04:00) | FAIL'de kırmızı |
| Doğrulama (gece / haftalık) | Yük ve kaos testleri | `.github/workflows/load.yml`, `load-v1.yml`; `docs/test-reports/` | rapor |
| Doğrulama (dönemsel) | Dış sızma testi: canlıya çıkıştan önce, sonra yılda bir ve büyük mimari değişiklikte | `docs/security/sizma-testi-plani.md` | v1.0 kapısı |
| Doğrulama | ASVS L2 öz değerlendirme; açıklar (G-1…) öncelikli | `docs/security/asvs-l2.md` | görev kabulü |
| Bağımlılık | Dependabot haftalık (npm gruplu, GitHub Actions, API Dockerfile tabanı); güvenlik uyarıları anında; kilit dosyası `--frozen-lockfile`; sabit sürümlü imajlar | `.github/dependabot.yml`, `pnpm-lock.yaml`, `ci.yml` | evet |
| Sürüm | main / `v*` etiketi: Trivy geçmeden itme yok → GHCR → cosign anahtarsız imza (GitHub OIDC) → SPDX SBOM tasdiki → imza doğrulaması; BuildKit provenance + SBOM | `.github/workflows/release-image.yml` | evet |
| Sürüm | Değişiklik günlüğü | `CHANGELOG.md` | sürüm başına |
| İşletim | Güvenlik olayı metriği + uyarı, Keycloak olay kaydı, log saklama 14 gün, yedek + geri yükleme tatbikatı | `tehdit-modeli.md` "İzleme", `infra/monitoring/alerts.yml`, `infra/backup/` | evet |
| İşletim | Sır rotasyonu ve sızıntı müdahalesi | `docs/security/sirlar.md` | olay başına |
| İşletim | Hesap kurtarma (parola / OTP kaybı) | `docs/security/hesap-kurtarma.md` | olay başına |
| İşletim | DNS envanteri ve alt alan adı devralma denetimi | `docs/security/dns-envanteri.md` | aylık |
| İşletim | Veri saklama süreleri ve temizlik işi | `docs/security/saklama.md` | sürekli (iş) |

\* Dal koruması (main'e yalnız PR, CI yeşil, en az bir onay) GitHub depo ayarıdır, repoda kanıtı yoktur. main'e
giden değişiklikler fiilen PR ile birleşiyor (`git log --merges`), ama zorunluluk ayarı **doğrulanmalı** (açık iş D-1).

## 2. Kod incelemesi

- Her değişiklik PR ile gelir; PR açıklaması görev kimliği, test sonucu, "tehdit modeli etkisi" içerir.
- İnceleyen, `CLAUDE.md` "Bitmeden kontrol et" listesini (06 "Tanımı tamamlandı", her kabul kriteri için test, log'da
  PII yok, katalog dışı metin yok) ve aşağıdakileri denetler: yeni uçta kimlik doğrulama + yetki (başka ailenin
  verisi 404), hız sınırı ihtiyacı, `Cache-Control: no-store`, sağlık verisi çözümü yalnız olay bağlamında ve
  `audit.log`'da, outbox ile aynı transaction, sırların ortamdan okunması.
- Yapay zekâ destekli geliştirme (Claude Code) aynı kurallara tabidir: kurallar `CLAUDE.md`'de, çıktı aynı CI
  kapılarından geçer ve insan incelemesiyle birleşir.

## 3. Güvenlik açığı yönetimi

Bugün: CI kapıları kırmızıyken birleştirme yapılmaz; ASVS açıkları önceliklendirilmiş (`asvs-l2.md` G-1…G-20). Yazılı
hedef süre yoktu; aşağıdaki süreler **önerilir, sahip onayı bekliyor**:

| Önem | Hedef süre (düzeltme veya tarihli risk kabulü) |
| --- | --- |
| Kritik (kimliksiz sağlık / kişisel veri okuma, sahte acil olay) | 72 saat; sürüm durdurulur |
| Yüksek | 14 gün |
| Orta | 90 gün |
| Düşük | sonraki planlı sürüm |

Bulgu kaynakları: CI (Semgrep, Trivy, gitleaks, ZAP), Dependabot uyarıları, sızma testi, ASVS öz değerlendirme,
dışarıdan bildirim. Kabul edilen riskler `risk-kabulleri.md`'ye sahip onayıyla yazılır.

## Açık işler

| # | İş |
| --- | --- |
| D-1 | GitHub dal koruması (zorunlu PR + yeşil CI + 1 onay + imzalı commit opsiyonu) ayarını doğrula ve ekran görüntüsü / `gh api` çıktısını buraya ekle |
| D-2 | Dağıtımda imza doğrulaması: compose / Helm imajı digest ile çeker ama `cosign verify` dağıtım adımında yok (yalnız sürüm işinde) |
| D-3 | Mobil depolar için aynı tablo (imzalama anahtarları, Play App Signing, App Store Connect, MASVS denetimi) |
| D-4 | `SECURITY.md` (dışarıdan açık bildirimi kanalı) |
| D-5 | Konsol ve aile web imajları için de cosign + SBOM (bugün yalnız API imajı) |
