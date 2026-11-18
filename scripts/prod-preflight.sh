#!/usr/bin/env bash
# T-083 üretim/staging ortam dosyaları ön kontrolü (tek VPS compose). Compose `${VAR:?}` yalnız "tanımlı ve boş değil"
# der: şablondaki CHANGE_ME, kısa sır veya başka servisin sırrının yanlış dosyada olması geçer. Bu betik dağıtımdan
# ÖNCE çalışır ve herhangi bir sorunda 1 ile çıkar. DEĞER YAZDIRMAZ: çıktıda yalnız dosya ve anahtar adları.
#
#   scripts/prod-preflight.sh --init         eksik infra/.env.prod* dosyalarını şablondan 0600 kopyalar (var olana dokunmaz)
#   scripts/prod-preflight.sh                infra/ altındaki dosyaları denetler
#   scripts/prod-preflight.sh --dir <dizin>  başka dizindeki aynı adlı dosyaları denetler (CI: scripts/test-prod-preflight.sh)
#
# Denetimler: dosya var + izin 0600/0400; CHANGE_ME / "example" yer tutucusu yok; tırnaksız değerde `$` yok (compose
# env_file değerlerini de çözer); servis başına zorunlu anahtarlar dolu; sır uzunlukları (≥ 32 imza/HMAC/istemci sırrı,
# ≥ 16 parola ve URL parolası); FIELD_ENC_KEYS her anahtar 32 bayt base64; API dosyasında Keycloak/yedek/izleme sırrı ve
# ADMIN_TOKEN yok; dağıtım dosyasında sır yok; paylaşılan istemci sırları (API ↔ Keycloak, sonda ↔ Keycloak) eşit.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/infra"
MODE=check
FILES=(.env.prod .env.prod.api .env.prod.keycloak .env.prod.synthetic .env.prod.backup .env.prod.monitoring)

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
  --dir)
    DIR="${2:?--dir dizin ister}"
    shift 2
    ;;
  --init)
    MODE=init
    shift
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
  esac
done

if [ "$MODE" = init ]; then
  for f in "${FILES[@]}"; do
    if [ -e "$DIR/$f" ]; then
      echo "var (dokunulmadı): $f"
    else
      (umask 077 && cp "$ROOT/infra/$f.example" "$DIR/$f")
      chmod 600 "$DIR/$f"
      echo "oluşturuldu (0600; değerleri sır yöneticisinden doldurun): $f"
    fi
  done
  exit 0
fi

errors=0
warnings=0
err() {
  printf 'HATA   %s: %s\n' "$1" "$2"
  errors=$((errors + 1))
}
warn() {
  printf 'UYARI  %s: %s\n' "$1" "$2"
  warnings=$((warnings + 1))
}

