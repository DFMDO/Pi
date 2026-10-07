#!/bin/sh
# Komprimierter Auslagerungsspeicher im RAM (zram): auf einem Pi 3 B+ (1 GB) stehen effektiv deutlich mehr als 1 GB zur Verfügung,
# ohne auf die SD-Karte zu schreiben. Größe: halber Arbeitsspeicher, Kompression zstd (sonst lz4).
set -eu
case "${1:-start}" in
  start)
    modprobe zram num_devices=1 2>/dev/null || exit 0
    [ -e /sys/block/zram0 ] || exit 0
    grep -q '^/dev/zram0' /proc/swaps && exit 0
    MEM_KB=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
    for alg in zstd lz4 lzo-rle; do grep -qw "$alg" /sys/block/zram0/comp_algorithm && { echo "$alg" > /sys/block/zram0/comp_algorithm; break; }; done
    echo $((MEM_KB / 2))K > /sys/block/zram0/disksize
    mkswap /dev/zram0 >/dev/null && swapon -p 100 /dev/zram0
    sysctl -q vm.swappiness=100 vm.page-cluster=0 2>/dev/null || true ;;
  stop) swapoff /dev/zram0 2>/dev/null || true; echo 1 > /sys/block/zram0/reset 2>/dev/null || true ;;
esac
