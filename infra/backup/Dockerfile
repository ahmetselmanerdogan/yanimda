# T-083 yedek kabı: pg_dump 16 (sunucu sürümü ≥ istemci olmamalı; RDS PG 16 ile aynı ana sürüm) + aws CLI.
FROM postgres:16.4-alpine3.20
RUN apk add --no-cache aws-cli bash curl coreutils
COPY pg-backup.sh schedule.sh /opt/backup/
RUN chmod 0755 /opt/backup/*.sh
USER postgres
WORKDIR /tmp
CMD ["/opt/backup/schedule.sh"]
