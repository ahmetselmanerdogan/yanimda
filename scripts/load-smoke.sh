#!/usr/bin/env bash
# T-016 k6 duman testi: yerel yığını (Redis + PGlite sunucusu + API) açar, k6'yı koşturur, kapatır.
#   scripts/load-smoke.sh [k6 ek argümanları]     örn: scripts/load-smoke.sh -e DURATION=2m
# Çıktı: test-results/k6-summary.json (CI artefaktı / docs/test-reports için)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/test-results"; mkdir -p "$OUT"
STACK_LOG="$OUT/stack.out"
# Sahte OIDC operatör token'ı: kişi durumu ucu (GET /protected-persons/{id}/status) OIDC ister (T-020).
(cd "$ROOT/apps/api" && STACK_PRINT_TOKEN=1 STACK_TOKEN_TTL=7200 exec node_modules/.bin/tsx test/e2e/stack-cli.ts) \
  > "$STACK_LOG" 2>&1 &
STACK_PID=$!
trap 'kill $STACK_PID 2>/dev/null; wait $STACK_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 120); do grep -q '^Bearer ' "$STACK_LOG" && break; sleep 1; done
API=$(sed -n 's/.*"api":"\([^"]*\)".*/\1/p' "$STACK_LOG")
OP_AUTH=$(grep -m1 '^Bearer ' "$STACK_LOG" || true)
[ -n "$API" ] && [ -n "$OP_AUTH" ] || { grep -v '^Bearer ' "$STACK_LOG"; echo "yığın açılmadı"; exit 1; }
echo "API: $API"
k6 run --no-color -e API_URL="$API" -e OP_AUTH="$OP_AUTH" --summary-export "$OUT/k6-summary.json" "$@" "$ROOT/infra/k6/heartbeat-smoke.js"
