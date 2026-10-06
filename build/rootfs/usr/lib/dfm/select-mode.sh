#!/bin/sh
# Entscheidet nach dem Start, was das Gerät ist: noch nicht eingerichtet / Hub / Player.
set -eu
mkdir -p /run/dfm/privd /run/dfm/chrony.d /run/dfm/avahi-services
chmod 1733 /run/dfm/privd   # Agent/Hub dürfen Anfragen ablegen, aber nicht lesen
if [ ! -f /data/config.json ] || [ -f /data/state/force-setup ]; then MODE=setup
else MODE=$(sed -n 's/.*"role":"\([a-z]*\)".*/\1/p' /data/config.json); fi
echo "$MODE" > /run/dfm/mode
# Hostname je Betrieb: Hub = dfm-signage (→ dfm-signage.local), sonst dfm-<4 Zeichen>. Nur im Speicher (Root ist schreibgeschützt).
SUFFIX=$(sed -n 's/.*"hostname":"\([a-z0-9-]*\)".*/\1/p' /data/device.json 2>/dev/null || true)
case "$MODE" in hub) hostname dfm-signage ;; *) [ -n "$SUFFIX" ] && hostname "$SUFFIX" ;; esac
case "$MODE" in
  hub) printf 'allow 10.0.0.0/8\nallow 172.16.0.0/12\nallow 192.168.0.0/16\nlocal stratum 10\nmakestep 1 3\n' > /run/dfm/chrony.d/dfm.conf
       cp /usr/share/dfm/avahi-hub.service /run/dfm/avahi-services/dfm-signage.service
       nft -f /usr/share/dfm/nft-hub.conf 2>/dev/null || true
       systemctl start --no-block dfm-hub.target ;;
  player) printf 'server dfm-signage.local iburst prefer\nmakestep 1 3\n' > /run/dfm/chrony.d/dfm.conf
       nft -f /usr/share/dfm/nft-player.conf 2>/dev/null || true
       systemctl start --no-block dfm-player.target ;;
  *) : > /run/dfm/chrony.d/dfm.conf; nft -f /usr/share/dfm/nft-setup.conf 2>/dev/null || true; systemctl start --no-block dfm-setup.target ;;
esac
# Grüne LED: im Betrieb (Hub/Player) dauerhaft an = bereit; im Einrichtungsmodus blinkt dfm-setup (3× kurz = wartet)
[ "$MODE" = setup ] || { LED=/sys/class/leds/ACT; [ -e $LED ] || LED=/sys/class/leds/led0; [ -e $LED ] && { echo none > $LED/trigger; echo 1 > $LED/brightness; } || true; }
