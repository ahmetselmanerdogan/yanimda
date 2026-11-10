#!/usr/bin/env bash
# Yedek kabının zamanlayıcısı: her gün BACKUP_AT (UTC, SS:DD) anında pg-backup.sh. Hata kabı düşürmez;
# backup_last_success_timestamp_seconds metriği eskirse uyarı (BackupStale) tetiklenir.
set -euo pipefail

BACKUP_AT="${BACKUP_AT:-03:15}"
[[ "$BACKUP_AT" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || {
  echo "BACKUP_AT SS:DD olmalı" >&2
  exit 2
}

while true; do
  now=$(date -u +%s)
  next=$(date -u -d "$(date -u +%Y-%m-%d) ${BACKUP_AT}:00" +%s)
  [ "$next" -gt "$now" ] || next=$((next + 86400))
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) schedule: sonraki yedek $(date -u -d "@${next}" +%Y-%m-%dT%H:%MZ)" >&2
  sleep $((next - now))
  /opt/backup/pg-backup.sh || echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) schedule: yedek BAŞARISIZ" >&2
done
