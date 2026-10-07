#!/usr/bin/env bash
# Prüft mit einem ECHTEN Chromium (x86, ohne Emulation), ob die Browser-Richtlinie des Images (build/rootfs/etc/chromium/policies/managed/dfm.json)
# die eigene Anzeige (127.0.0.1:8080 und :8081) durchlässt und alles andere sperrt. Zusätzlich wird die ALTE Schreibweise mit "/*" geprüft.
# Aufruf (Linux): sudo CHROMIUM=/pfad/zu/chrome build/check-policy-chromium.sh     – braucht node.
set -uo pipefail
CHR=${CHROMIUM:?Pfad zu Chromium in CHROMIUM angeben}; HERE=$(cd "$(dirname "$0")" && pwd); POL=$HERE/rootfs/etc/chromium/policies/managed/dfm.json; FAIL=0
DIRS=(/etc/chromium/policies/managed /etc/opt/chrome/policies/managed /etc/opt/chrome_for_testing/policies/managed)
ok() { echo "OK       $*"; }; bad() { echo "FEHLER   $*"; FAIL=1; }
install_policy() { for d in "${DIRS[@]}"; do mkdir -p "$d"; cp "$1" "$d/dfm.json"; done; }
cleanup() { for d in "${DIRS[@]}"; do rm -f "$d/dfm.json"; done; pkill -f check-policy-pages.js 2>/dev/null; }
trap cleanup EXIT
cat > /tmp/check-policy-pages.js <<'EOF'
const http = require('http');
for (const p of [8080, 8081, 9090]) http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end('<html><body>SEITE-GELADEN-' + p + '</body></html>'); }).listen(p, '127.0.0.1');
EOF
node /tmp/check-policy-pages.js & sleep 2
dom() { timeout 120 "$CHR" --headless --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run --user-data-dir="$(mktemp -d)" "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1" --proxy-server=direct:// --virtual-time-budget=5000 --dump-dom "$1" 2>/dev/null; }

# Kontrolle 1: ohne Richtlinie lädt die Seite
for d in "${DIRS[@]}"; do rm -f "$d/dfm.json"; done
dom http://127.0.0.1:9090/ | grep -q SEITE-GELADEN-9090 && ok "Kontrolle: Chromium läuft, ohne Richtlinie lädt die Seite" || { echo "NICHT AUSWERTBAR: Chromium lädt auch ohne Richtlinie keine Seite"; exit 2; }
# Kontrolle 2: Richtlinie wird überhaupt gelesen (alles sperren)
echo '{"URLBlocklist":["*"]}' > /tmp/blockall.json; install_policy /tmp/blockall.json
dom http://127.0.0.1:9090/ | grep -q SEITE-GELADEN-9090 && { echo "NICHT AUSWERTBAR: dieser Chromium liest die Richtlinien-Ordner nicht"; exit 2; } || ok "Kontrolle: Richtlinie wird gelesen (Sperre wirkt)"

# Alte Schreibweise: muss die Anzeige sperren (so entstand 'Diese Seite ist blockiert')
sed 's#"http://127.0.0.1:8080"#"http://127.0.0.1:8080/*"#; s#"http://127.0.0.1:8081"#"http://127.0.0.1:8081/*"#' "$POL" > /tmp/old.json; install_policy /tmp/old.json
dom http://127.0.0.1:8080/player/ | grep -q SEITE-GELADEN-8080 && echo "INFO     alte Schreibweise mit /* sperrt in diesem Chromium NICHT" || echo "INFO     alte Schreibweise mit /* sperrt die Anzeige (wie vermutet)"

# Matrix: welche Schreibweisen der Freigabe lassen 127.0.0.1:8080/player/ durch und sperren 127.0.0.1:9090?
echo "Chromium: $("$CHR" --version 2>/dev/null)"
for pat in '127.0.0.1:8080' 'http://127.0.0.1:8080' 'http://127.0.0.1:8080/' 'http://127.0.0.1:8080/*' 'http://127.0.0.1:8080/player' '127.0.0.1' 'http://127.0.0.1' 'http://127.0.0.1/*' 'http://127.0.0.1:*' '[*.]127.0.0.1'; do
  printf '{"URLBlocklist":["*"],"URLAllowlist":["%s"]}' "$pat" > /tmp/m.json; install_policy /tmp/m.json
  a=gesperrt; dom http://127.0.0.1:8080/player/ | grep -q SEITE-GELADEN-8080 && a=DURCH
  b=gesperrt; dom http://127.0.0.1:9090/ | grep -q SEITE-GELADEN-9090 && b=DURCH
  echo "MATRIX   Freigabe '$pat': 8080/player/ = $a, 9090 = $b"
done
# Experimente: warum greift die Freigabe nicht?
dom2() { timeout 120 "$CHR" --headless --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run --user-data-dir="$(mktemp -d)" --virtual-time-budget=5000 --dump-dom "$1" 2>/dev/null; }
res() { local a=gesperrt b=gesperrt; "$1" http://127.0.0.1:8080/player/ | grep -q SEITE-GELADEN-8080 && a=DURCH; "$1" http://127.0.0.1:9090/ | grep -q SEITE-GELADEN-9090 && b=DURCH; echo "EXPERIMENT $2: 8080 = $a, 9090 = $b"; }
printf '{"URLBlocklist":["*"],"URLAllowlist":["http://127.0.0.1:8080"]}' > /tmp/e.json; install_policy /tmp/e.json; res dom2 'ohne Resolver-/Proxy-Flags, Block * + Allow http://127.0.0.1:8080'
printf '{"URLBlocklist":["http://127.0.0.1:9090"]}' > /tmp/e.json; install_policy /tmp/e.json; res dom 'nur Block 9090 (ohne Allow)'
printf '{"URLBlocklist":["127.0.0.1"],"URLAllowlist":["127.0.0.1:8080"]}' > /tmp/e.json; install_policy /tmp/e.json; res dom 'Block 127.0.0.1, Allow 127.0.0.1:8080'
printf '{"URLBlocklist":["http://*"],"URLAllowlist":["http://127.0.0.1:8080"]}' > /tmp/e.json; install_policy /tmp/e.json; res dom 'Block http://*, Allow http://127.0.0.1:8080'
printf '{"URLBlocklist":["*"],"URLAllowlist":["http://localhost:8080"]}' > /tmp/e.json; install_policy /tmp/e.json
echo "EXPERIMENT localhost: $(timeout 120 "$CHR" --headless --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run --user-data-dir="$(mktemp -d)" --virtual-time-budget=5000 --dump-dom http://localhost:8080/ 2>/dev/null | grep -o 'SEITE-GELADEN-[0-9]*' | head -1)"
printf '{"URLAllowlist":["http://127.0.0.1:8080"]}' > /tmp/e.json; install_policy /tmp/e.json
echo "EXPERIMENT chrome://policy: $(timeout 120 "$CHR" --headless --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run --user-data-dir="$(mktemp -d)" --virtual-time-budget=8000 --dump-dom chrome://policy 2>/dev/null | tr '\n' ' ' | grep -o 'URLAllowlist[^<]*<[^<]*<[^<]*' | head -2)"
# Die Richtlinie aus dem Image
install_policy "$POL"; echo "Richtlinie: $(grep URLAllowlist "$POL")"
dom http://127.0.0.1:8080/player/ | grep -q SEITE-GELADEN-8080 && ok "Player-Seite (127.0.0.1:8080/player/) wird durchgelassen" || bad "Player-Seite wird GESPERRT"
dom http://127.0.0.1:8081/ | grep -q SEITE-GELADEN-8081 && ok "Einrichtungsanzeige (127.0.0.1:8081) wird durchgelassen" || bad "Einrichtungsanzeige wird GESPERRT"
dom http://127.0.0.1:9090/ | grep -q SEITE-GELADEN-9090 && bad "fremder Port 9090 wird NICHT gesperrt" || ok "fremde Ports bleiben gesperrt"
exit $FAIL
