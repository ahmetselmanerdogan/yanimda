# T-083 operatör konsolu imajı (statik Vite derlemesi). Repo kökünden:
#   docker build -f infra/console/Dockerfile -t yanimda-console:local .
# TEK İMAJ, ortam başına yapılandırma: derlemeye VITE_* gömülmez. Kap açılışında Caddy /config.json'ı ortamdan üretir
# (infra/console/Caddyfile):
#   CONSOLE_OIDC_AUTHORITY=https://auth.<domain>/realms/operations   (zorunlu)
#   CONSOLE_OIDC_CLIENT_ID=console                                   (varsayılan)
#   CONSOLE_API_BASE=                                                (boş: aynı köken /v1; Caddy/Ingress yönlendirir)
# entrypoint.sh değerleri doğrular (boş/geçersiz → kap açılmaz) ve CSP'yi aynı değerlerden türetir (Caddyfile).
# Konsol açılmadan önce /config.json'ı okur (apps/console/src/lib/config.ts). release-image.yml bu imajı GHCR'ye
# iter, cosign ile imzalar (compose CONSOLE_IMAGE, Helm console.image).

FROM node:26-alpine AS build
WORKDIR /repo
RUN npm install -g pnpm@9.12.0
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @yanimda/console... build

# Caddy ikilisi güncel bağımlılıkla yeniden derlenir: resmi 2.11.9 ikilisindeki golang.org/x/net v0.60.0
# CVE-2026-78661 (HIGH, düzeltme 0.62.0) release-image.yml Trivy kapısını düşürür. Caddy yeni sürüm çıkarınca
# --replace kaldırılır (Dependabot docker güncellemesi).
FROM caddy:2.11.9-builder-alpine AS caddy
# XCADDY_SETCAP=0: builder imajı varsayılan olarak çıktıya cap_net_bind_service=+ep dosya yetkisi koyar; root olmayan
# kullanıcı + cap_drop ALL (compose, Helm) ile exec "operation not permitted" verir. :8080'de yetki gerekmez.
RUN XCADDY_SETCAP=0 xcaddy build v2.11.9 --output /out/caddy --replace golang.org/x/net=golang.org/x/net@v0.62.0

# Sunucu katmanı (statik dosyalar hariç): scripts/test-console-runtime.sh bu hedefi (--target server) kurup gerçek
# ikili, ENTRYPOINT ve kullanıcıyla dener.
FROM caddy:2.11.9-alpine AS server
# Salt okunur kök dosya sistemiyle çalışabilsin: Caddy durum dizinleri /tmp altında (tmpfs/emptyDir).
ENV XDG_CONFIG_HOME=/tmp/config \
    XDG_DATA_HOME=/tmp/data
# Yamalı ikili yeni yola, resmi (yamasız, dosya yetkili) ikili silinir; bağlantı eski yolu çağıranlar için.
COPY --from=caddy /out/caddy /usr/local/bin/caddy
RUN rm -f /usr/bin/caddy && ln -s /usr/local/bin/caddy /usr/bin/caddy && caddy version
COPY infra/console/Caddyfile /etc/caddy/Caddyfile
COPY --chmod=0755 infra/console/entrypoint.sh /usr/local/bin/console-entrypoint
USER 65532:65532
EXPOSE 8080
# Yapılandırma doğrulaması + CSP kökenleri (CONSOLE_OIDC_AUTHORITY boş/geçersiz → kap açılmaz, çıkış 64).
ENTRYPOINT ["/usr/local/bin/console-entrypoint"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

FROM server AS runtime
COPY --from=build /repo/apps/console/dist /srv
