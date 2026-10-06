#!/usr/bin/env bash
# Läuft im privilegierten Container: macht aus dem pi-gen-Image das DFM-Layout
#   p1 Boot (FAT) | p2 Root (ext4, schreibgeschützt) | p3 DFMDATA (ext4, wächst beim ersten Start auf die ganze Karte)
set -euo pipefail
IMG=$1; B=$(dirname "$0")
truncate -s +768M "$IMG"
# Dritte Partition anlegen (Rest des Images); Karten-Erweiterung erledigt dfm-data.service beim ersten Start
START=$(parted -ms "$IMG" unit s print | awk -F: '$1=="2"{gsub("s","",$3); print $3+1}')
parted -s "$IMG" -- mkpart primary ext4 "${START}s" 100%
LOOP=$(losetup --find --show --partscan "$IMG"); trap 'umount -R /mnt/p1 /mnt/p2 /mnt/p3 2>/dev/null || true; losetup -d "$LOOP"' EXIT
PTUUID=$(blkid -s PTUUID -o value "$LOOP"); echo "Partitionstabelle $PTUUID"
mkfs.ext4 -q -F -L DFMDATA -m 0 -E lazy_itable_init=1 "${LOOP}p3"
mkdir -p /mnt/p1 /mnt/p2 /mnt/p3; mount "${LOOP}p1" /mnt/p1; mount "${LOOP}p2" /mnt/p2; mount "${LOOP}p3" /mnt/p3
# Datenpartition: Verzeichnisse mit festen Benutzerkennungen (dfm-hub=990, dfm-agent=991)
mkdir -p /mnt/p3/{state/nm,state/nm-lib,state/chrony,journal,hub,agent,tmp}
touch /mnt/p3/state/fake-hwclock; chmod 700 /mnt/p3/state/nm
chown -R 990:990 /mnt/p3/hub; chown -R 991:991 /mnt/p3/agent; chmod 755 /mnt/p3
# Root: fstab (ro) und Boot-Parameter (mit dieser Partitionstabelle)
sed "s/@PTUUID@/$PTUUID/g" "$B/rootfs/etc/fstab" > /mnt/p2/etc/fstab
sed "s/@PTUUID@/$PTUUID/g" "$B/boot/cmdline.txt.in" > /mnt/p1/cmdline.txt
cat "$B/boot/config.txt.add" >> /mnt/p1/config.txt
cp "$B/boot/dfm-setup.vorlage.txt" "$B/boot/LIES-MICH.txt" /mnt/p1/
rm -f /mnt/p1/ssh /mnt/p1/ssh.txt /mnt/p1/userconf* /mnt/p1/custom.toml
node "$B/check-image.js" --rootfs /mnt/p2 --boot /mnt/p1 --data /mnt/p3 --max-gb 2.5 | tee "$(dirname "$IMG")/check.txt"
sync
echo "Layout fertig."
