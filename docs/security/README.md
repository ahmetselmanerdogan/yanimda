# Güvenlik (T-081)

Görev: `docs/TASKS-DETAY.md` → T-081. Kabul: ASVS L2 kontrol listesi ≥ %90, kritik bulgu 0.
Güncel durum: **%62,9 (127/202), hedef karşılanmıyor; doğrulanmış kritik bulgu 0** (G-1 yüksek, kritiğe yakın) — ayrıntı ve %90 yol haritası `asvs-l2.md`'de.

| Belge | İçerik |
| --- | --- |
| [asvs-l2.md](asvs-l2.md) | OWASP ASVS 4.0.3 L2 kontrol listesi (V1–V14), kanıt dosyaları, puan, öncelikli açıklar (G-1…G-20), %90'a giden yol |
| [sizma-testi-plani.md](sizma-testi-plani.md) | Dış sızma testi: kapsam, kurallar, staging hesapları, WSTG/MASVS yöntemi, takvim, raporlama, acil durdurma |
| [sertifika-sabitleme.md](sertifika-sabitleme.md) | Mobil SPKI sabitleme (Android/Wear OS, iOS, Flutter), rotasyon, test listesi; root/jailbreak uyarısı ve önerilen katalog anahtarları |
| [sirlar.md](sirlar.md) | Sır envanteri, KMS/Vault, "`.env` üretimde yok", `FIELD_ENC_KEYS` / `DEVICE_TOKEN_SECRET` rotasyonu, sızıntı müdahalesi, `health` şeması DB rol tasarımı |

Betik: [`scripts/security/spki-pin.sh`](../../scripts/security/spki-pin.sh) — bir host'un zincirindeki her
sertifikanın veya yerel PEM/DER/CSR/anahtar dosyasının SPKI pin'ini (`sha256/<base64>`) yazar.

```sh
scripts/security/spki-pin.sh api.yanimda.app:443        # canlı zincir
scripts/security/spki-pin.sh --file yanimda-k2.key      # yedek anahtar
```

## CI güvenlik işleri

| Nerede | Ne | Düşürür mü |
| --- | --- | --- |
| `ci.yml` → `sast` | Semgrep (`.semgrep/yanimda.yml` proje kuralları: log'da PII alanı, gövde log'u, `Math.random`, sır varsayılanı + `p/typescript`, `p/nodejs`, `p/react`, `p/jwt`, `p/secrets`) ve gitleaks (tüm git geçmişi; bilinen sahte test sırları `.gitleaksignore`) | ERROR / sızıntıda evet |
| `ci.yml` → `e2e`, `console-e2e` | PII log denetimi (`apps/api/test/e2e/pii-audit-cli.ts`): uçtan uca, kaos ve Playwright akışlarında API log'u taranır | bulguda evet |
| `ci.yml` → `check` | `apps/api/test/pii-logs.spec.ts`: kişi + tıbbi özet + rehber + SOS + kişi kartı + 112 + arama + CPaaS 500 akışında tüm log'lar; tarayıcı birim testleri | evet |
| `ci.yml` → `image` | Trivy (HIGH/CRITICAL, düzeltmesi olan) + üretim imajında token'sız sinyal 401 | evet |
| `security.yml` → `zap` | ZAP API taraması (OpenAPI, üretim imajı + gerçek TimescaleDB) ve konsol baseline; ZAP saldırı yükü altında API log'unda PII denetimi | FAIL'de evet, WARN raporlanır |
| `release-image.yml` | main/etiket: Trivy → GHCR → cosign anahtarsız imza + doğrulama, SPDX SBOM tasdiki | evet |
| `.github/dependabot.yml` | npm (gruplu), GitHub Actions, API Dockerfile tabanı; haftalık | — |

PII tarayıcısının kalıpları (`apps/api/test/support/pii-scan.ts`): telefon (E.164 ve 05xx), TC kimlik (sağlamalı),
e-posta, JWT, Bearer, IBAN, adres sözcükleri, ≥ 4 ondalık koordinat, tıbbi terimler, testin verdiği adlar/değerler.
Bulgu değeri yazılmaz (maskeli). Yerelde: `pnpm --filter @yanimda/api exec tsx test/e2e/pii-audit-cli.ts <log|dizin>`.

## İlkeler (özet)

- Kişisel/sağlık verisi log'a yazılmaz; hata log'ları `safeError` ile yalnız ad + kod (`apps/api/src/common/safe-error.ts`).
- Sağlık verisi yalnız olay anında, olayı üstlenen operatöre çözülür ve her çözüm `audit.log`'a yazılır.
- Sırlar repoda ve imajda yok; üretimde zorunlu sır eksikse API açılmaz.
- Kullanıcıya gösterilen her metin `packages/messages` kataloğundan; güvenlik uyarıları için önerilen anahtarlar
  `sertifika-sabitleme.md` §6'da (katalog henüz güncellenmedi).
