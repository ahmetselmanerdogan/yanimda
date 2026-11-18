# T-083 dış ters vekil imajı (docker-compose.prod.yml "caddy"; `up -d --build` VPS'te kurar). Konsol imajıyla
# (infra/console/Dockerfile) AYNI Caddy sürümü ve aynı yöntem: resmi 2.11.9 ikilisindeki golang.org/x/net v0.60.0
# CVE-2026-78661 (HIGH, düzeltme 0.62.0) nedeniyle ikili xcaddy ile güncel bağımlılıkla yeniden derlenir. Caddy yeni
# sürüm çıkarınca --replace kaldırılır (Dependabot docker güncellemesi, /infra/caddy). Haftalık Trivy:
# .github/workflows/image-scan.yml.
FROM caddy:2.11.9-builder-alpine AS build
RUN xcaddy build v2.11.9 --output /usr/bin/caddy --replace golang.org/x/net=golang.org/x/net@v0.62.0

FROM caddy:2.11.9-alpine
COPY --from=build /usr/bin/caddy /usr/bin/caddy
# Resmi imajdaki gibi (libcap tabanda kurulu): kopyalama dosya yetkisini düşürür, yeniden verilir.
RUN setcap cap_net_bind_service=+ep /usr/bin/caddy && caddy version
