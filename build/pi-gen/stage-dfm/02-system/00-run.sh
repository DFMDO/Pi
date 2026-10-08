#!/bin/bash -e
# System zusammenbauen: Dateien, Benutzer, Dienste, Härtung, „keine Geheimnisse im Image“.
cp -a "${DFM_ROOTFS_OVERLAY}/." "${ROOTFS_DIR}/"
install -d "${ROOTFS_DIR}/usr/share/dfm" "${ROOTFS_DIR}/etc/dfm" "${ROOTFS_DIR}/usr/share/plymouth/themes/dfm"
cp "${DFM_BOOT_ASSETS}/schwarz.png" "${DFM_BOOT_ASSETS}/standby.png" "${DFM_BOOT_ASSETS}/wartet.png" "${DFM_BOOT_ASSETS}/uhrzeit.png" "${DFM_BOOT_ASSETS}/hilfe.png" "${ROOTFS_DIR}/usr/share/dfm/"
cp "${DFM_BOOT_ASSETS}/logo.png" "${DFM_BOOT_ASSETS}/bar.png" "${ROOTFS_DIR}/usr/share/plymouth/themes/dfm/"
install -m 644 "${DFM_UPDATE_PUBKEY}" "${ROOTFS_DIR}/etc/dfm/update-key.pub"
echo "${DFM_VERSION}" > "${ROOTFS_DIR}/etc/dfm/version"
printf 'URL=http://127.0.0.1:8081/\n' > "${ROOTFS_DIR}/usr/lib/dfm/kiosk-setup.env"
rm -rf "${ROOTFS_DIR}/etc/systemd/system.conf.d/dfm-watchdog.conf"   # Watchdog ist nur optional (build/optional)
chmod +x "${ROOTFS_DIR}"/usr/lib/dfm/*

on_chroot << 'CHEOF'
set -e
# feste Benutzerkennungen (die Datenpartition wird beim Image-Bau mit diesen IDs vorbereitet)
getent passwd dfm-hub   >/dev/null || useradd --system --uid 990 --user-group --home-dir /nonexistent --shell /usr/sbin/nologin dfm-hub
getent passwd dfm-agent >/dev/null || useradd --system --uid 991 --user-group --home-dir /nonexistent --shell /usr/sbin/nologin -G video,render,input,audio dfm-agent
getent passwd dfm-kiosk >/dev/null || useradd --system --uid 992 --user-group --home-dir /nonexistent --shell /usr/sbin/nologin -G video,render,input dfm-kiosk
# Kein Standardbenutzer, root ohne Passwort, keine Konsole
userdel -r dfmtmp 2>/dev/null || true; userdel -r pi 2>/dev/null || true
passwd -l root
rm -f /etc/sudoers.d/010_pi-nopasswd /etc/sudoers.d/010_dfmtmp-nopasswd /etc/systemd/system/getty@tty1.service.d/autologin.conf
systemctl disable ssh.service sshd.service sshswitch.service regenerate_ssh_host_keys.service ModemManager.service cron.service rpi-eeprom-update.service userconfig.service raspi-config.service rpi-resize.service resize2fs_once.service apt-daily.timer apt-daily-upgrade.timer man-db.timer bluetooth.service hciuart.service triggerhappy.service 2>/dev/null || true
systemctl mask udisks2.service dpkg-db-backup.service dpkg-db-backup.timer logrotate.service logrotate.timer console-setup.service keyboard-setup.service ssh.service sshd.service ssh.socket sshswitch.service regenerate_ssh_host_keys.service ModemManager.service rpi-eeprom-update.service userconfig.service apt-daily.service apt-daily-upgrade.service systemd-timesyncd.service getty@tty1.service
systemctl enable dfm-diag.timer dfm-hwclock-save.timer dfm-zram.service dfm-data.service dfm-firstboot.service dfm-mode.service dfm-powercounter-reset.service NetworkManager.service avahi-daemon.service chrony.service nftables.service fake-hwclock.service
plymouth-set-default-theme dfm || true
# Geheimnisse dürfen NICHT im Image stecken: werden beim ersten Start pro Gerät erzeugt
rm -f /etc/ssh/ssh_host_* /var/lib/dbus/machine-id; : > /etc/machine-id
rm -rf /var/lib/NetworkManager/* /etc/NetworkManager/system-connections/* /var/lib/chrony/* /root/.* 2>/dev/null || true
hostname dfm-signage || true; echo dfm-signage > /etc/hostname
# Platz sparen: Chromium-Übersetzungen (nur de/en-US behalten), Vulkan-Testtreiber, Debug-Schichten
find /usr/lib/chromium/locales -name '*.pak' ! -name 'de.pak' ! -name 'en-US.pak' -delete 2>/dev/null || true
rm -f /usr/lib/chromium/libVkLayer_khronos_validation.so /usr/lib/chromium/libVkICD_mock_icd.so /usr/lib/aarch64-linux-gnu/libvulkan_{radeon,freedreno,lvp,intel,intel_hasvk,virtio,nouveau,panfrost,asahi,gfxstream}.so /usr/share/vulkan/icd.d/{radeon,freedreno,lvp,intel,intel_hasvk,virtio,nouveau,panfrost,asahi,gfxstream}_icd*.json 2>/dev/null || true
apt-get -y clean; rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* /usr/share/locale/[a-ce-z]* /var/cache/* /usr/share/info/*
# Schrift-Zwischenspeicher NACH dem Aufräumen erzeugen (Root ist schreibgeschützt; sonst liest fontconfig bei jedem Textbild alle Schriften neu ein)
fc-cache -f >/dev/null 2>&1 || true
# Uhr: Datei für den Bind-Mount der gespeicherten Zeit muss existieren (sonst "Failed to create mount point /etc/fake-hwclock.data")
[ -e /etc/fake-hwclock.data ] || date -u "+%Y-%m-%d %H:%M:%S" > /etc/fake-hwclock.data
CHEOF
# Avahi-Dienstdateien kommen zur Laufzeit (nur im Hub-Betrieb) aus /run/dfm/avahi-services
# Echtes (leeres) Verzeichnis: dfm-mode bindet /run/dfm/avahi-services beim Start darauf ein (ein Symlink nach /run ist im chroot von avahi nicht erreichbar)
rm -rf "${ROOTFS_DIR}/etc/avahi/services"; install -d "${ROOTFS_DIR}/etc/avahi/services"
