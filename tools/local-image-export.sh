#!/usr/bin/env bash
# LOKALER Schnellbau eines flashbaren Images (ohne GitHub-Bau): Nimmt ein fertiges Basis-Image (.img) und legt den AKTUELLEN Code
# und die Systemdateien darüber – wie der Image-Bau es tut. Dauer: wenige Minuten statt 35.
#   sudo tools/local-image-export.sh <basis.img> <ausgabe.img>
# GRENZEN: Gilt für Code (hub, player, setup, shared, assets, admin-ui/dist), Systemdateien (build/rootfs), Dienste (enable/mask) und config.txt.
#          NICHT für neue Pakete, geänderte Partitionsgrößen oder cmdline.txt – dafür bleibt der Bau auf GitHub nötig.
# Dateirechte: Die Dateien kommen vom Windows-Laufwerk (dort wirken alle als 777). Deshalb setzt der Bau Ordner 755 / Dateien 644 und Besitzer root; ausführbar wird nur /usr/lib/dfm/*.
set -uo pipefail
[ "$(id -u)" = 0 ] || { echo "Bitte als root starten (sudo)."; exit 1; }
REPO=${DFM_REPO:-$(cd "$(dirname "$0")/.." && pwd)}; BASE=${1:?Aufruf: sudo tools/local-image-export.sh <basis.img> <ausgabe.img>}; OUT=${2:?Ausgabedatei fehlt}
W=${DFM_WORK:-/var/tmp/dfm-local-export}; M=$W/root; IMG=$W/export.img; LOOP=""
for c in losetup rsync qemu-aarch64-static chroot; do command -v "$c" >/dev/null || { echo "Es fehlt: $c (sudo apt-get install -y qemu-user-static binfmt-support rsync)"; exit 1; }; done
cleanup() { umount -R "$M" 2>/dev/null || umount -R -l "$M" 2>/dev/null; [ -n "$LOOP" ] && losetup -d "$LOOP" 2>/dev/null; }
trap cleanup EXIT
mkdir -p "$W" "$M"
echo "== Basis-Image kopieren =="; cp "$BASE" "$IMG" || exit 1
LOOP=$(losetup -f --show -P "$IMG") || exit 2; udevadm settle 2>/dev/null; sleep 1
mount "${LOOP}p2" "$M" && mount "${LOOP}p1" "$M/boot/firmware" || { echo "FEHLER: Partitionen lassen sich nicht einbinden"; exit 1; }
cp /usr/bin/qemu-aarch64-static "$M/usr/bin/"
VERSION=$(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$REPO/package.json" | head -1)
echo "== Code und Systemdateien (Version $VERSION) darüberlegen =="
rsync -a --chmod=D755,F644 --chown=0:0 --exclude=/etc/fstab "$REPO/build/rootfs/" "$M/"                       # fstab nicht überschreiben: im fertigen Image stehen dort die echten Partitions-IDs
for d in hub shared player setup assets; do rsync -a --chmod=D755,F644 --chown=0:0 --exclude node_modules --exclude '*.test.js' --exclude test "$REPO/$d/" "$M/opt/dfm/$d/"; done
[ -d "$REPO/admin-ui/dist" ] && rsync -a --chmod=D755,F644 --chown=0:0 --delete "$REPO/admin-ui/dist/" "$M/opt/dfm/admin-ui/dist/" || echo "HINWEIS: admin-ui/dist fehlt (vorher 'npm run build:ui')"
cp "$REPO/package.json" "$M/opt/dfm/package.json"; echo "$VERSION" > "$M/etc/dfm/version"
# Fester Update-Schlüssel (öffentlicher Teil, aus build/keys, wird von build/gen-release-key.sh angelegt): Damit nimmt auch das lokale Image Updates an, die mit dem festen Schlüssel signiert sind.
if [ -f "$REPO/build/keys/update-key.pub" ]; then install -m 644 -o 0 -g 0 "$REPO/build/keys/update-key.pub" "$M/etc/dfm/update-key.pub"; echo "Update-Schlüssel aus build/keys übernommen"; else echo "HINWEIS: build/keys/update-key.pub fehlt – das Image behält den Update-Schlüssel des Basis-Images"; fi
find "$M/usr/lib/dfm" "$M/etc/systemd/system" "$M/etc/chromium" "$M/etc/NetworkManager" "$M/etc/udev/rules.d" -type f -exec sed -i 's/\r$//' {} + 2>/dev/null
chmod +x "$M"/usr/lib/dfm/*
[ -f "$M/boot/firmware/config.txt" ] && { sed -i '/^# --- DFM Signage ---$/,$d' "$M/boot/firmware/config.txt"; sed 's/\r$//' "$REPO/build/boot/config.txt.add" >> "$M/boot/firmware/config.txt"; }
mkdir -p "$M/media/usb"   # Einhängepunkt für USB-Sticks
rm -f "$M/etc/resolv.conf"; ln -s /run/NetworkManager/resolv.conf "$M/etc/resolv.conf"   # DNS aus dem Netz (sonst steht dort die resolv.conf des Baurechners)
echo "== Dienste aktivieren (wie im Image-Skript) =="
grep -E '^systemctl (enable|disable|mask) ' "$REPO/build/pi-gen/stage-dfm/02-system/00-run.sh" | sed 's/\r$//' > "$M/tmp/dfm-units.sh"
chroot "$M" /bin/bash /tmp/dfm-units.sh > "$W/units.log" 2>&1 || echo "HINWEIS: Einige systemctl-Aufrufe meldeten Warnungen (siehe $W/units.log)"; rm -f "$M/tmp/dfm-units.sh"
chroot "$M" /bin/bash -c '[ -e /etc/fake-hwclock.data ] || date -u "+%Y-%m-%d %H:%M:%S" > /etc/fake-hwclock.data; grep -q "/run/dfm/chrony.d" /etc/chrony/chrony.conf || echo "confdir /run/dfm/chrony.d" >> /etc/chrony/chrony.conf; [ -L /etc/avahi/services ] && rm -f /etc/avahi/services; mkdir -p /etc/avahi/services'
FREE=$(df --output=avail -BM "$M" | tail -1 | tr -dc 0-9); echo "Freier Platz im System: ${FREE} MB"
[ "${FREE:-0}" -ge 5 ] || { echo "FEHLER: Das System ist voll (zu wenig Platz für die neuen Dateien)."; exit 1; }
rm -f "$M/usr/bin/qemu-aarch64-static"
sync; umount -R "$M"; losetup -d "$LOOP"; LOOP=""
mkdir -p "$(dirname "$OUT")"; cp "$IMG" "$OUT" && echo "FERTIG: $OUT ($(du -h "$OUT" | cut -f1)) – mit dem Raspberry Pi Imager („Eigenes Image verwenden“) auf die SD-Karte schreiben."
