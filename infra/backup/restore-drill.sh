#!/usr/bin/env bash
# T-083 haftalık geri yükleme tatbikatı: en son pg_dump'ı geçici bir TimescaleDB kabına geri yükler, sağlamlık
# sorgularını çalıştırır, dökümdeki manifest sayımlarıyla karşılaştırır ve süreyi ölçer.
# Kabul: toplam süre < DRILL_MAX_SEC (varsayılan 3600 sn = 1 saat), aksi halde çıkış kodu 1.
#
# Gerekenler: docker; S3'ten indirmek için aws CLI (veya DRILL_DUMP_FILE ile yerel döküm).
# Ortam:
#   BACKUP_S3_BUCKET, BACKUP_S3_PREFIX, BACKUP_S3_ENDPOINT, AWS_*  (pg-backup.sh ile aynı)
#   DRILL_DUMP_FILE      yerel .dump (S3 atlanır); DRILL_MANIFEST_FILE isteğe bağlı .manifest
#   DRILL_IMAGE          üretimdeki Timescale/PG sürümüyle AYNI olmalı (varsayılan dev compose ile aynı)
#   DRILL_MAX_SEC        süre sınırı (3600)
#   DRILL_JOBS           pg_restore paralelliği (1; Timescale hiper tablolarında paralel geri yükleme önerilmez)
#   PUSHGATEWAY_URL      isteğe bağlı; restore_drill_* metrikleri
#
# Kullanım (VPS, haftalık systemd timer/cron):  infra/backup/restore-drill.sh
set -euo pipefail

DRILL_IMAGE="${DRILL_IMAGE:-timescale/timescaledb:2.17.2-pg16}"
DRILL_MAX_SEC="${DRILL_MAX_SEC:-3600}"
DRILL_JOBS="${DRILL_JOBS:-1}"
PREFIX="${BACKUP_S3_PREFIX:-pg}"
name="yanimda-restore-drill-$$"
started=$(date +%s)

