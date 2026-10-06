#!/bin/sh
# Datenpartition (p3) auf die ganze SD-Karte erweitern und mounten; veränderliche Pfade nach /data umleiten.
# Läuft vor allem anderen (Before=local-fs.target) und ist bei jedem Start idempotent.
set -eu
DEV=$(blkid -L DFMDATA || true)
[ -n "$DEV" ] || { echo "Datenpartition fehlt" >&2; exit 1; }
DISK="/dev/$(lsblk -no pkname "$DEV")"; PART=$(cat "/sys/class/block/$(basename "$DEV")/partition")
# Erweitern (nur wenn noch Platz hinter der Partition ist). Fehler hier sind nicht fatal.
growpart "$DISK" "$PART" >/dev/null 2>&1 || true
resize2fs "$DEV" >/dev/null 2>&1 || true
mkdir -p /data
mountpoint -q /data || mount -o noatime,commit=30 "$DEV" /data
mkdir -p /data/state /data/journal /data/agent /data/hub /data/tmp
chmod 755 /data
