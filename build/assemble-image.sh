#!/usr/bin/env bash
# Läuft in einem Container (root) mit den Volumes von pi-gen. Baut aus dem fertigen Root-Dateisystem das SD-Karten-Image –
# OHNE Loop-Geräte, OHNE Einbinden (mount): Dateisysteme werden direkt aus Verzeichnissen erzeugt (mkfs.ext4 -d, mtools).
# Dadurch braucht der Bau keine Partitions-Geräte auf dem Host und ist weniger fehleranfällig.
#   p1 DFMBOOT (FAT32, 128 MB) | p2 DFMROOT (ext4, schreibgeschützt) | p3 DFMDATA (ext4, wächst beim ersten Start)
set -euo pipefail
B=/build; ROOT=${DFM_ROOTFS:-/pi-gen/work/dfm-signage-arm64/stage-dfm/rootfs}; OUT=/out; VERSION=${DFM_VERSION:?}
IMG=$OUT/dfm-signage-arm64-$VERSION.img; TMP=/tmp/dfm-assemble; rm -rf "$TMP"; mkdir -p "$TMP" "$OUT"
[ -d "$ROOT" ] || { echo "Root-Dateisystem nicht gefunden: $ROOT" >&2; exit 1; }
MiB=$((1024 * 1024)); ALIGN=$((8 * MiB))
# zufällige Datenträger-ID (PARTUUID = <id>-01/-02/-03)
PTUUID=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n'); echo "Partitionstabelle 0x$PTUUID"
BOOT=$ROOT/boot/firmware

echo "== Boot- und Systemdateien anpassen =="
sed "s/@PTUUID@/$PTUUID/g" "$B/rootfs/etc/fstab" > "$ROOT/etc/fstab"
sed "s/@PTUUID@/$PTUUID/g" "$B/boot/cmdline.txt.in" > "$BOOT/cmdline.txt"
sed -i '/^# --- DFM Signage ---$/,$d' "$BOOT/config.txt"; cat "$B/boot/config.txt.add" >> "$BOOT/config.txt"
cp "$B/boot/dfm-setup.vorlage.txt" "$B/boot/LIES-MICH.txt" "$BOOT/"
rm -f "$BOOT"/{ssh,ssh.txt,userconf,userconf.txt,custom.toml,dfm-setup.txt,dfm-setup.json}
mkdir -p "$ROOT/data"   # Einhängepunkt

echo "== Prüfung (vor dem Packen) =="
mkdir -p "$TMP/data/state/nm" "$TMP/data/state/nm-lib" "$TMP/data/state/chrony" "$TMP/data/journal" "$TMP/data/hub" "$TMP/data/agent" "$TMP/data/tmp"
: > "$TMP/data/state/fake-hwclock"; chmod 700 "$TMP/data/state/nm"; chown -R 990:990 "$TMP/data/hub"; chown -R 991:991 "$TMP/data/agent"; chmod 755 "$TMP/data"
set +e; node "$B/check-image.mjs" --rootfs "$ROOT" --boot "$BOOT" --data "$TMP/data" --max-gb 2.5 | tee "$OUT/check.txt"; CHECK=${PIPESTATUS[0]}; set -e

echo "== Dateisysteme erzeugen =="
BOOT_SIZE=$((128 * MiB))
truncate -s $BOOT_SIZE "$TMP/boot.img"; mkfs.vfat -F 32 -n DFMBOOT -S 512 "$TMP/boot.img" >/dev/null
mcopy -sQ -i "$TMP/boot.img" "$BOOT"/* ::/ 2>&1 | grep -v "^$" || true
# Root ohne den Inhalt von /boot/firmware (liegt auf p1)
mv "$BOOT" "$TMP/bootsrc"; mkdir -p "$BOOT"
ROOT_USED=$(du -sx --block-size=1 "$ROOT" | cut -f1); ROOT_SIZE=$(( (ROOT_USED * 105 / 100 + 48 * MiB + ALIGN - 1) / ALIGN * ALIGN ))  # Root ist schreibgeschützt: kaum Reserve nötig
truncate -s $ROOT_SIZE "$TMP/root.img"
mkfs.ext4 -q -F -L DFMROOT -O ^64bit,^huge_file -m 1 -d "$ROOT" "$TMP/root.img"
rmdir "$BOOT"; mv "$TMP/bootsrc" "$BOOT"
DATA_SIZE=$((256 * MiB)); truncate -s $DATA_SIZE "$TMP/data.img"; mkfs.ext4 -q -F -L DFMDATA -m 0 -d "$TMP/data" "$TMP/data.img"

echo "== Image zusammensetzen =="
P1=$((ALIGN / 512)); S1=$((BOOT_SIZE / 512)); P2=$((P1 + S1)); S2=$((ROOT_SIZE / 512)); P3=$((P2 + S2)); S3=$((DATA_SIZE / 512))
TOTAL=$(( (P3 + S3) * 512 + MiB )); rm -f "$IMG"; truncate -s $TOTAL "$IMG"
sfdisk -q "$IMG" <<SFD
label: dos
label-id: 0x$PTUUID
unit: sectors
start=$P1, size=$S1, type=c
start=$P2, size=$S2, type=83
start=$P3, size=$S3, type=83
SFD
for spec in "boot:$P1" "root:$P2" "data:$P3"; do f=${spec%%:*}; s=${spec##*:}; dd if="$TMP/$f.img" of="$IMG" bs=$MiB seek=$((s * 512 / MiB)) conv=notrunc status=none; done
sfdisk -d "$IMG" | sed 's/^/  /'; ls -lh "$IMG"; rm -rf "$TMP"
echo "Image fertig: $IMG"; exit $CHECK
