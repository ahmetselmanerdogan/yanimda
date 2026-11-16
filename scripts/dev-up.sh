#!/usr/bin/env bash
# T-008 yerel geliştirme: altyapıyı açar, migration + demo veriyi yükler.
#   scripts/dev-up.sh            Docker: infra/docker-compose.yml (Postgres+Timescale, Redis, Redpanda, Keycloak realm
#                                içe aktarımı, MinIO, Mailhog) → db:seed. Sonra `pnpm dev`.
#   scripts/dev-up.sh --smoke    Docker'sız kabul denetimi (CI): yerel yığın (Redis + PGlite + API, sahte OIDC) →
#                                simülatör `fall --person pp_demo --no-cancel` → `GET /v1/queue` olayı göstermeli.
# --smoke redis-server ister; kural süreleri DEV_UP_TIME_SCALE ile ölçeklenir (varsayılan 0.05: 60 sn → 3 sn).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PNPM="${PNPM:-pnpm}"

if [ "${1:-}" != "--smoke" ]; then
  docker compose -f "$ROOT/infra/docker-compose.yml" up -d --wait
  (cd "$ROOT" && "$PNPM" --filter @yanimda/api db:seed)
  cat <<'EOF'

Altyapı hazır. Sıradaki adımlar:
  pnpm dev                                                             # api :3000, konsol :5173
  pnpm --filter @yanimda/simulator start -- fall --person pp_demo --no-cancel
Keycloak geliştirme kullanıcıları: infra/keycloak/dev-users.mjs (parola ortam değişkeninden, koda yazılmaz).
EOF
  exit 0
fi

OUT="$ROOT/test-results"; mkdir -p "$OUT"
LOG="$OUT/dev-up-smoke.out"
(cd "$ROOT/apps/api" && STACK_PRINT_TOKEN=1 STACK_TOKEN_TTL=600 STACK_TIME_SCALE="${DEV_UP_TIME_SCALE:-0.05}" \
  exec node_modules/.bin/tsx test/e2e/stack-cli.ts) > "$LOG" 2>&1 &
STACK_PID=$!
trap 'kill $STACK_PID 2>/dev/null; wait $STACK_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 120); do grep -q '^Bearer ' "$LOG" && break; sleep 1; done
API=$(sed -n 's/.*"api":"\([^"]*\)".*/\1/p' "$LOG")
AUTH=$(grep -m1 '^Bearer ' "$LOG" || true)
[ -n "$API" ] && [ -n "$AUTH" ] || { grep -v '^Bearer ' "$LOG"; echo "yerel yığın açılmadı"; exit 1; }

(cd "$ROOT/packages/simulator" && API_URL="$API" node src/index.mjs fall --person pp_demo --no-cancel)
for _ in $(seq 1 30); do
  if curl -fsS -H "authorization: $AUTH" "$API/queue" | grep -q '"type":"FALL"'; then
    echo "T-008 duman: FALL kuyrukta (GET /v1/queue)"
    exit 0
  fi
  sleep 1
done
echo "T-008 duman: FALL 30 sn içinde kuyruğa düşmedi"
curl -sS -H "authorization: $AUTH" "$API/queue" || true
exit 1
