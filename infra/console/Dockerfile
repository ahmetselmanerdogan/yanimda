# T-083 operatör konsolu imajı (statik Vite derlemesi). Repo kökünden:
#   docker build -f infra/console/Dockerfile -t yanimda-console:local .
# TEK İMAJ, ortam başına yapılandırma: derlemeye VITE_* gömülmez. Kap açılışında Caddy /config.json'ı ortamdan üretir
# (infra/console/Caddyfile):
#   CONSOLE_OIDC_AUTHORITY=https://auth.<domain>/realms/operations   (zorunlu)
#   CONSOLE_OIDC_CLIENT_ID=console                                   (varsayılan)
#   CONSOLE_API_BASE=                                                (boş: aynı köken /v1; Caddy/Ingress yönlendirir)
# Konsol açılmadan önce /config.json'ı okur (apps/console/src/lib/config.ts). release-image.yml bu imajı GHCR'ye
# iter, cosign ile imzalar (compose CONSOLE_IMAGE, Helm console.image).

FROM node:26-alpine AS build
WORKDIR /repo
RUN npm install -g pnpm@9.12.0
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @yanimda/console... build

FROM caddy:2.11.9-alpine AS runtime
# Salt okunur kök dosya sistemiyle çalışabilsin: Caddy durum dizinleri /tmp altında (tmpfs/emptyDir).
ENV XDG_CONFIG_HOME=/tmp/config \
    XDG_DATA_HOME=/tmp/data
COPY infra/console/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/console/dist /srv
USER 65532:65532
EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
