#!/usr/bin/env bash
# T-083 günlük mantıksal yedek: pg_dump (custom, sıkıştırılmış) → S3 uyumlu kova (Huawei OBS / MinIO / AWS S3).
# PITR yönetilen RDS'tedir (RPO ≤ 15 dk); bu döküm sağlayıcıdan bağımsız ikinci kopya ve geri yükleme tatbikatının
# girdisidir (restore-drill.sh).
#
# Ortam:
#   BACKUP_DATABASE_URL   postgres://… (salt okunur yedek kullanıcısı; log'a YAZILMAZ)
#   BACKUP_S3_BUCKET      hedef kova
#   BACKUP_S3_PREFIX      anahtar öneki (varsayılan pg)
#   BACKUP_S3_ENDPOINT    S3 uyumlu uç (boş = AWS)
#   BACKUP_RETENTION_DAYS bu günden eski dökümler silinir (0 = silme; kova yaşam döngüsü kuralı da var)
#   PUSHGATEWAY_URL       isteğe bağlı; backup_* metrikleri
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_DEFAULT_REGION
#
# Çıktı: s3://$BUCKET/$PREFIX/YYYY/MM/DD/yanimda-<ts>.dump ve aynı adla .manifest (sha256, boyut, sayımlar).
set -euo pipefail

: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL gerekli}"
: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET gerekli}"
PREFIX="${BACKUP_S3_PREFIX:-pg}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-35}"
WORKDIR="${BACKUP_WORKDIR:-${TMPDIR:-/tmp}}"

log() { printf '%s pg-backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

s3() {
  if [ -n "${BACKUP_S3_ENDPOINT:-}" ]; then
    aws --endpoint-url "$BACKUP_S3_ENDPOINT" s3 "$@"
  else
    aws s3 "$@"
  fi
}

push_metrics() {
  [ -n "${PUSHGATEWAY_URL:-}" ] || return 0
  curl -fsS --max-time 10 --data-binary @- "${PUSHGATEWAY_URL%/}/metrics/job/pg_backup/prefix/${PREFIX//\//_}" ||
    log "uyarı: Pushgateway'e yazılamadı"
}

# Satır sayıları: tatbikatta geri yüklenen veriyle karşılaştırılır (döküm anı öncesi ≤ geri yüklenen ≤ sonrası).
counts() {
  psql "$BACKUP_DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 -F ' ' -c \
    "SELECT (SELECT count(*) FROM event.event), (SELECT count(*) FROM signal.signal), (SELECT count(*) FROM event.transition)"
}

started=$(date +%s)
ts=$(date -u +%Y%m%dT%H%M%SZ)
key="${PREFIX}/$(date -u +%Y/%m/%d)/yanimda-${ts}.dump"
tmp=$(mktemp -d "${WORKDIR%/}/pg-backup.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

read -r before_event before_signal before_transition < <(counts)
log "döküm başlıyor → s3://${BACKUP_S3_BUCKET}/${key}"
pg_dump --format=custom --compress=6 --no-owner --no-privileges --file "$tmp/db.dump" "$BACKUP_DATABASE_URL"
read -r after_event after_signal after_transition < <(counts)

size=$(wc -c <"$tmp/db.dump" | tr -d ' ')
sha=$(sha256sum "$tmp/db.dump" | cut -d' ' -f1)
cat >"$tmp/db.manifest" <<EOF
created_at=${ts}
key=${key}
size_bytes=${size}
sha256=${sha}
pg_dump_version=$(pg_dump --version | awk '{print $NF}')
count_before_event=${before_event}
count_after_event=${after_event}
count_before_signal=${before_signal}
count_after_signal=${after_signal}
count_before_transition=${before_transition}
count_after_transition=${after_transition}
EOF

s3 cp --only-show-errors "$tmp/db.dump" "s3://${BACKUP_S3_BUCKET}/${key}"
s3 cp --only-show-errors "$tmp/db.manifest" "s3://${BACKUP_S3_BUCKET}/${key%.dump}.manifest"
duration=$(($(date +%s) - started))
log "tamam: ${size} bayt, ${duration} sn"

# Saklama: S3 yaşam döngüsü kuralı (Terraform) birincil; bu döngü kuralı olmayan depolar (MinIO vb.) için.
if [ "$RETENTION_DAYS" -gt 0 ]; then
  cutoff=$(date -u -d "@$(($(date +%s) - RETENTION_DAYS * 86400))" +%Y-%m-%d)
  s3 ls --recursive "s3://${BACKUP_S3_BUCKET}/${PREFIX}/" | while read -r d _t _s k; do
    case "$k" in *.dump | *.manifest) ;; *) continue ;; esac
    if [[ "$d" < "$cutoff" ]]; then
      log "eski yedek siliniyor: $k"
      s3 rm --only-show-errors "s3://${BACKUP_S3_BUCKET}/${k}" || log "uyarı: silinemedi (nesne kilidi?): $k"
    fi
  done
fi

push_metrics <<EOF
# TYPE backup_last_success_timestamp_seconds gauge
backup_last_success_timestamp_seconds $(date +%s)
# TYPE backup_size_bytes gauge
backup_size_bytes ${size}
# TYPE backup_duration_seconds gauge
backup_duration_seconds ${duration}
EOF
