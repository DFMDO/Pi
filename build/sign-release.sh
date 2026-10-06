#!/usr/bin/env bash
# Erzeugt eine Ed25519-Signatur (<datei>.sig, Base64) über die Datei. Schlüssel: $DFM_SIGN_KEY
set -euo pipefail
F=$1; : "${DFM_SIGN_KEY:?DFM_SIGN_KEY nicht gesetzt}"
openssl pkeyutl -sign -rawin -inkey "$DFM_SIGN_KEY" -in "$F" | base64 -w0 > "$F.sig"; echo >> "$F.sig"; echo "Signatur: $F.sig"
