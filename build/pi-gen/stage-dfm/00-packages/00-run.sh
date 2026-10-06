#!/bin/bash -e
# Pakete, die wir NICHT wollen (klein halten, Angriffsfläche verringern)
on_chroot << 'CHEOF'
apt-get -y purge --auto-remove triggerhappy ssh openssh-server openssh-sftp-server dphys-swapfile 2>/dev/null || true
apt-get -y install --no-install-recommends wpasupplicant
CHEOF
