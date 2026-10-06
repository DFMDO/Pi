#!/usr/bin/env bash
# Erzeugt ein Ed25519-Schlüsselpaar für Releases und Updates.
#   privat:  an einem sicheren Ort ablegen (NICHT ins Repository!)  → DFM_SIGN_KEY
#   öffentlich: build/keys/update-key.pub  → kommt ins Image (/etc/dfm/update-key.pub)
set -euo pipefail
OUT=${1:-$HOME/dfm-release-key.pem}
[ -e "$OUT" ] && { echo "$OUT existiert schon – nichts überschrieben."; exit 1; }
umask 077; openssl genpkey -algorithm ed25519 -out "$OUT"
mkdir -p "$(dirname "$0")/keys"; openssl pkey -in "$OUT" -pubout -out "$(dirname "$0")/keys/update-key.pub"
echo "Privater Schlüssel: $OUT   (sicher aufbewahren, nie weitergeben)"; echo "Öffentlicher Schlüssel: build/keys/update-key.pub"
