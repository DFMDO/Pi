#!/usr/bin/env bash
# LOKALER Start-Test des Images – ohne Raspberry Pi, ohne GitHub-Bau (Sekunden/Minuten statt 35 Minuten).
# Läuft in WSL2 (Ubuntu) oder auf jedem Linux:   sudo tools/local-image-test.sh <image.img oder image.img.xz> [--fresh]
#
# Was passiert:
#  1. Das Image wird kopiert und eingebunden. Der AKTUELLE Code aus diesem Ordner (build/rootfs, hub, shared, player, setup, assets, admin-ui/dist)
#     wird darübergelegt – so wie der Image-Bau es tut. Ein neuer Image-Bau ist für den Test NICHT nötig.
#  2. Die Einrichtung wird nachgestellt (Rolle "kombi"), inkl. fehlendem CAP_CHOWN wie beim Einrichtungsdienst.
#  3. Das Image-System wird mit systemd gestartet (systemd-nspawn, arm64 per qemu). Hub und Agent laufen mit ihren ECHTEN Dienst-Einheiten
#     (gleiche Sandbox-Regeln, gleiche Benutzer) – so fallen Fehler wie "AF_NETLINK gesperrt" oder "Schlüssel gehört root" hier auf.
#  4. Geprüft wird: antwortet der Hub, läuft der Agent, laufen Dienste in Fehlerschleifen? Danach wird alles wieder abgebaut.
# NICHT getestet werden kann: Anzeige (cage/Chromium), WLAN, GPU, Hardware.
set -uo pipefail
[ "$(id -u)" = 0 ] || { echo "Bitte mit sudo starten."; exit 1; }
REPO=$(cd "$(dirname "$0")/.." && pwd); IN=${1:?Aufruf: sudo tools/local-image-test.sh <image.img|image.img.xz> [--fresh]}; FRESH=${2:-}
W=${DFM_WORK:-/var/tmp/dfm-local-test}; M=$W/root; D=$W/data; IMG=$W/work.img; LOG=$W/console.log; FAIL=0
ok() { echo "OK       $*"; }; bad() { echo "FEHLER   $*"; FAIL=1; }
for c in systemd-nspawn qemu-aarch64-static rsync losetup setpriv curl nsenter; do command -v "$c" >/dev/null || { echo "Es fehlt: $c"; echo "Installieren:  sudo apt-get install -y qemu-user-static binfmt-support systemd-container xz-utils util-linux rsync curl"; exit 1; }; done
LOOP=""; NSP=""
INIT() { pgrep -P "$NSP" 2>/dev/null | head -1; }
IN_CT() { nsenter -t "$(INIT)" -a "$@"; }
cleanup() { [ -n "$NSP" ] && { kill "$NSP" 2>/dev/null; sleep 3; kill -9 "$NSP" 2>/dev/null; }; umount -R "$M" 2>/dev/null || umount -R -l "$M" 2>/dev/null; [ -n "$LOOP" ] && losetup -d "$LOOP" 2>/dev/null; }
trap cleanup EXIT

mkdir -p "$W" "$M"; rm -rf "$D"; mkdir -p "$D"
if [ ! -f "$IMG" ] || [ "$FRESH" = "--fresh" ]; then
  echo "== Image kopieren =="; case "$IN" in *.xz) xz -dkc "$IN" > "$IMG" ;; *) cp "$IN" "$IMG" ;; esac
fi
LOOP=$(losetup -f --show -P "$IMG") || { echo "Image lässt sich nicht einbinden"; exit 2; }; udevadm settle 2>/dev/null; sleep 1
mount "${LOOP}p2" "$M" && mount "${LOOP}p1" "$M/boot/firmware" || { bad "Partitionen lassen sich nicht einbinden"; exit 1; }
cp /usr/bin/qemu-aarch64-static "$M/usr/bin/"

