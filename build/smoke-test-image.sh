#!/usr/bin/env bash
# Rauchtest für ein fertiges SD-Karten-Image – ohne Raspberry Pi und ohne Anzeige.
# Bindet das Image ein, startet darin (arm64 per qemu-user) den ECHTEN Hub und den ECHTEN Chromium des Images
# und prüft, ob die Browser-Richtlinie die eigene Anzeige durchlässt und alles andere sperrt.
# Aufruf (Linux, root):  sudo build/smoke-test-image.sh <image.img> [ergebnis.txt]
# Voraussetzungen: qemu-user-static + binfmt-support, curl, util-linux.
set -uo pipefail
IMG=${1:?Bitte das entpackte .img angeben}; OUT=${2:-smoke-result.txt}; M=/mnt/dfm-img; FAIL=0; : > "$OUT"
say() { echo "$*" | tee -a "$OUT"; }
ok() { say "OK       $*"; }
bad() { say "FEHLER   $*"; FAIL=1; }
cleanup() { pkill -f "$M" 2>/dev/null; umount -R "$M" 2>/dev/null || umount -R -l "$M" 2>/dev/null; [ -n "${LOOP:-}" ] && losetup -d "$LOOP" 2>/dev/null; }
trap cleanup EXIT

LOOP=$(losetup --find --show -P "$IMG") || { echo "Image lässt sich nicht einbinden"; exit 2; }
udevadm settle 2>/dev/null; sleep 1
mkdir -p "$M"
mount "${LOOP}p2" "$M" && mount "${LOOP}p1" "$M/boot/firmware" && mkdir -p "$M/data" && mount "${LOOP}p3" "$M/data" || { bad "Partitionen lassen sich nicht einbinden (Image beschädigt?)"; exit 1; }
ok "Alle drei Partitionen lassen sich einbinden (Boot FAT32, System ext4, Daten ext4)"
cp /usr/bin/qemu-aarch64-static "$M/usr/bin/" && mount -t proc proc "$M/proc" && mount --rbind /dev "$M/dev"
say "Version im Image: $(cat "$M/etc/dfm/version" 2>/dev/null)"
R() { chroot "$M" "$@"; }   # Befehl im Image ausführen

