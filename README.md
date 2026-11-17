# Yanımda (çalışma adı)

Akıllı saat tabanlı, insan operatörlü acil müdahale ve iyilik hali servisi.
Pronet'in ev için yaptığını insan için yapar: saat → olay motoru → Sağlık Haber Alma Merkezi → ambulans/aile/komşu.

## Başlangıç

```bash
corepack enable     # pnpm 9.12 (package.json packageManager)
pnpm install        # Husky git hook'larını da kurar
scripts/dev-up.sh   # docker compose up (Keycloak realm içe aktarımı dahil) + migration + demo kişi/cihaz
pnpm dev            # api :3000, console :5173
pnpm test
pnpm --filter @yanimda/api test:e2e   # uçtan uca + kaos (redis-server gerekir, Docker gerekmez)
pnpm --filter @yanimda/api stack:local # Redis + PGlite sunucusu + API (Docker'sız yerel yığın)
scripts/load-smoke.sh -e DURATION=2m    # k6 duman testi (k6 gerekir)
scripts/dev-up.sh --smoke               # Docker'sız: yerel yığın + simülatör fall → kuyrukta (T-008 kabulü)
pnpm --filter @yanimda/simulator start -- fall --person pp_demo --no-cancel
# diğer komutlar: sos, cancel, heartbeat, offbody, onbody, battery, inactivity, charge-start, charge-end, spo2,
# skintemp, scenario, pendant (--dry: göndermeden yazdır; ayrıntı packages/simulator/src/index.mjs başında)
```

## Yapı

- `apps/api` NestJS modüler monolit (olay motoru burada)
- `apps/console` React operatör konsolu
- `apps/family-web` Next.js abonelik sitesi
- `packages/contracts` OpenAPI + Kafka şemaları
- `packages/rules` kural paketleri (YAML)
- `packages/messages` mesaj kataloğu
- `packages/simulator` sahte cihaz (signal.schema.json türleri; şarj ve değer sinyalleri dahil)
- `infra` docker-compose, terraform, helm
- `docs` proje dokümanları (00–06) ve TASKS.md

Android (Wear OS + telefon) ve iOS ayrı repo'lardadır: `yanimda-android`, `yanimda-ios`.
