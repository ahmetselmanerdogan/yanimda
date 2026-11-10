# T-083 operatör konsolu imajı (statik Vite derlemesi). Repo kökünden:
#   docker build -f infra/console/Dockerfile \
#     --build-arg VITE_OIDC_AUTHORITY=https://auth.staging.example/realms/operations \
#     -t yanimda-console:staging .
# VITE_* derleme anında gömülür → ortam başına imaj. VITE_API_BASE boş: aynı köken (/v1; Caddy/Ingress yönlendirir).

FROM node:26-alpine AS build
WORKDIR /repo
RUN npm install -g pnpm@9.12.0
COPY . .
ARG VITE_OIDC_AUTHORITY
ARG VITE_OIDC_CLIENT_ID=console
ARG VITE_API_BASE=
ENV VITE_OIDC_AUTHORITY=$VITE_OIDC_AUTHORITY \
    VITE_OIDC_CLIENT_ID=$VITE_OIDC_CLIENT_ID \
    VITE_API_BASE=$VITE_API_BASE
RUN test -n "$VITE_OIDC_AUTHORITY" || (echo "VITE_OIDC_AUTHORITY gerekli" >&2; exit 1)
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @yanimda/console... build

FROM caddy:2.8.4-alpine AS runtime
# Salt okunur kök dosya sistemiyle çalışabilsin: Caddy durum dizinleri /tmp altında (tmpfs/emptyDir).
ENV XDG_CONFIG_HOME=/tmp/config \
    XDG_DATA_HOME=/tmp/data
COPY infra/console/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/console/dist /srv
USER 65532:65532
EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
