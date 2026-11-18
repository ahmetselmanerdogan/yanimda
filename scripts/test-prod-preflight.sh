#!/usr/bin/env bash
# scripts/prod-preflight.sh testi (CI "infra" işi). Ağsız, geçici dizinde:
#   1) şablonların birebir kopyası → ön kontrol BAŞARISIZ olmalı (CHANGE_ME, example, izin)
#   2) şablondan üretilmiş geçerli set (rastgele sırlar, paylaşılan sırlar eşit, 0600) → BAŞARILI olmalı
#   3) geçerli setin tek tek bozulmuş halleri (kısa sır, eşleşmeyen paylaşılan sır, API dosyasında Keycloak sırrı,
#      `$`, izin 0644, eksik dosya, boş zorunlu, ADMIN_TOKEN, bozuk FIELD_ENC_KEYS) → her biri BAŞARISIZ olmalı
# Her koşuda çıktıda hiçbir üretilmiş sır değeri geçmemeli. compose config de geçerli setle denenir (docker varsa).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFLIGHT="$ROOT/scripts/prod-preflight.sh"
FILES=(.env.prod .env.prod.api .env.prod.keycloak .env.prod.synthetic .env.prod.backup .env.prod.monitoring)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
failures=0

hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
SIGNUP=$(hex 32)
SYNTH=$(hex 32)
FIELD_KEY=$(head -c 32 /dev/urandom | base64 | tr -d '\n')
secrets_file="$tmp/secrets"
printf '%s\n%s\n%s\n' "$SIGNUP" "$SYNTH" "$FIELD_KEY" >"$secrets_file"

# Şablon → geçerli değer: CHANGE_ME* belirteçleri rastgele sırla, örnek alan adları/imajlar test değerleriyle.
generate() {
  local out="$1" f k line
  mkdir -p "$out"
  for f in "${FILES[@]}"; do
    : >"$out/$f"
    while IFS= read -r line || [ -n "$line" ]; do
      k=${line%%=*}
      case "$line" in
      KEYCLOAK_SIGNUP_CLIENT_SECRET=* | YANIMDA_SIGNUP_CLIENT_SECRET=*) line="$k=$SIGNUP" ;;
      SYNTHETIC_CLIENT_SECRET=* | YANIMDA_SYNTHETIC_CLIENT_SECRET=*) line="$k=$SYNTH" ;;
      FIELD_ENC_KEYS=*) line="$k=k1:$FIELD_KEY" ;;
      *CHANGE_ME*)
        local s
        s=$(hex 24)
        echo "$s" >>"$secrets_file"
        line=$(printf '%s\n' "$line" | sed -E "s/CHANGE_ME[A-Za-z0-9_]*/$s/g")
        ;;
      esac
      line=$(printf '%s\n' "$line" | sed -E -e 's#ghcr\.io/example/#ghcr.io/yanimda-ci/#g' \
        -e 's#smtp\.example\.com#smtp.yanimda-ci.net#g' -e 's#yanimda\.example#yanimda-ci.net#g')
      printf '%s\n' "$line" >>"$out/$f"
    done <"$ROOT/infra/$f.example"
    chmod 600 "$out/$f"
  done
}

# Beklenen çıkış kodu + çıktıda sır sızıntısı yok.
expect() {
  local want="$1" name="$2" dir="$3" out code=0
  out=$("$PREFLIGHT" --dir "$dir" 2>&1) || code=$?
  if { [ "$want" = pass ] && [ "$code" -ne 0 ]; } || { [ "$want" = fail ] && [ "$code" -eq 0 ]; }; then
    echo "BAŞARISIZ: $name (beklenen $want, çıkış $code)"
    printf '%s\n' "$out" | sed 's/^/    /'
    failures=$((failures + 1))
  else
    echo "tamam: $name ($want)"
    # Ayrıntı: PREFLIGHT_TEST_VERBOSE=1 (çıktı yine yalnız anahtar adları içerir)
    [ -z "${PREFLIGHT_TEST_VERBOSE:-}" ] || printf '%s\n' "$out" | sed 's/^/    /'
  fi
  if printf '%s\n' "$out" | grep -qFf "$secrets_file"; then
    echo "BAŞARISIZ: $name çıktısında sır değeri var"
    failures=$((failures + 1))
  fi
}

# 1) Şablonlar olduğu gibi
mkdir "$tmp/examples"
for f in "${FILES[@]}"; do cp "$ROOT/infra/$f.example" "$tmp/examples/$f"; done
expect fail "şablonlar (CHANGE_ME / example / izin 0644)" "$tmp/examples"
chmod 600 "$tmp/examples"/.env.prod*
expect fail "şablonlar (izin 0600 olsa da yer tutucular)" "$tmp/examples"

# 2) Geçerli set
generate "$tmp/valid"
expect pass "üretilmiş geçerli set" "$tmp/valid"

