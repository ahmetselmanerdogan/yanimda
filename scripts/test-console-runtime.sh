#!/usr/bin/env bash
# Konsol kabı çalışma zamanı testi (CI "infra" işi; Docker gerekir): infra/console/entrypoint.sh + Caddyfile, konsol
# imajıyla aynı Caddy tabanında (Dockerfile'dan okunur) ve aynı ENTRYPOINT/kullanıcıyla, sahte bir index.html ile
# küçük bir test imajına kurulur (tam Vite derlemesi gerekmez) ve salt okunur kök + cap_drop ALL ile çalıştırılır.
#   - CONSOLE_OIDC_AUTHORITY boş / tırnaklı / satır sonlu / ters bölülü → kap açılmaz (çıkış 64)
#   - geçerli değerler → /config.json geçerli JSON ve değerler aynen; CSP connect-src/frame-src/form-action OIDC
#     kökenini (ve CONSOLE_API_BASE verildiyse https+wss kökenini) içerir; frame-ancestors 'none', X-Frame-Options
#     DENY, nosniff, Referrer-Policy, Permissions-Policy (microphone=(self)) var.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE=$(sed -nE 's/^FROM (caddy:[^ ]+-alpine) AS runtime$/\1/p' "$ROOT/infra/console/Dockerfile")
[ -n "$IMAGE" ] || {
  echo "infra/console/Dockerfile runtime imajı okunamadı"
  exit 1
}
ctx=$(mktemp -d)
name="console-runtime-test-$$"
tag="yanimda-console-runtime-test:$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true; docker rmi -f "$tag" >/dev/null 2>&1 || true; rm -rf "$ctx"' EXIT
cp "$ROOT/infra/console/Caddyfile" "$ROOT/infra/console/entrypoint.sh" "$ctx/"
echo '<!doctype html><title>t</title>' >"$ctx/index.html"
cat >"$ctx/Dockerfile" <<EOF
FROM $IMAGE
ENV XDG_CONFIG_HOME=/tmp/config XDG_DATA_HOME=/tmp/data
COPY Caddyfile /etc/caddy/Caddyfile
COPY --chmod=0755 entrypoint.sh /usr/local/bin/console-entrypoint
COPY --chmod=0644 index.html /srv/index.html
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/console-entrypoint"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
EOF
docker build -q -t "$tag" "$ctx" >/dev/null
failures=0
fail() {
  echo "BAŞARISIZ: $*"
  failures=$((failures + 1))
}

run() { # ortam değişkenleri (-e …); caddy run (imajın CMD'si)
  docker run -d --name "$name" --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
    -p 127.0.0.1::8080 "$@" "$tag" >/dev/null
}

rejects() { # açıklama, -e …: kap 64 ile çıkmalı
  local what="$1" code
  shift
  set +e
  docker run --rm "$@" "$tag" true >/dev/null 2>&1
  code=$?
  set -e
  if [ "$code" = 64 ]; then echo "tamam: reddedildi — $what"; else fail "$what kabul edildi (çıkış $code)"; fi
}

rejects "CONSOLE_OIDC_AUTHORITY yok"
rejects "CONSOLE_OIDC_AUTHORITY boş" -e CONSOLE_OIDC_AUTHORITY=
rejects "tırnak (JSON kaçışı)" -e 'CONSOLE_OIDC_AUTHORITY=https://auth.x.test/realms/o","apiBase":"https://evil.test'
rejects "ters bölü" -e "CONSOLE_OIDC_AUTHORITY=https://auth.x.test/realms/o\\x"
rejects "satır sonu" -e "CONSOLE_OIDC_AUTHORITY=https://auth.x.test/realms/o
https://evil.test"
rejects "CSP enjeksiyonu (; ve boşluk)" -e "CONSOLE_OIDC_AUTHORITY=https://auth.x.test; script-src *"
rejects "javascript: şeması" -e "CONSOLE_OIDC_AUTHORITY=javascript:alert(1)"
rejects "geçersiz istemci kimliği" -e CONSOLE_OIDC_AUTHORITY=https://auth.x.test/realms/o -e 'CONSOLE_OIDC_CLIENT_ID=a"b'
rejects "geçersiz API kökü" -e CONSOLE_OIDC_AUTHORITY=https://auth.x.test/realms/o -e 'CONSOLE_API_BASE=https://a.test/"x'

check() { # API kökü (boş olabilir)
  local api="$1" port hdr cfg
  run -e CONSOLE_OIDC_AUTHORITY=https://auth.ci.test/realms/operations -e CONSOLE_API_BASE="$api"
  port=$(docker port "$name" 8080/tcp | head -n1 | sed 's/.*://')
  for _ in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:$port/" >/dev/null; then break; fi
    sleep 0.5
  done
  hdr=$(curl -sI -H 'Host: console.ci.test' "http://127.0.0.1:$port/") || true
  cfg=$(curl -s "http://127.0.0.1:$port/config.json") || true
  printf '%s\n' "$hdr" | head -n1 | grep -q ' 200' || {
    fail "GET / 200 değil (api=$api): $(printf '%s\n' "$hdr" | head -n1)"
    docker logs "$name" 2>&1 | tail -n 5
    docker exec "$name" ls -la /srv || true
  }
  local csp
  csp=$(printf '%s\n' "$hdr" | tr -d '\r' | sed -n 's/^[Cc]ontent-[Ss]ecurity-[Pp]olicy: //p')
  [ -n "$csp" ] || fail "CSP başlığı yok"
  for want in "default-src 'self'" "script-src 'self'" "frame-ancestors 'none'" "object-src 'none'" \
    "connect-src 'self' wss://console.ci.test https://auth.ci.test" "frame-src https://auth.ci.test;" \
    "form-action 'self' https://auth.ci.test;"; do
    case "$csp" in *"$want"*) ;; *) fail "CSP '$want' içermiyor (api=$api)" ;; esac
  done
  if [ -n "$api" ]; then
    case "$csp" in *"https://api.ci.test wss://api.ci.test"*) ;; *) fail "CSP API kökenini içermiyor" ;; esac
  fi
  case "$csp" in *"{"* | *"}"*) fail "CSP'de çözülmemiş yer tutucu" ;; esac
  for h in 'X-Frame-Options: DENY' 'X-Content-Type-Options: nosniff' 'Referrer-Policy: strict-origin-when-cross-origin' \
    'Permissions-Policy: microphone=(self), camera=()'; do
    printf '%s\n' "$hdr" | tr -d '\r' | grep -qiF "$h" || fail "başlık yok: $h"
  done
  # shellcheck disable=SC2016 # JavaScript şablon dizesi (kabuk genişletmesi değil)
  printf '%s\n' "$cfg" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const c = JSON.parse(s);
      const want = { oidcAuthority: "https://auth.ci.test/realms/operations", oidcClientId: "console", apiBase: process.argv[1] };
      for (const [k, v] of Object.entries(want)) if (c[k] !== v) { console.error(`config.json ${k}`); process.exit(1); }
    });' "$api" || fail "/config.json beklenen değil (api=$api)"
  docker rm -f "$name" >/dev/null
  echo "tamam: başlıklar ve /config.json (CONSOLE_API_BASE='$api')"
}
check ''
check 'https://api.ci.test'

[ "$failures" -eq 0 ] || {
  echo "$failures test başarısız"
  exit 1
}
echo "konsol çalışma zamanı testleri geçti"
