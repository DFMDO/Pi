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
PIGEN_REF=${PIGEN_REF:-bookworm-arm64}                    # für reproduzierbare Builds: festen Commit-Hash eintragen
NODE_VERSION=${DFM_NODE_VERSION:-22.22.0}        # aktuelle LTS; Prüfsumme unten MUSS zur Version passen
NODE_SHA256=${DFM_NODE_SHA256:-}                 # sha256 von node-v$NODE_VERSION-linux-arm64.tar.xz (aus SHASUMS256.txt)
UPDATE_PUBKEY=${DFM_UPDATE_PUBKEY:-$ROOT/build/keys/update-key.pub}
SKIP_TESTS=0; CONTINUE=0
while [ $# -gt 0 ]; do case $1 in --skip-tests) SKIP_TESTS=1;; --continue) CONTINUE=1; SKIP_TESTS=1;; --pigen-ref) PIGEN_REF=$2; shift;; *) echo "Unbekannte Option $1"; exit 2;; esac; shift; done

die() { echo "FEHLER: $*" >&2; exit 1; }
for c in docker git node npm xz openssl sha256sum curl; do command -v $c >/dev/null || die "$c fehlt"; done
[ -f "$UPDATE_PUBKEY" ] || die "Öffentlicher Update-Schlüssel fehlt: $UPDATE_PUBKEY – erzeuge ihn mit build/gen-release-key.sh"
if [ -z "$NODE_SHA256" ]; then
  echo "Hole Node-Prüfsumme von nodejs.org (Bauzeit, nicht Laufzeit) …"
  NODE_SHA256=$(curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | awk "/node-v$NODE_VERSION-linux-arm64.tar.xz/{print \$1}")
  [ -n "$NODE_SHA256" ] || die "Node-Prüfsumme nicht gefunden"
fi
[ $CONTINUE = 1 ] || rm -rf "$WORK"; mkdir -p "$WORK" "$OUT"

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
# Abhängigkeiten für den Pi (linux/arm64) auf dem Entwicklungsrechner installieren: vorgebaute Binärdateien für better-sqlite3, sharp, argon2
(cd "$APP" && npm_config_arch=arm64 npm_config_platform=linux npm_config_target_arch=arm64 npm ci --omit=dev --os=linux --cpu=arm64 --libc=glibc --no-audit --no-fund >/dev/null)
node build/check-native.js "$APP/node_modules" || die "Native Module sind nicht für arm64 gebaut"
echo "Lade Node $NODE_VERSION (arm64) …"
curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-arm64.tar.xz" -o "$WORK/node.tar.xz"
echo "$NODE_SHA256  $WORK/node.tar.xz" | sha256sum -c - >/dev/null || die "Node-Prüfsumme stimmt nicht"

echo "== 3/7 Boot-Bilder erzeugen =="
node build/make-boot-assets.js "$WORK/assets"

echo "== 4/7 pi-gen holen ($PIGEN_REF) =="
if [ $CONTINUE = 1 ] && [ -d "$WORK/pi-gen/.git" ]; then echo "Setze den vorherigen Lauf fort (Stufen 0–2 werden übersprungen)"; rm -rf "$WORK/pi-gen/stage-dfm"; touch "$WORK/pi-gen/stage0/SKIP" "$WORK/pi-gen/stage1/SKIP" "$WORK/pi-gen/stage2/SKIP"
else git clone --quiet "$PIGEN_REPO" "$WORK/pi-gen"; git -C "$WORK/pi-gen" checkout --quiet "$PIGEN_REF"; fi
echo "pi-gen Commit: $(git -C "$WORK/pi-gen" rev-parse HEAD)" | tee "$OUT/build-info-$VERSION.txt"
cp -a build/pi-gen/stage-dfm "$WORK/pi-gen/stage-dfm"
# pi-gen baut nur das Root-Dateisystem; das Image setzen wir selbst zusammen (assemble-image.sh, ohne Loop-Geräte)
rm -f "$WORK/pi-gen/stage2/EXPORT_IMAGE" "$WORK/pi-gen/stage2/EXPORT_NOOBS" "$WORK/pi-gen/stage-dfm/EXPORT_IMAGE"
sed -e "s/@VERSION@/$VERSION/" -e "s/@RANDOM_PASS@/$(openssl rand -hex 24)/" build/pi-gen/config.template > "$WORK/pi-gen/config"
# „export“ ist nötig: pi-gen führt jedes Stage-Skript als eigenen Prozess aus
cat >> "$WORK/pi-gen/config" <<CFG
export DFM_VERSION='$VERSION'
CFG
# Verzeichnisse, die die Stage-Skripte lesen (im Container unter /pi-gen)
mkdir -p "$WORK/pi-gen/stage-dfm/files"; cp -a "$APP" "$WORK/pi-gen/stage-dfm/files/app"; cp -a build/rootfs "$WORK/pi-gen/stage-dfm/files/rootfs"
cp -a "$WORK/assets" "$WORK/pi-gen/stage-dfm/files/assets"; cp "$WORK/node.tar.xz" "$WORK/pi-gen/stage-dfm/files/node.tar.xz"; cp "$UPDATE_PUBKEY" "$WORK/pi-gen/stage-dfm/files/update-key.pub"
cat >> "$WORK/pi-gen/config" <<CFG
export DFM_APP_STAGE=/pi-gen/stage-dfm/files/app
export DFM_NODE_TARBALL=/pi-gen/stage-dfm/files/node.tar.xz
export DFM_ROOTFS_OVERLAY=/pi-gen/stage-dfm/files/rootfs
export DFM_BOOT_ASSETS=/pi-gen/stage-dfm/files/assets
export DFM_UPDATE_PUBKEY=/pi-gen/stage-dfm/files/update-key.pub
CFG

echo "== 5/7 pi-gen (Docker) – das dauert 30–90 Minuten =="
# Container bleibt bei Fehlern erhalten: mit  build/build-image.sh --continue  geht es dort weiter (statt von vorn)
(cd "$WORK/pi-gen" && PRESERVE_CONTAINER=1 CONTAINER_NAME=dfm-pigen CONTINUE=$CONTINUE ./build-docker.sh)

echo "== 6/7 Partitionen (Boot, Root schreibgeschützt, Daten) zusammensetzen und prüfen =="
rm -rf "$WORK/img"; mkdir -p "$WORK/img"
docker run --rm --volumes-from dfm-pigen -v "$ROOT/build:/build:ro" -v "$WORK/img:/out" -e DFM_VERSION="$VERSION" debian:bookworm-slim \
  bash -c 'apt-get update -qq && apt-get install -y -qq --no-install-recommends e2fsprogs dosfstools mtools fdisk xz-utils nodejs >/dev/null && bash /build/assemble-image.sh'
IMG=$WORK/img/dfm-signage-arm64-$VERSION.img; cp "$WORK/img/check.txt" "$OUT/check-$VERSION.txt"
grep -q 'FEHLGESCHLAGEN' "$OUT/check-$VERSION.txt" && die "Image-Prüfung fehlgeschlagen (siehe build/out/check-$VERSION.txt)"

echo "== 7/7 Komprimieren, Prüfsumme, Signatur =="
FINAL=$OUT/dfm-signage-arm64-$VERSION.img
mv "$IMG" "$FINAL"; xz -T0 -6 -f "$FINAL"
(cd "$OUT" && sha256sum "dfm-signage-arm64-$VERSION.img.xz" > "dfm-signage-arm64-$VERSION.img.xz.sha256")
if [ -n "${DFM_SIGN_KEY:-}" ]; then build/sign-release.sh "$FINAL.xz"; else echo "HINWEIS: Keine Signatur erzeugt (DFM_SIGN_KEY nicht gesetzt)."; fi
echo "Fertig: $FINAL.xz  ($(du -h "$FINAL.xz" | cut -f1) komprimiert, $(xz -l --robot "$FINAL.xz" | awk '/^totals/{printf "%.2f GB", $5/1e9}') entpackt)"
