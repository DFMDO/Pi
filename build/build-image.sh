#!/usr/bin/env bash
# DFM Signage – SD-Karten-Image bauen (läuft auf dem ENTWICKLUNGSRECHNER, nicht auf dem Pi).
# Voraussetzungen: Linux, Docker (privilegierte Container erlaubt), Node.js >= 22, git, xz, openssl, sha256sum.
# Ergebnis: build/out/dfm-signage-arm64-<version>.img.xz  + .sha256 + .sig (Ed25519, falls Signierschlüssel angegeben)
#
# Aufruf:   build/build-image.sh [--skip-tests] [--pigen-ref <branch|tag|commit>]
# Umgebung: DFM_SIGN_KEY=/pfad/zum/privaten-release-schluessel.pem   (optional; NIE ins Repository legen)
#           DFM_UPDATE_PUBKEY=build/keys/update-key.pub               (öffentlicher Schlüssel, kommt ins Image)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD; WORK=$ROOT/build/work; OUT=$ROOT/build/out
VERSION=$(node -p "require('./package.json').version")
PIGEN_REPO=${PIGEN_REPO:-https://github.com/RPi-Distro/pi-gen}
PIGEN_REF=${PIGEN_REF:-arm64}                    # für reproduzierbare Builds: festen Commit-Hash eintragen
NODE_VERSION=${DFM_NODE_VERSION:-22.22.0}        # aktuelle LTS; Prüfsumme unten MUSS zur Version passen
NODE_SHA256=${DFM_NODE_SHA256:-}                 # sha256 von node-v$NODE_VERSION-linux-arm64.tar.xz (aus SHASUMS256.txt)
UPDATE_PUBKEY=${DFM_UPDATE_PUBKEY:-$ROOT/build/keys/update-key.pub}
SKIP_TESTS=0
while [ $# -gt 0 ]; do case $1 in --skip-tests) SKIP_TESTS=1;; --pigen-ref) PIGEN_REF=$2; shift;; *) echo "Unbekannte Option $1"; exit 2;; esac; shift; done

die() { echo "FEHLER: $*" >&2; exit 1; }
for c in docker git node npm xz openssl sha256sum curl; do command -v $c >/dev/null || die "$c fehlt"; done
[ -f "$UPDATE_PUBKEY" ] || die "Öffentlicher Update-Schlüssel fehlt: $UPDATE_PUBKEY – erzeuge ihn mit build/gen-release-key.sh"
if [ -z "$NODE_SHA256" ]; then
  echo "Hole Node-Prüfsumme von nodejs.org (Bauzeit, nicht Laufzeit) …"
  NODE_SHA256=$(curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | awk "/node-v$NODE_VERSION-linux-arm64.tar.xz/{print \$1}")
  [ -n "$NODE_SHA256" ] || die "Node-Prüfsumme nicht gefunden"
fi
rm -rf "$WORK"; mkdir -p "$WORK" "$OUT"

echo "== 1/7 Tests und Oberfläche bauen =="
npm ci --no-audit --no-fund
[ $SKIP_TESTS = 1 ] || npm test
npm run build:ui

echo "== 2/7 Anwendung für das Image zusammenstellen =="
APP=$WORK/app; mkdir -p "$APP/admin-ui"
cp -a hub shared player setup assets package.json package-lock.json "$APP/"
rm -rf "$APP"/hub/test "$APP"/player/agent/test "$APP"/setup/test "$APP"/shared/*.test.js
cp -a admin-ui/dist "$APP/admin-ui/dist"
# Workspaces: nur die Laufzeit-Pakete (kein admin-ui, keine Entwicklungswerkzeuge)
node -e "const p=require('$APP/package.json');p.workspaces=['hub','player/agent','setup'];delete p.devDependencies;require('fs').writeFileSync('$APP/package.json',JSON.stringify(p,null,2))"
(cd "$APP" && npm install --package-lock-only --omit=dev --no-audit --no-fund >/dev/null)

echo "== 3/7 Boot-Bilder erzeugen =="
node build/make-boot-assets.js "$WORK/assets"

echo "== 4/7 pi-gen holen ($PIGEN_REF) =="
git clone --quiet "$PIGEN_REPO" "$WORK/pi-gen"; git -C "$WORK/pi-gen" checkout --quiet "$PIGEN_REF"
echo "pi-gen Commit: $(git -C "$WORK/pi-gen" rev-parse HEAD)" | tee "$OUT/build-info-$VERSION.txt"
cp -a build/pi-gen/stage-dfm "$WORK/pi-gen/stage-dfm"
touch "$WORK/pi-gen/stage3/SKIP" "$WORK/pi-gen/stage4/SKIP" "$WORK/pi-gen/stage5/SKIP" "$WORK/pi-gen/stage3/SKIP_IMAGES" "$WORK/pi-gen/stage4/SKIP_IMAGES" "$WORK/pi-gen/stage5/SKIP_IMAGES" 2>/dev/null || true
touch "$WORK/pi-gen/stage2/SKIP_NOOBS" 2>/dev/null || true; touch "$WORK/pi-gen/stage-dfm/EXPORT_IMAGE"
sed -e "s/@VERSION@/$VERSION/" -e "s/@RANDOM_PASS@/$(openssl rand -hex 24)/" build/pi-gen/config.template > "$WORK/pi-gen/config"
cat >> "$WORK/pi-gen/config" <<CFG
DFM_VERSION='$VERSION'
DFM_NODE_VERSION='$NODE_VERSION'
DFM_NODE_SHA256='$NODE_SHA256'
CFG
# Verzeichnisse, die die Stage-Skripte lesen (im Container unter /pi-gen)
mkdir -p "$WORK/pi-gen/stage-dfm/files"; cp -a "$APP" "$WORK/pi-gen/stage-dfm/files/app"; cp -a build/rootfs "$WORK/pi-gen/stage-dfm/files/rootfs"
cp -a "$WORK/assets" "$WORK/pi-gen/stage-dfm/files/assets"; cp "$UPDATE_PUBKEY" "$WORK/pi-gen/stage-dfm/files/update-key.pub"
cat >> "$WORK/pi-gen/config" <<CFG
DFM_APP_STAGE=/pi-gen/stage-dfm/files/app
DFM_ROOTFS_OVERLAY=/pi-gen/stage-dfm/files/rootfs
DFM_BOOT_ASSETS=/pi-gen/stage-dfm/files/assets
DFM_UPDATE_PUBKEY=/pi-gen/stage-dfm/files/update-key.pub
CFG

echo "== 5/7 pi-gen (Docker) – das dauert 30–90 Minuten =="
(cd "$WORK/pi-gen" && PRESERVE_CONTAINER=0 CONTINUE=0 ./build-docker.sh)
IMG=$(ls "$WORK"/pi-gen/deploy/*.img | head -1); [ -f "$IMG" ] || die "pi-gen hat kein Image erzeugt"

echo "== 6/7 Partitionen (Boot, Root schreibgeschützt, Daten) und Prüfungen =="
docker run --rm --privileged -v "$ROOT/build:/build:ro" -v "$WORK/pi-gen/deploy:/deploy" debian:bookworm-slim \
  bash -c 'apt-get update -qq && apt-get install -y -qq --no-install-recommends parted e2fsprogs dosfstools util-linux nodejs >/dev/null && bash /build/postprocess.sh /deploy/'"$(basename "$IMG")"
cp "$WORK/pi-gen/deploy/check.txt" "$OUT/check-$VERSION.txt"; cat "$OUT/check-$VERSION.txt"; grep -q 'FEHLGESCHLAGEN' "$OUT/check-$VERSION.txt" && die "Image-Prüfung fehlgeschlagen" || true

echo "== 7/7 Komprimieren, Prüfsumme, Signatur =="
FINAL=$OUT/dfm-signage-arm64-$VERSION.img
mv "$IMG" "$FINAL"; xz -T0 -9 -f "$FINAL"
(cd "$OUT" && sha256sum "dfm-signage-arm64-$VERSION.img.xz" > "dfm-signage-arm64-$VERSION.img.xz.sha256")
if [ -n "${DFM_SIGN_KEY:-}" ]; then build/sign-release.sh "$FINAL.xz"; else echo "HINWEIS: Keine Signatur erzeugt (DFM_SIGN_KEY nicht gesetzt)."; fi
echo "Fertig: $FINAL.xz  ($(du -h "$FINAL.xz" | cut -f1) komprimiert, $(xz -l --robot "$FINAL.xz" | awk '/^totals/{printf "%.2f GB", $5/1e9}') entpackt)"