echo "== Aktuellen Code über das Image legen =="
cp -a "$REPO/build/rootfs/." "$M/"
for d in hub shared player setup assets; do rsync -a --exclude node_modules --exclude '*.test.js' --exclude test "$REPO/$d/" "$M/opt/dfm/$d/"; done
[ -d "$REPO/admin-ui/dist" ] && rsync -a "$REPO/admin-ui/dist/" "$M/opt/dfm/admin-ui/dist/" || echo "HINWEIS: admin-ui/dist fehlt (vorher 'npm run build:ui') – es bleibt die Oberfläche aus dem Image"
cp "$REPO/package.json" "$M/opt/dfm/package.json"
# Windows-Zeilenenden (CRLF) entfernen – Skripte und Einheiten würden sonst nicht laufen
find "$M/usr/lib/dfm" "$M/etc/systemd/system" "$M/etc/chromium" "$M/etc/NetworkManager" -type f -exec sed -i 's/\r$//' {} + 2>/dev/null
chmod +x "$M"/usr/lib/dfm/*
echo "Version im Image/Code: $(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$M/opt/dfm/package.json" | head -1)"

echo "== Test-Anpassungen (nur Hardware-Teile, nicht die Dienste) =="
printf 'proc /proc proc defaults 0 0\n' > "$M/etc/fstab"                                # keine SD-Karten-Einbindungen im Container
sed -i '/^DEV=/,/^resize2fs/d' "$M/usr/lib/dfm/datamount.sh"                              # Partition erweitern/einbinden entfällt (/data kommt als Ordner), chown-Zeilen bleiben
for u in NetworkManager avahi-daemon chrony nftables fake-hwclock dfm-zram dfm-netwatch systemd-timesyncd getty@tty1; do ln -sf /dev/null "$M/etc/systemd/system/$u.service"; done
mkdir -p "$M/etc/systemd/system/dfm-agent.service.d"
printf '[Service]\nPAMName=\nTTYPath=\nStandardInput=null\nUtmpIdentifier=\nEnvironment=DFM_NO_RENDERER=1\n' > "$M/etc/systemd/system/dfm-agent.service.d/test.conf"   # kein Bildschirm im Container

echo "== Einrichtung nachstellen (Rolle kombi, ohne CAP_CHOWN) =="
mkdir -p "$D/state" "$D/log" "$D/hub" "$D/agent" "$D/tmp"; mount --bind "$D" "$M/data"
cp "$REPO/tools/local-test-setup.mjs" "$M/tmp/local-test-setup.mjs"
chroot "$M" setpriv --bounding-set=-chown --inh-caps=-chown /opt/node/bin/node /tmp/local-test-setup.mjs || { bad "Einrichtung ließ sich nicht nachstellen"; exit 1; }
umount "$M/data"
echo "Besitzer direkt nach der Einrichtung: $(stat -c '%U:%G' "$D/hub/tls" "$D/hub/hub-bootstrap.json" 2>/dev/null | tr '\n' ' ')"

echo "== System starten (kann unter Emulation 2-4 Minuten dauern) =="
systemd-nspawn -q -D "$M" --register=no --bind="$D:/data" --capability=all --hostname=dfm-signage --boot > "$LOG" 2>&1 &
NSP=$!
CODE=000; for i in $(seq 1 240); do kill -0 "$NSP" 2>/dev/null || { bad "Container beendet sich (siehe $LOG)"; tail -20 "$LOG"; exit 1; }; CODE=$(curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1:443/ 2>/dev/null); [ "$CODE" = 200 ] && break; sleep 1; done
[ "$CODE" = 200 ] && ok "Hub antwortet über HTTPS (nach ${i}s)" || bad "Hub antwortet nicht (HTTP $CODE) nach ${i}s"
sleep 20
echo "== Dienste =="
for u in dfm-mode dfm-firstboot dfm-hub dfm-agent; do st=$(IN_CT systemctl is-active "$u.service" 2>&1); n=$(IN_CT systemctl show "$u.service" -p NRestarts --value 2>/dev/null); [ "$st" = active ] && ok "$u.service läuft (Neustarts: ${n:-0})" || bad "$u.service: $st (Neustarts: ${n:-0})"; done
[ "$(IN_CT systemctl show dfm-hub.service -p NRestarts --value 2>/dev/null)" -gt 1 ] 2>/dev/null && bad "Hub startet in einer Schleife neu"
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/plan.json 2>/dev/null | grep -q 200 && ok "Agent liefert seine Seite (127.0.0.1:8080)" || bad "Agent antwortet auf 127.0.0.1:8080 nicht"
echo "Besitzer jetzt: $(stat -c '%U:%G' "$D/hub/tls" 2>/dev/null)  (erwartet: 990:990 bzw. numerisch)"
echo "== Letzte Meldungen von Hub und Agent =="; IN_CT journalctl -u dfm-hub -u dfm-agent -n 30 --no-pager 2>&1 | cut -c1-200
IN_CT /usr/lib/dfm/diagnose >/dev/null 2>&1; [ -f "$M/boot/firmware/dfm-diagnose.txt" ] && cp "$M/boot/firmware/dfm-diagnose.txt" "$W/dfm-diagnose.txt" && echo "Diagnosedatei: $W/dfm-diagnose.txt"
echo; [ $FAIL = 0 ] && echo "ERGEBNIS: bestanden" || echo "ERGEBNIS: FEHLER gefunden"
exit $FAIL
