# Güvenlik (T-081)

Görev: `docs/TASKS-DETAY.md` → T-081. Kabul: ASVS L2 kontrol listesi ≥ %90, kritik bulgu 0.
Güncel durum: **%92,6 (187/202), hedef (%90) repodaki kanıtla karşılandı; doğrulanmış kritik bulgu 0** — kalan 15 satır ve gerçek ortam doğrulamaları `asvs-l2.md` (üçüncü tur) ve `altyapi-kanit.md`'de; sızma testi bekliyor (G-1 dağıtık saldırgan önce).

| Belge | İçerik |
| --- | --- |
| [asvs-l2.md](asvs-l2.md) | OWASP ASVS 4.0.3 L2 kontrol listesi (V1–V14), kanıt dosyaları, puan, öncelikli açıklar (G-1…G-20), %90'a giden yol |
| [sizma-testi-plani.md](sizma-testi-plani.md) | Dış sızma testi: kapsam, kurallar, staging hesapları, WSTG/MASVS yöntemi, takvim, raporlama, acil durdurma |
| [sertifika-sabitleme.md](sertifika-sabitleme.md) | Mobil SPKI sabitleme (Android/Wear OS, iOS, Flutter), rotasyon, test listesi; root/jailbreak uyarısı ve önerilen katalog anahtarları |
| [sirlar.md](sirlar.md) | Sır envanteri, KMS/Vault, "`.env` üretimde yok", `FIELD_ENC_KEYS` / `DEVICE_TOKEN_SECRET` rotasyonu, sızıntı müdahalesi, `health` şeması DB rol tasarımı |
| [tehdit-modeli.md](tehdit-modeli.md) | STRIDE tehdit modeli, güven sınırı diyagramı (1.1.4), bileşen güvenlik analizi (1.1.5), izleme |
| [sdlc.md](sdlc.md) | Uygulanan güvenli SDLC: aşama başına etkinlik ve kanıt dosyası, CI kapıları, inceleme, bağımlılık, sürüm imzası (1.1.1) |
| [saklama.md](saklama.md) | Veri sınıfı başına saklama süresi ve mekanizma, temizlik işi, kişisel veri dışa aktarma kararı, KVKK başvuru süreci (8.3.2, 8.3.8) |
| [hesap-kurtarma.md](hesap-kurtarma.md) | Parola ve OTP kaybında kurtarma: operations (yönetici destekli, dört göz), consumers (self-servis), kimlik doğrulama adımları (2.5.6, 2.5.7) |
| [dns-envanteri.md](dns-envanteri.md) | DNS envanteri, sökme sırası, aylık alt alan adı devralma denetimi (10.3.3) |
| [risk-kabulleri.md](risk-kabulleri.md) | Risk kabulü kaydı: bellekte silme (8.3.6), consumers oturum süreleri (3.3.2), `sessionStorage` token (8.2.2) — hepsi sahip onayı bekliyor |
| [altyapi-kanit.md](altyapi-kanit.md) | ASVS paket B (altyapı) ve F (`consumers` realm) için gereksinim → dosya:satır kanıt tablosu, oturum süresi risk kabulü, gerçek ortamda yapılacak doğrulamalar |

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
