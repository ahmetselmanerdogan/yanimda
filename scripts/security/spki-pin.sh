#!/usr/bin/env bash
# T-081 sertifika sabitleme: SPKI (açık anahtar) pin'i üretir — base64(SHA-256(SubjectPublicKeyInfo DER)).
# Ayrıntı ve rotasyon: docs/security/sertifika-sabitleme.md
#
#   scripts/security/spki-pin.sh <host[:port]> [sni]   Sunucunun gönderdiği zincirdeki her sertifikanın pin'i
#   scripts/security/spki-pin.sh --file <yol>          Yerel PEM/DER sertifika (zincir olabilir), CSR,
#                                                      özel veya açık anahtar (yedek anahtar pin'i için)
#
# Çıktı satırı: `sha256/<base64>` (OkHttp CertificatePinner biçimi). network_security_config.xml ve
# NSPinnedDomains yalnız `<base64>` kısmını ister. Gereken: openssl (OpenSSL 1.1.1+ / 3.x veya LibreSSL).
set -euo pipefail

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

command -v openssl >/dev/null 2>&1 || { echo "openssl bulunamadı" >&2; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/spki-pin.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# stdin: açık anahtar (PEM, SubjectPublicKeyInfo) → pin
pin_of_pubkey() {
  openssl pkey -pubin -outform der 2>/dev/null | openssl dgst -sha256 -binary | openssl base64 -A
}

# $1: tek sertifika (PEM) dosyası → "özne | veren | bitiş" + pin
print_cert() {
  local f="$1" idx="$2" subject issuer end pin
  subject="$(openssl x509 -in "$f" -noout -subject -nameopt RFC2253 | sed 's/^subject=//')"
  issuer="$(openssl x509 -in "$f" -noout -issuer -nameopt RFC2253 | sed 's/^issuer=//')"
  end="$(openssl x509 -in "$f" -noout -enddate | sed 's/^notAfter=//')"
  pin="$(openssl x509 -in "$f" -noout -pubkey | pin_of_pubkey)"
  [ -n "$pin" ] || { echo "[$idx] açık anahtar okunamadı" >&2; return 1; }
  printf '[%s] özne : %s\n    veren: %s\n    bitiş: %s\n    sha256/%s\n' "$idx" "$subject" "$issuer" "$end" "$pin"
}

# $1: bir veya daha çok PEM sertifika içeren dosya → her biri ayrı dosyaya, sonra yazdır
print_chain() {
  local src="$1" n=0 f
  awk -v dir="$TMP" '
    /-----BEGIN CERTIFICATE-----/ { n++; f = sprintf("%s/cert-%03d.pem", dir, n); inside = 1 }
    inside { print > f }
    /-----END CERTIFICATE-----/ { inside = 0; close(f) }
  ' "$src"
  for f in "$TMP"/cert-*.pem; do
    [ -e "$f" ] || { echo "Sertifika bulunamadı" >&2; return 1; }
    print_cert "$f" "$n"
    n=$((n + 1))
  done
}

from_host() {
  local target="$1" sni="${2:-}" host port
  host="${target%:*}"
  port="${target##*:}"
  [ "$host" != "$target" ] || port=443
  [ -n "$sni" ] || sni="$host"
  # </dev/null: el sıkışmadan sonra bağlantıyı kapat. Doğrulama hatası pin hesaplamayı engellemez (bilerek):
  # yalnız zinciri okuyoruz; güven kararı bu betiğin işi değil.
  if ! openssl s_client -connect "$host:$port" -servername "$sni" -showcerts </dev/null >"$TMP/sclient.txt" 2>"$TMP/sclient.err"; then
    grep -q -e '-----BEGIN CERTIFICATE-----' "$TMP/sclient.txt" || { cat "$TMP/sclient.err" >&2; exit 1; }
  fi
  echo "# $host:$port (SNI $sni) — sunucunun gönderdiği zincir; [0] yaprak"
  print_chain "$TMP/sclient.txt"
  echo "# Not: kök CA çoğu zaman zincirde gönderilmez; kök pin'i için kök sertifikayı --file ile verin."
}

from_file() {
  local f="$1" pin
  [ -r "$f" ] || { echo "Okunamıyor: $f" >&2; exit 1; }
  if grep -q -e '-----BEGIN CERTIFICATE-----' "$f" 2>/dev/null; then
    echo "# $f — sertifika(lar)"
    print_chain "$f"
    return
  fi
  if openssl x509 -in "$f" -inform der -noout 2>/dev/null; then
    openssl x509 -in "$f" -inform der -out "$TMP/der.pem"
    echo "# $f — sertifika (DER)"
    print_chain "$TMP/der.pem"
    return
  fi
  if openssl req -in "$f" -noout 2>/dev/null; then
    pin="$(openssl req -in "$f" -noout -pubkey | pin_of_pubkey)"
    echo "# $f — CSR"
  elif openssl pkey -in "$f" -pubout -out "$TMP/pub.pem" -passin pass: 2>/dev/null; then
    pin="$(pin_of_pubkey <"$TMP/pub.pem")"
    echo "# $f — özel anahtar (yalnız açık kısmı kullanıldı)"
  elif openssl pkey -pubin -in "$f" -noout 2>/dev/null; then
    pin="$(pin_of_pubkey <"$f")"
    echo "# $f — açık anahtar"
  else
    echo "Tanınmayan biçim (PEM/DER sertifika, CSR, anahtar beklenir; şifreli özel anahtar için önce açık anahtarı çıkarın): $f" >&2
    exit 1
  fi
  [ -n "$pin" ] || { echo "Pin hesaplanamadı: $f" >&2; exit 1; }
  echo "sha256/$pin"
}

[ $# -ge 1 ] || usage
case "$1" in
  -h | --help) usage ;;
  --file)
    [ $# -eq 2 ] || usage
    from_file "$2"
    ;;
  -*) usage ;;
  *)
    [ $# -le 2 ] || usage
    from_host "$1" "${2:-}"
    ;;
esac
