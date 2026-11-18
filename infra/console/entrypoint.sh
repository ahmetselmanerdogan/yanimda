#!/bin/sh
# Konsol kabı açılışı (infra/console/Dockerfile ENTRYPOINT). Çalışma zamanı yapılandırmasını DOĞRULAR ve CSP
# kökenlerini aynı değerlerden türetir; böylece /config.json ile Content-Security-Policy hiçbir zaman ayrışmaz.
#   CONSOLE_OIDC_AUTHORITY  zorunlu; http(s)://host[:port][/yol]  → connect-src, frame-src, form-action kökeni
#   CONSOLE_OIDC_CLIENT_ID  varsayılan "console"; [A-Za-z0-9._-]
#   CONSOLE_API_BASE        boş (aynı köken /v1) veya http(s)://host[:port][/yol] → connect-src (+ ws/wss)
# Değerler Caddyfile'da /config.json gövdesine ve CSP başlığına yazılır: tırnak, ters bölü, boşluk, satır sonu,
# noktalı virgül veya süslü parantez içeren değer kabı AÇMAZ (JSON / başlık enjeksiyonu yok). Hata kodu 64.
# Sonra verilen komutu çalıştırır (varsayılan: caddy run). CI: ci.yml "infra" işi olumlu/olumsuz denetler.
set -eu

die() {
  echo "konsol yapılandırması: $*" >&2
  exit 64
}

URL_RE='^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$'

# Tek satır ve desene uyuyor mu (grep satır satır eşler; çok satırlı değer reddedilir).
valid() {
  case "$2" in
  *'
'*) return 1 ;;
  esac
  printf '%s\n' "$2" | grep -Eq "$1"
}

origin() { printf '%s\n' "$1" | sed -E 's#^(https?://[^/]+).*#\1#'; }

CONSOLE_OIDC_AUTHORITY="${CONSOLE_OIDC_AUTHORITY:-}"
CONSOLE_OIDC_CLIENT_ID="${CONSOLE_OIDC_CLIENT_ID:-console}"
CONSOLE_API_BASE="${CONSOLE_API_BASE:-}"

[ -n "$CONSOLE_OIDC_AUTHORITY" ] || die "CONSOLE_OIDC_AUTHORITY boş (ör. https://auth.<alan>/realms/operations)"
valid "$URL_RE" "$CONSOLE_OIDC_AUTHORITY" || die "CONSOLE_OIDC_AUTHORITY geçersiz (yalnız http(s)://host[:port][/yol])"
valid '^[A-Za-z0-9._-]{1,64}$' "$CONSOLE_OIDC_CLIENT_ID" || die "CONSOLE_OIDC_CLIENT_ID geçersiz ([A-Za-z0-9._-])"
if [ -n "$CONSOLE_API_BASE" ]; then
  valid "$URL_RE" "$CONSOLE_API_BASE" || die "CONSOLE_API_BASE geçersiz (boş veya http(s)://host[:port][/yol])"
fi

oidc=$(origin "$CONSOLE_OIDC_AUTHORITY")
connect="$oidc"
if [ -n "$CONSOLE_API_BASE" ]; then
  api=$(origin "$CONSOLE_API_BASE")
  # REST + WebSocket (/v1/ws/queue): https → wss, http → ws
  connect="$connect $api $(printf '%s\n' "$api" | sed -E 's#^http#ws#')"
fi

export CONSOLE_OIDC_AUTHORITY CONSOLE_OIDC_CLIENT_ID CONSOLE_API_BASE
export CONSOLE_CSP_OIDC_ORIGIN="$oidc" CONSOLE_CSP_CONNECT="$connect"
exec "$@"