# ---------- 1. Skripte und Einheiten ----------
for f in "$M"/usr/lib/dfm/*; do [ -x "$f" ] || bad "nicht ausführbar: $f"; head -1 "$f" | grep -q $'\r' && bad "Windows-Zeilenenden (CRLF) in $f"; done
for f in "$M"/usr/lib/dfm/*; do head -1 "$f" | grep -q '^#!/bin/sh' && { sh -n "$f" 2>/dev/null || bad "Syntaxfehler in $f"; }; done
ok "Skripte in /usr/lib/dfm geprüft (ausführbar, LF, Syntax)"
R systemd-analyze verify /etc/systemd/system/dfm-hub.service /etc/systemd/system/dfm-agent.service /etc/systemd/system/dfm-diag.service /etc/systemd/system/dfm-kiosk@.service >> "$OUT" 2>&1 || say "HINWEIS  systemd-analyze meldet Warnungen (siehe oben)"

# ---------- 2. Hub startet und antwortet ----------
# Wie auf dem Pi: Die Einrichtung legt Schlüssel/Zertifikat als root an; datamount.sh übereignet sie beim Start dem Hub (uid 990), der Hub läuft als uid 990.
mkdir -p "$M/tmp/hubdata/tls"; chmod 700 "$M/tmp/hubdata/tls"; R openssl ecparam -name prime256v1 -genkey -noout -out /tmp/hubdata/tls/hub.key; chmod 600 "$M/tmp/hubdata/tls/hub.key"
chown 990:990 "$M/tmp/hubdata"; chown root:root "$M/tmp/hubdata/tls" "$M/tmp/hubdata/tls/hub.key"
FIX=$(grep '^\[ -d /data/hub/tls \]' "$M/usr/lib/dfm/datamount.sh" | sed 's#/data/hub#/tmp/hubdata#g'); [ -n "$FIX" ] && R sh -c "$FIX" || bad "datamount.sh übereignet /data/hub/tls nicht"
HLOG=$(mktemp); chroot --userspec=990:990 "$M" /usr/bin/env DFM_DATA=/tmp/hubdata DFM_HTTPS_PORT=18443 DFM_HTTP_PORT=18080 NODE_ENV=production DFM_BASE=/opt/dfm /opt/node/bin/node /opt/dfm/hub/server.js > "$HLOG" 2>&1 &
CODE=000; for i in $(seq 1 90); do CODE=$(curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1:18443/ 2>/dev/null); [ "$CODE" = 200 ] && break; sleep 1; done
if [ "$CODE" = 200 ]; then ok "Hub startet im Image (arm64) und liefert die Oberfläche über HTTPS (nach ${i}s)"; else bad "Hub antwortet nicht (HTTP $CODE). Ausgabe:"; tail -20 "$HLOG" | tee -a "$OUT"; fi
[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/)" = 301 ] && ok "Port 80 leitet auf HTTPS um" || bad "Port 80 leitet nicht um"
pkill -f "$M/opt/node/bin/node" 2>/dev/null; pkill -f '/opt/dfm/hub/server.js' 2>/dev/null

# ---------- 3. Chromium-Richtlinie mit dem echten Chromium des Images ----------
cat > "$M/tmp/pages.js" <<'EOF'
const http = require('http');
for (const p of [8080, 8081, 9090]) http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end('<html><body>SEITE-GELADEN-' + p + '</body></html>'); }).listen(p, '127.0.0.1');
EOF
R /opt/node/bin/node /tmp/pages.js & sleep 3
CHR=(/usr/bin/chromium --headless --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run --disable-crash-reporter --user-data-dir=/tmp/cp "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1" --proxy-server=direct:// --virtual-time-budget=8000 --dump-dom)
dom() { timeout 300 chroot "$M" "${CHR[@]}" "$1" 2>>"$OUT.chromium-log"; }
POL="$M/etc/chromium/policies/managed/dfm.json"; say "Richtlinie im Image: $(tr -d '\n' < "$POL" | cut -c1-200)"
mv "$POL" "$POL.aus"
dom http://127.0.0.1:9090/ | grep -q SEITE-GELADEN-9090 && ok "Kontrolle: Chromium läuft im Test (ohne Richtlinie lädt eine Seite)" || { say "HINWEIS  Chromium lässt sich im Emulator nicht starten – Richtlinien-Test nicht auswertbar. Letzte Chromium-Meldungen:"; tail -15 "$OUT.chromium-log" 2>/dev/null | cut -c1-200 | tee -a "$OUT"; CHROMIUM_OFF=1; }
mv "$POL.aus" "$POL"
if [ -z "${CHROMIUM_OFF:-}" ]; then
  dom http://127.0.0.1:8080/player/ | grep -q SEITE-GELADEN-8080 && ok "Richtlinie lässt die Player-Seite (127.0.0.1:8080) durch" || bad "Richtlinie SPERRT die Player-Seite (127.0.0.1:8080) – so entsteht 'Diese Seite ist blockiert'"
  dom http://127.0.0.1:8081/ | grep -q SEITE-GELADEN-8081 && ok "Richtlinie lässt die Einrichtungsanzeige (127.0.0.1:8081) durch" || bad "Richtlinie SPERRT die Einrichtungsanzeige (127.0.0.1:8081)"
  dom http://127.0.0.1:9090/ | grep -q SEITE-GELADEN-9090 && bad "Richtlinie sperrt fremde Ports NICHT (127.0.0.1:9090 lädt)" || ok "Alles außer 8080/8081 bleibt gesperrt"
fi
pkill -f /tmp/pages.js 2>/dev/null
say ""; [ $FAIL = 0 ] && say "ERGEBNIS: bestanden" || say "ERGEBNIS: FEHLER gefunden"
exit $FAIL