log() { printf '%s restore-drill: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
fail() {
  log "BAŞARISIZ: $*"
  push_metrics 0
  exit 1
}

s3() {
  if [ -n "${BACKUP_S3_ENDPOINT:-}" ]; then
    aws --endpoint-url "$BACKUP_S3_ENDPOINT" s3 "$@"
  else
    aws s3 "$@"
  fi
}

push_metrics() {
  local ok="$1" elapsed=$(($(date +%s) - started))
  [ -n "${PUSHGATEWAY_URL:-}" ] || return 0
  {
    echo "# TYPE restore_drill_success gauge"
    echo "restore_drill_success ${ok}"
    echo "# TYPE restore_drill_duration_seconds gauge"
    echo "restore_drill_duration_seconds ${elapsed}"
    echo "# TYPE restore_drill_last_run_timestamp_seconds gauge"
    echo "restore_drill_last_run_timestamp_seconds $(date +%s)"
  } | curl -fsS --max-time 10 --data-binary @- "${PUSHGATEWAY_URL%/}/metrics/job/restore_drill" ||
    log "uyarı: Pushgateway'e yazılamadı"
}

work=$(mktemp -d "${TMPDIR:-/tmp}/restore-drill.XXXXXX")
cleanup() {
  docker rm -f -v "$name" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

psql_drill() { docker exec -i "$name" psql -h 127.0.0.1 -U postgres -d drill -XAtq -v ON_ERROR_STOP=1 "$@"; }

# 1) Döküm: yerel dosya veya kovadaki en yeni .dump (+ .manifest)
if [ -n "${DRILL_DUMP_FILE:-}" ]; then
  cp "$DRILL_DUMP_FILE" "$work/db.dump"
  [ -z "${DRILL_MANIFEST_FILE:-}" ] || cp "$DRILL_MANIFEST_FILE" "$work/db.manifest"
  log "yerel döküm: $(basename "$DRILL_DUMP_FILE")"
else
  : "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET veya DRILL_DUMP_FILE gerekli}"
  latest=$(s3 ls --recursive "s3://${BACKUP_S3_BUCKET}/${PREFIX}/" | awk '$4 ~ /\.dump$/ {print $1" "$2" "$4}' | sort | tail -n1 | awk '{print $3}')
  [ -n "$latest" ] || fail "kovada döküm bulunamadı (s3://${BACKUP_S3_BUCKET}/${PREFIX}/)"
  log "en yeni döküm: ${latest}"
  s3 cp --only-show-errors "s3://${BACKUP_S3_BUCKET}/${latest}" "$work/db.dump"
  s3 cp --only-show-errors "s3://${BACKUP_S3_BUCKET}/${latest%.dump}.manifest" "$work/db.manifest" ||
    log "uyarı: manifest yok; sayım karşılaştırması atlanır"
fi

manifest() {
  if [ -f "$work/db.manifest" ]; then
    grep -E "^$1=" "$work/db.manifest" | head -n1 | cut -d= -f2- || true
  fi
}

expected_sha=$(manifest sha256)
if [ -n "$expected_sha" ]; then
  actual_sha=$(sha256sum "$work/db.dump" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$work/db.dump" | cut -d' ' -f1)
  [ "$expected_sha" = "$actual_sha" ] || fail "sha256 uyuşmuyor"
fi

# 2) Geçici veritabanı (ağ yok, port yayınlanmaz)
docker run -d --name "$name" --network none -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=drill "$DRILL_IMAGE" >/dev/null
# İlk açılışta imaj geçici bir sunucuyla (yalnız Unix soketi) init betiklerini çalıştırıp yeniden başlar; TCP dinlemesi
# yalnız son açılışta gelir → hazır olmayı 127.0.0.1 üzerinden bekle.
ready=0
for _ in $(seq 1 120); do
  if docker exec "$name" pg_isready -h 127.0.0.1 -U postgres -d drill -q 2>/dev/null; then
    ready=1
    break
  fi
  sleep 2
done
if [ "$ready" != 1 ] || ! psql_drill -c 'SELECT 1' >/dev/null; then
  fail "geçici veritabanı açılmadı"
fi

# 3) Geri yükleme. Uzantılar önce elle kurulur ve listeden çıkarılır (TimescaleDB pre/post restore akışı).
docker cp "$work/db.dump" "$name:/tmp/db.dump"
docker exec "$name" pg_restore -l /tmp/db.dump >"$work/toc.all"
grep -E '^[0-9]+; [0-9]+ [0-9]+ EXTENSION - ' "$work/toc.all" | awk '{print $6}' | sort -u >"$work/extensions" || true
grep -vE ' EXTENSION - | COMMENT - EXTENSION ' "$work/toc.all" >"$work/toc.list"
docker cp "$work/toc.list" "$name:/tmp/toc.list"
while read -r ext; do
  [ -n "$ext" ] || continue
  [[ "$ext" =~ ^[a-z0-9_]+$ ]] || fail "beklenmeyen uzantı adı"
  psql_drill -c "CREATE EXTENSION IF NOT EXISTS \"${ext}\"" >/dev/null
done <"$work/extensions"
has_tsdb=$(psql_drill -c "SELECT count(*) FROM pg_extension WHERE extname = 'timescaledb'")
[ "$has_tsdb" = 0 ] || psql_drill -c 'SELECT timescaledb_pre_restore()' >/dev/null
log "pg_restore başlıyor (uzantılar: $(tr '\n' ' ' <"$work/extensions"))"
docker exec "$name" pg_restore -h 127.0.0.1 -U postgres -d drill --no-owner --no-privileges --exit-on-error \
  --jobs "$DRILL_JOBS" -L /tmp/toc.list /tmp/db.dump || fail "pg_restore hata verdi"
[ "$has_tsdb" = 0 ] || psql_drill -c 'SELECT timescaledb_post_restore()' >/dev/null
psql_drill -c 'ANALYZE' >/dev/null

# 4) Sağlamlık sorguları
read -r n_event n_signal n_transition < <(psql_drill -F ' ' -c \
  "SELECT (SELECT count(*) FROM event.event), (SELECT count(*) FROM signal.signal), (SELECT count(*) FROM event.transition)")
n_migrations=$(psql_drill -c 'SELECT count(*) FROM public.schema_migrations' 2>/dev/null || echo 0)
[ "${n_migrations:-0}" -gt 0 ] || fail "schema_migrations boş veya yok"
n_hyper=0
[ "$has_tsdb" = 0 ] || n_hyper=$(psql_drill -c 'SELECT count(*) FROM timescaledb_information.hypertables')
log "geri yüklenen: event=${n_event} signal=${n_signal} transition=${n_transition} migrations=${n_migrations} hypertable=${n_hyper}"

check_range() {
  local table="$1" got="$2" lo hi
  lo=$(manifest "count_before_${table}")
  hi=$(manifest "count_after_${table}")
  [ -n "$lo" ] && [ -n "$hi" ] || return 0
  # Döküm, iki sayım arasındaki bir anlık görüntüdür: önce ≤ geri yüklenen ≤ sonra (silme yoksa).
  if [ "$got" -lt "$lo" ] || [ "$got" -gt "$hi" ]; then
    fail "${table}: geri yüklenen ${got}, beklenen aralık [${lo}, ${hi}]"
  fi
}
check_range event "$n_event"
check_range signal "$n_signal"
check_range transition "$n_transition"

# 5) Süre
elapsed=$(($(date +%s) - started))
log "toplam süre: ${elapsed} sn (sınır ${DRILL_MAX_SEC} sn)"
[ "$elapsed" -le "$DRILL_MAX_SEC" ] || fail "süre sınırı aşıldı (${elapsed} sn > ${DRILL_MAX_SEC} sn)"
push_metrics 1
log "BAŞARILI"
