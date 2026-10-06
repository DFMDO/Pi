#!/usr/bin/env bash
# Signiertes Update-Paket (.dfmpkg) erzeugen:  build/make-update.sh 1.2.3   (Schlüssel: $DFM_SIGN_KEY)
# Paket = tar mit manifest.json, manifest.sig (Ed25519 über manifest.json) und payload.tar (Anwendung ohne node_modules)
set -euo pipefail
cd "$(dirname "$0")/.."; V=${1:?Version, z. B. 1.2.3}; : "${DFM_SIGN_KEY:?}"
W=$(mktemp -d); mkdir -p "$W/app/admin-ui"; npm run build:ui >/dev/null
cp -a hub shared player setup assets package.json "$W/app/"; cp -a admin-ui/dist "$W/app/admin-ui/dist"
rm -rf "$W"/app/hub/test "$W"/app/player/agent/test "$W"/app/setup/test "$W"/app/shared/*.test.js "$W"/app/node_modules
tar -C "$W/app" -cf "$W/payload.tar" .
printf '{"version":"%s","payloadSha256":"%s","created":"%s"}' "$V" "$(sha256sum "$W/payload.tar" | cut -d' ' -f1)" "$(date -u +%FT%TZ)" > "$W/manifest.json"
openssl pkeyutl -sign -rawin -inkey "$DFM_SIGN_KEY" -in "$W/manifest.json" -out "$W/manifest.sig"
mkdir -p build/out; tar -C "$W" -cf "build/out/dfm-signage-update-$V.dfmpkg" manifest.json manifest.sig payload.tar
rm -rf "$W"; echo "build/out/dfm-signage-update-$V.dfmpkg"