# KEY=VALUE satırları (yorum/boş satır hariç). Değer: son tanım, eşleşen dış tırnaklar soyulur.
keys() { grep -E '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=' "$1" | sed -E 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\2/' || true; }
raw() { grep -E "^[[:space:]]*(export[[:space:]]+)?$2=" "$1" | tail -n1 | sed -E 's/^[^=]*=//' || true; }
get() {
  local v
  v=$(raw "$1" "$2")
  case "$v" in
  \"*\") v=${v#\"} && v=${v%\"} ;;
  \'*\') v=${v#\'} && v=${v%\'} ;;
  esac
  printf '%s' "$v"
}
has() { grep -Eq "^[[:space:]]*(export[[:space:]]+)?$2=" "$1"; }
urlpass() { printf '%s' "$1" | sed -nE 's#^[A-Za-z][A-Za-z0-9+.-]*://[^:/@]*:([^@]*)@.*#\1#p'; }

perm_of() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

require() { # dosya anahtar...
  local f="$1" k
  shift
  for k in "$@"; do
    [ -n "$(get "$DIR/$f" "$k")" ] || err "$f" "$k zorunlu ve boş/eksik"
  done
}
minlen() { # dosya anahtar uzunluk [boşsa-atla]
  local v
  v=$(get "$DIR/$1" "$2")
  if [ -z "$v" ]; then
    [ "${4:-}" = optional ] || err "$1" "$2 zorunlu ve boş/eksik"
    return 0
  fi
  [ "${#v}" -ge "$3" ] || err "$1" "$2 en az $3 karakter olmalı (openssl rand -hex 32)"
}
urlpass_min() { # dosya anahtar uzunluk
  local v p
  v=$(get "$DIR/$1" "$2")
  [ -n "$v" ] || return 0
  p=$(urlpass "$v")
  if [ -z "$p" ]; then
    err "$1" "$2 adresinde parola yok"
  elif [ "${#p}" -lt "$3" ]; then
    err "$1" "$2 adresindeki parola en az $3 karakter olmalı"
  fi
}

# 1) Varlık, izin ve genel değer denetimleri
present=()
for f in "${FILES[@]}"; do
  p="$DIR/$f"
  if [ ! -f "$p" ]; then
    err "$f" "dosya yok (scripts/prod-preflight.sh --init; şablon infra/$f.example)"
    continue
  fi
  present+=("$f")
  perm=$(perm_of "$p")
  if [ $((8#$perm & 8#077)) -ne 0 ]; then
    err "$f" "izin $perm; grup/diğerleri okuyamamalı (chmod 600)"
  fi
  while IFS= read -r k; do
    [ -n "$k" ] || continue
    v=$(raw "$p" "$k")
    case "$v" in
    *CHANGE_ME*) err "$f" "$k yer tutucu (CHANGE_ME) içeriyor" ;;
    esac
    if printf '%s' "$v" | grep -Eq '(^|[^A-Za-z0-9])example([^A-Za-z0-9]|$)'; then
      err "$f" "$k şablondaki örnek değeri (example) taşıyor"
    fi
    case "$v" in
    \'*\') ;;
    *\$*) err "$f" "$k değerinde \`\$\` var (compose çözer → sır bozulur); tek tırnak içine alın veya değiştirin" ;;
    esac
  done < <(keys "$p")
done

isfile() {
  local x
  for x in ${present[@]+"${present[@]}"}; do [ "$x" = "$1" ] && return 0; done
  return 1
}

# 2) Dağıtım dosyası: sır yok, alan adı ve imajlar
if isfile .env.prod; then
  f=.env.prod
  require "$f" ENVIRONMENT DOMAIN ACME_EMAIL API_IMAGE CONSOLE_IMAGE KEYCLOAK_IMAGE INTERNAL_CA_FILE SYNTHETIC_PERSON_IDS
  case "$(get "$DIR/$f" ENVIRONMENT)" in
  staging | production) ;;
  *) err "$f" "ENVIRONMENT staging veya production olmalı" ;;
  esac
  d=$(get "$DIR/$f" DOMAIN)
  if [ -n "$d" ] && ! printf '%s\n' "$d" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'; then
    err "$f" "DOMAIN geçerli bir alan adı değil (küçük harf, nokta, tire)"
  fi
  for k in API_IMAGE CONSOLE_IMAGE; do
    v=$(get "$DIR/$f" "$k")
    case "$v" in
    *@sha256:*) ;;
    "") ;;
    *) warn "$f" "$k digest ile sabitlenmemiş (…@sha256:…; geri dönüş için önerilir)" ;;
    esac
  done
  ca=$(get "$DIR/$f" INTERNAL_CA_FILE)
  [ -z "$ca" ] || [ -f "$ca" ] || warn "$f" "INTERNAL_CA_FILE bu makinede yok (VPS'te olmalı)"
  while IFS= read -r k; do
    case "$k" in
    *PASSWORD* | *SECRET* | *TOKEN* | *_KEY | *_KEY_ID | *_DSN | DATABASE_URL | REDIS_URL | *_DATABASE_URL)
      err "$f" "$k sır gibi görünüyor; dağıtım dosyası sırsızdır → ilgili .env.prod.<servis> dosyasına taşıyın"
      ;;
    esac
  done < <(keys "$DIR/$f")
