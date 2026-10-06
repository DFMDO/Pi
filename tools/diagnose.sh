#!/usr/bin/env bash
# Diagnose auf dem Gerät (RAM, CPU, Temperatur, WLAN-Qualität, Durchsatz, Testvideo je Profil).
# Aufruf als root auf dem Pi (nur bei Bedarf, z. B. über die Hardware-Abnahme):  tools/diagnose.sh [--testvideo]
# Im Normalbetrieb ist dafür keine Konsole nötig: Admin-Oberfläche → Bildschirme → „Diagnose …“.
set -u
echo "== DFM Diagnose $(date '+%F %T') =="
echo "Modell:      $(tr -d '\0' </proc/device-tree/model 2>/dev/null)"
echo "Version:     $(cat /etc/dfm/version 2>/dev/null)   Betriebsart: $(cat /run/dfm/mode 2>/dev/null)"
free -m | awk 'NR==2{printf "RAM:         %s von %s MB belegt\n",$3,$2}'
echo "Last (1/5/15): $(cut -d' ' -f1-3 /proc/loadavg)"
[ -r /sys/class/thermal/thermal_zone0/temp ] && awk '{printf "Temperatur:  %.1f °C\n",$1/1000}' /sys/class/thermal/thermal_zone0/temp
command -v vcgencmd >/dev/null && vcgencmd get_throttled | sed 's/^/Drosselung:  /'
for p in dfm-hub dfm-agent dfm-setup; do pid=$(systemctl show -p MainPID --value $p.service 2>/dev/null); [ "${pid:-0}" != 0 ] && awk -v n=$p '/VmRSS/{printf "RAM %-10s %.0f MB\n",n,$2/1024}' /proc/$pid/status; done
if command -v iw >/dev/null; then iw dev wlan0 link 2>/dev/null | sed -n 's/^\s*\(signal\|tx bitrate\|rx bitrate\|SSID\).*/WLAN: &/p' | sed 's/WLAN: *\s*/WLAN: /'; echo "WLAN-Energiesparen: $(iw dev wlan0 get power_save 2>/dev/null | awk '{print $NF}')  (Soll: off)"; fi
echo "Zeit synchron: $(chronyc -c tracking 2>/dev/null | awk -F, '{print ($14=="Normal")?"ja":"nein"}')"
if [ -f /data/agent/agent.json ]; then
  URL=$(sed -n 's/.*"hubUrl":"\([^"]*\)".*/\1/p' /data/agent/agent.json); TOK=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' /data/agent/agent.json)
  [ -n "$URL" ] && [ -n "$TOK" ] && curl -sk -H "Authorization: Bearer $TOK" -o /dev/null -w "Durchsatz vom Hub: %{speed_download} Byte/s (Diagnose, ohne Pinning)\n" "$URL/api/v1/device/speedtest"
  if [ "${1:-}" = "--testvideo" ] && [ -n "$URL" ]; then
    curl -sk -H "Authorization: Bearer $TOK" -o /tmp/dfm-test.mp4 "$URL/api/v1/device/testvideo" && \
    mpv --vo=null --ao=null --no-audio --hwdec=auto-safe --length=15 --msg-level=all=no --term-status-msg='Testvideo: ausgelassen ${frame-drop-count}/${decoder-frame-drop-count} von ${estimated-frame-count}' /tmp/dfm-test.mp4 | tail -1
  fi
fi
