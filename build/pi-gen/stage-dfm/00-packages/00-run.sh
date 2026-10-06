#!/bin/bash -e
# Alles entfernen, was ein Signage-Gerät nicht braucht: kleiner (Ziel < 2,5 GB), weniger Angriffsfläche.
on_chroot << 'CHEOF'
set -e
apt-get -y purge --auto-remove triggerhappy ssh openssh-server openssh-sftp-server dphys-swapfile libvips42 2>/dev/null || true
# Entwicklungswerkzeuge und Header (aus pi-gen stage2) – nur exakte Paketnamen, Laufzeitbibliotheken bleiben
PURGE=$(dpkg-query -W -f='${Package}\n' | grep -E '^(build-essential|gcc|g\+\+|cpp|gcc-12|g\+\+-12|cpp-12|gdb|make|dpkg-dev|manpages-dev|linux-headers-.*|linux-libc-dev)$' || true)
[ -z "$PURGE" ] || apt-get -y purge --auto-remove $PURGE || true
# WLAN-/Funk-Firmware für USB-Dongles und andere Chips (der Pi hat Broadcom/Cypress fest eingebaut)
FW=$(dpkg-query -W -f='${Package}\n' | grep -E '^firmware-(atheros|mediatek|libertas|realtek|misc-nonfree|marvell|ti-connectivity|intel.*|iwlwifi|qcom.*|netronome|nvidia.*|amd-graphics|bnx2.*|qlogic)$' || true)
[ -z "$FW" ] || apt-get -y purge $FW || true
apt-get -y install --no-install-recommends wpasupplicant
CHEOF