# 3) Bozulmalar
mutate() { # ad dosya sed-ifadesi | ad dosya --append satır | ad dosya --chmod mod | ad dosya --rm
  local name="$1" f="$2" d="$tmp/m$RANDOM$RANDOM"
  cp -a "$tmp/valid" "$d"
  case "$3" in
  --append) printf '%s\n' "$4" >>"$d/$f" ;;
  --chmod) chmod "$4" "$d/$f" ;;
  --rm) rm "$d/$f" ;;
  *) sed -i.bak -E "$3" "$d/$f" && rm -f "$d/$f.bak" && chmod 600 "$d/$f" ;;
  esac
  expect fail "$name" "$d"
}
mutate "kısa DEVICE_TOKEN_SECRET" .env.prod.api 's/^DEVICE_TOKEN_SECRET=.*/DEVICE_TOKEN_SECRET=kisa/'
mutate "eşleşmeyen sonda sırrı" .env.prod.synthetic "s/^SYNTHETIC_CLIENT_SECRET=.*/SYNTHETIC_CLIENT_SECRET=$(hex 32)/"
mutate "eşleşmeyen kayıt istemci sırrı" .env.prod.keycloak "s/^YANIMDA_SIGNUP_CLIENT_SECRET=.*/YANIMDA_SIGNUP_CLIENT_SECRET=$(hex 32)/"
mutate "API dosyasında Keycloak sırrı" .env.prod.api --append "KC_BOOTSTRAP_ADMIN_PASSWORD=$(hex 16)"
mutate "API dosyasında yedek sırrı" .env.prod.api --append "AWS_SECRET_ACCESS_KEY=$(hex 16)"
mutate "dağıtım dosyasında sır" .env.prod --append "GRAFANA_ADMIN_PASSWORD=$(hex 16)"
# shellcheck disable=SC2016 # `$x` bilerek düz metin (compose çözümünü tetikleyen değer)
mutate "değerde \$" .env.prod.keycloak 's/^KC_DB_PASSWORD=(.*)/KC_DB_PASSWORD=\1$x/'
mutate "izin 0644" .env.prod.backup --chmod 644
mutate "eksik dosya" .env.prod.monitoring --rm
mutate "boş zorunlu REDIS_URL" .env.prod.api 's/^REDIS_URL=.*/REDIS_URL=/'
mutate "TLS'siz REDIS_URL" .env.prod.api 's#^REDIS_URL=rediss://#REDIS_URL=redis://#'
mutate "ADMIN_TOKEN tanımlı" .env.prod.api --append "ADMIN_TOKEN=$(hex 16)"
mutate "FIELD_ENC_KEYS 16 bayt" .env.prod.api "s#^FIELD_ENC_KEYS=.*#FIELD_ENC_KEYS=k1:$(head -c 16 /dev/urandom | base64 | tr -d '\n')#"
mutate "kısa Keycloak yönetici parolası" .env.prod.keycloak 's/^KC_BOOTSTRAP_ADMIN_PASSWORD=.*/KC_BOOTSTRAP_ADMIN_PASSWORD=admin/'
mutate "kısa DB URL parolası" .env.prod.backup 's#^(BACKUP_DATABASE_URL=postgres://[^:]*:)[^@]*@#\1short@#'
mutate "örnek alan adı" .env.prod 's/^DOMAIN=.*/DOMAIN=staging.yanimda.example/'

# 4) Geçerli setle compose yapılandırması (değişken çözümü + env_file yolları)
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  work="$tmp/compose"
  mkdir -p "$work/monitoring"
  cp "$ROOT/infra/docker-compose.prod.yml" "$work/"
  cp "$ROOT/infra/monitoring/docker-compose.monitoring.yml" "$work/monitoring/"
  cp "$tmp/valid"/.env.prod* "$work/"
  docker compose --env-file "$work/.env.prod" -f "$work/docker-compose.prod.yml" config -q
  docker compose --env-file "$work/.env.prod" -f "$work/docker-compose.prod.yml" --profile family-web config -q
  docker compose --env-file "$work/.env.prod" --env-file "$work/.env.prod.monitoring" \
    -f "$work/monitoring/docker-compose.monitoring.yml" config -q
  # api/worker/migrate yalnız .env.prod.api'yi alır: Keycloak/yedek/izleme sırları API kabının ortamında olmamalı
  api_env=$(docker compose --env-file "$work/.env.prod" -f "$work/docker-compose.prod.yml" config --format json |
    jq -r '[.services.api, .services.worker, .services.migrate][] | .environment | keys[]' | sort -u)
  if printf '%s\n' "$api_env" | grep -E '^(KC_|YANIMDA_|BACKUP_|GRAFANA_|GF_|AWS_|PG_EXPORTER_|REDIS_EXPORTER_|SYNTHETIC_CLIENT_SECRET)'; then
    echo "BAŞARISIZ: api/worker/migrate ortamında başka servisin değişkeni var"
    failures=$((failures + 1))
  else
    echo "tamam: compose config (geçerli set; api/worker/migrate ortamı yalnız API değişkenleri)"
  fi
fi

[ "$failures" -eq 0 ] || {
  echo "$failures test başarısız"
  exit 1
}
echo "prod-preflight testleri geçti"