fi

# 3) API (api, worker, migrate)
if isfile .env.prod.api; then
  f=.env.prod.api
  require "$f" DATABASE_URL REDIS_URL KEYCLOAK_URL OIDC_OPERATIONS_ISSUER OIDC_CONSUMERS_ISSUER OIDC_AUDIENCE \
    PUBLIC_API_URL S3_BUCKET S3_ACCESS_KEY
  [ "$(get "$DIR/$f" NODE_ENV)" = production ] || err "$f" "NODE_ENV production olmalı"
  [ "$(get "$DIR/$f" SIMULATOR_ENABLED)" != true ] || err "$f" "SIMULATOR_ENABLED true olamaz"
  [ "$(get "$DIR/$f" OIDC_REQUIRE_MFA)" = true ] || err "$f" "OIDC_REQUIRE_MFA true olmalı"
  [ "$(get "$DIR/$f" PAYMENT_PROVIDER)" != fake ] || err "$f" "PAYMENT_PROVIDER fake olamaz"
  [ -z "$(get "$DIR/$f" ADMIN_TOKEN)" ] || err "$f" "ADMIN_TOKEN üretimde tanımlanmaz (T-081 G-4; API açılmaz)"
  case "$(get "$DIR/$f" REDIS_URL)" in
  rediss://*) ;;
  "") ;;
  *) err "$f" "REDIS_URL rediss:// (TLS) olmalı" ;;
  esac
  minlen "$f" DEVICE_TOKEN_SECRET 32
  minlen "$f" SIGNUP_TOKEN_SECRET 32
  minlen "$f" BLE_ADDRESS_PEPPER 32
  minlen "$f" S3_SECRET_KEY 16
  minlen "$f" KEYCLOAK_SIGNUP_CLIENT_SECRET 32 optional
  urlpass_min "$f" DATABASE_URL 16
  urlpass_min "$f" REDIS_URL 16
  if [ "$(get "$DIR/$f" CPAAS_PROVIDER)" = twilio ]; then
    require "$f" TWILIO_ACCOUNT_SID
    minlen "$f" TWILIO_AUTH_TOKEN 16
  fi
  fek=$(get "$DIR/$f" FIELD_ENC_KEYS)
  if [ -z "$fek" ]; then
    err "$f" "FIELD_ENC_KEYS zorunlu ve boş/eksik"
  else
    IFS=',' read -r -a entries <<<"$fek"
    for e in "${entries[@]}"; do
      kid=${e%%:*}
      b64=${e#*:}
      if [ "$kid" = "$e" ] || [ -z "$kid" ]; then
        err "$f" "FIELD_ENC_KEYS girdisi <kid>:<base64> biçiminde değil"
        continue
      fi
      n=$(printf '%s' "$b64" | base64 -d 2>/dev/null | wc -c | tr -d ' ' || true)
      [ "$n" = 32 ] || err "$f" "FIELD_ENC_KEYS '$kid' anahtarı 32 bayt base64 değil (openssl rand -base64 32)"
    done
  fi
  dts=$(get "$DIR/$f" DEVICE_TOKEN_SECRETS)
  if [ -n "$dts" ]; then
    IFS=',' read -r -a entries <<<"$dts"
    for e in "${entries[@]}"; do
      s=${e#*:}
      if [ "$s" = "$e" ] || [ "${#s}" -lt 32 ]; then
        err "$f" "DEVICE_TOKEN_SECRETS girdisi <kid>:<≥ 32 karakter> değil"
      fi
    done
  fi
  # Yalnız API sırları: başka servislerin sırları bu kaplara (api/worker/migrate) verilmez.
  while IFS= read -r k; do
    case "$k" in
    KC_* | YANIMDA_* | BACKUP_* | GRAFANA_* | GF_* | AWS_* | PG_EXPORTER_* | REDIS_EXPORTER_* | SYNTHETIC_CLIENT_SECRET | UPTIME_KUMA_PUSH_URL)
      err "$f" "$k başka bir servisin değişkeni; API kabına verilmemeli (ilgili .env.prod.<servis> dosyasına taşıyın)"
      ;;
    esac
  done < <(keys "$DIR/$f")
fi

# 4) Keycloak
if isfile .env.prod.keycloak; then
  f=.env.prod.keycloak
  require "$f" KC_DB_URL KC_DB_USERNAME KC_BOOTSTRAP_ADMIN_USERNAME YANIMDA_KC_SMTP_HOST YANIMDA_KC_SMTP_FROM \
    YANIMDA_KC_SMTP_USER
  minlen "$f" KC_DB_PASSWORD 16
  minlen "$f" KC_BOOTSTRAP_ADMIN_PASSWORD 16
  minlen "$f" YANIMDA_KC_SMTP_PASSWORD 8
  minlen "$f" YANIMDA_SIGNUP_CLIENT_SECRET 32
  minlen "$f" YANIMDA_SYNTHETIC_CLIENT_SECRET 32
  case "$(get "$DIR/$f" KC_DB_URL)" in
  *sslmode=verify-full*) ;;
  "") ;;
  *) err "$f" "KC_DB_URL sslmode=verify-full içermeli (T-081)" ;;
  esac
