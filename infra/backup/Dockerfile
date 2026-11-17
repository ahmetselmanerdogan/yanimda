# T-083 yedek kabı: pg_dump 16 (sunucu sürümü ≥ istemci olmamalı; RDS PG 16 ile aynı ana sürüm) + aws CLI.
# restore-drill.sh da kopyalanır: haftalık tatbikat dökümü bu kapla indirir (DRILL_FETCH_DIR; aws CLI burada).
FROM postgres:17.5-alpine3.20
RUN apk add --no-cache aws-cli bash curl coreutils
COPY pg-backup.sh restore-drill.sh schedule.sh /opt/backup/
RUN chmod 0755 /opt/backup/*.sh
USER postgres
WORKDIR /tmp
CMD ["/opt/backup/schedule.sh"]
