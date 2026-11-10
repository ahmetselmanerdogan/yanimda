#!/usr/bin/env bash
# T-080 yük testi: 2.000 cihaz heartbeat, olay dağılımı, 20 operatör (WS + üstlen/kapat), varsayılan 30 dk.
#   scripts/load-v1.sh                         PGlite ile (Docker'sız; hızlı tekrar)
#   LOAD_TIMESCALE=1 scripts/load-v1.sh        Docker'da gerçek TimescaleDB (infra/init.sql) ile
#   LOAD_DURATION=2m scripts/load-v1.sh        kısa koşu
#   scripts/load-v1.sh --quiet                 ek argümanlar k6'ya geçer
# Ortam: LOAD_DURATION, LOAD_OPERATORS, LOAD_DEVICES, LOAD_HEARTBEAT_EVERY, LOAD_EVENTS_PER_MIN, LOAD_POOL_MAX,
#        LOAD_DATABASE_URL (hazır Postgres), LOAD_OUT (rapor JSON; varsayılan test-results/load-v1.json)
# k6 PATH'te yoksa Docker imajı (grafana/k6) kullanılır. Rapor: docs/test-reports/yuk-kaos-v1.md
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_CONTAINER=yanimda-load-pg

cleanup() {
  if [ "${LOAD_TIMESCALE:-}" = 1 ] && [ -z "${LOAD_KEEP_DB:-}" ]; then
    docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [ "${LOAD_TIMESCALE:-}" = 1 ]; then
  PG_PORT="${LOAD_PG_PORT:-55432}"
  PG_PASSWORD="$(openssl rand -hex 12)"
  docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$PG_CONTAINER" -p "127.0.0.1:${PG_PORT}:5432" \
    -e POSTGRES_USER=yanimda -e "POSTGRES_PASSWORD=${PG_PASSWORD}" -e POSTGRES_DB=yanimda \
    timescale/timescaledb:2.17.2-pg16 >/dev/null
  # resmi imaj initdb'den sonra sunucuyu bir kez yeniden başlatır: "init process complete" sonrası hazır olmayı bekle
  for _ in $(seq 1 120); do
    docker logs "$PG_CONTAINER" 2>&1 | grep -q 'PostgreSQL init process complete' && break
    sleep 1
  done
  for _ in $(seq 1 60); do
    docker exec "$PG_CONTAINER" psql -U yanimda -d yanimda -qtAc 'SELECT 1' >/dev/null 2>&1 && break
    sleep 1
  done
  docker exec -i "$PG_CONTAINER" psql -q -v ON_ERROR_STOP=1 -U yanimda -d yanimda <"$ROOT/infra/init.sql"
  export LOAD_DATABASE_URL="postgres://yanimda:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/yanimda"
fi

cd "$ROOT/apps/api"
node_modules/.bin/tsx test/e2e/load-cli.ts "$@"