fi

# 5) Sentetik sonda, yedek, izleme
if isfile .env.prod.synthetic; then
  minlen .env.prod.synthetic SYNTHETIC_CLIENT_SECRET 32
fi
if isfile .env.prod.backup; then
  f=.env.prod.backup
  require "$f" BACKUP_DATABASE_URL BACKUP_S3_BUCKET AWS_ACCESS_KEY_ID
  minlen "$f" AWS_SECRET_ACCESS_KEY 16
  urlpass_min "$f" BACKUP_DATABASE_URL 16
fi
if isfile .env.prod.monitoring; then
  f=.env.prod.monitoring
  require "$f" PG_EXPORTER_DSN REDIS_EXPORTER_ADDR
  minlen "$f" GRAFANA_ADMIN_PASSWORD 16
  urlpass_min "$f" PG_EXPORTER_DSN 16
  [ -z "$(get "$DIR/$f" REDIS_EXPORTER_USER)" ] || minlen "$f" REDIS_EXPORTER_PASSWORD 16
fi

# 6) Paylaşılan istemci sırları (Keycloak realm içe aktarımı ile istemciler aynı değeri görmeli)
same() { # dosya1 anahtar1 dosya2 anahtar2
  isfile "$1" && isfile "$3" || return 0
  local a b
  a=$(get "$DIR/$1" "$2")
  b=$(get "$DIR/$3" "$4")
  [ -n "$a" ] || return 0
  [ "$a" = "$b" ] || err "$1" "$2, $3 içindeki $4 ile aynı olmalı (realm içe aktarımı aynı sırrı kullanır)"
}
same .env.prod.api KEYCLOAK_SIGNUP_CLIENT_SECRET .env.prod.keycloak YANIMDA_SIGNUP_CLIENT_SECRET
same .env.prod.synthetic SYNTHETIC_CLIENT_SECRET .env.prod.keycloak YANIMDA_SYNTHETIC_CLIENT_SECRET
if isfile .env.prod.api && [ -z "$(get "$DIR/.env.prod.api" KEYCLOAK_SIGNUP_CLIENT_SECRET)" ]; then
  warn .env.prod.api "KEYCLOAK_SIGNUP_CLIENT_SECRET boş: üretimde web kaydı kapalı"
fi

echo "ön kontrol: ${errors} hata, ${warnings} uyarı (${DIR})"
[ "$errors" -eq 0 ]
