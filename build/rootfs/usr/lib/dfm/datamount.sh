#!/bin/sh
# Datenpartition (p3) einbinden, auf die ganze SD-Karte erweitern (online) und Pflichtverzeichnisse anlegen.
# Läuft vor allem anderen (Before=local-fs.target) und ist bei jedem Start idempotent.
set -eu
export TMPDIR=/run   # /tmp ist beim frühen Start evtl. noch nicht eingebunden
DEV=$(blkid -L DFMDATA || true)
[ -n "$DEV" ] || { echo "Datenpartition fehlt" >&2; exit 1; }
mkdir -p /data
mountpoint -q /data || mount -o noatime,commit=30 "$DEV" /data
# Erweitern im laufenden Betrieb (Partition ist die letzte; growpart + resize2fs funktionieren auch eingehängt). Fehler sind nicht fatal.
DISK="/dev/$(lsblk -no pkname "$DEV")"; PART=$(cat "/sys/class/block/$(basename "$DEV")/partition")
growpart "$DISK" "$PART" >/dev/null 2>&1 || true
resize2fs "$DEV" >/dev/null 2>&1 || true
# Verzeichnisse, die per Bind-Mount in das schreibgeschützte System eingeblendet werden (siehe /etc/fstab)
mkdir -p /data/state/nm /data/state/nm-lib /data/state/chrony /data/log /data/hub /data/agent /data/tmp
mkdir -p /data/agent/home/config /data/agent/home/cache
chown 990:990 /data/hub; chown 991:991 /data/agent /data/agent/home /data/agent/home/config /data/agent/home/cache   # nicht rekursiv: Medien-Cache kann groß sein
chmod 700 /data/state/nm; [ -e /data/state/fake-hwclock ] || : > /data/state/fake-hwclock
chmod 755 /data
