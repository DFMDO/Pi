#!/usr/bin/env bash
# Prüft Prüfsumme und Signatur eines Images:  build/verify-release.sh dfm-signage-arm64-1.0.0.img.xz [öffentlicher-schluessel.pub]
set -euo pipefail
F=$1; PUB=${2:-$(dirname "$0")/keys/update-key.pub}
(cd "$(dirname "$F")" && sha256sum -c "$(basename "$F").sha256")
base64 -d "$F.sig" > /tmp/dfm-sig.$$; openssl pkeyutl -verify -rawin -pubin -inkey "$PUB" -in "$F" -sigfile /tmp/dfm-sig.$$ && echo "Signatur gültig"; rm -f /tmp/dfm-sig.$$
