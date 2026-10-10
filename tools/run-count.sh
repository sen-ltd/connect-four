#!/bin/bash
# Counts every cell of Tromp's position table whose bitmap fits in LIMIT bytes, smallest
# first; then the play-on convention on small boards; then 7x6 ply by ply up to PLY.
# Usage: tools/run-count.sh [threads] [limit-bytes] [maxply-7x6]   → tools/runs/count/*.json
set -euo pipefail
cd "$(dirname "$0")/.."
T=${1:-3}; LIMIT=${2:-1500000000}; PLY=${3:-13}
OUT=tools/runs/count; mkdir -p "$OUT"
cc -O3 -march=native -o /tmp/c4-count native/count.c -lpthread
run() {  # name w h [play-on]
  f="$OUT/$1.json"
  [ -s "$f" ] && return 0
  C4_LIMIT=$LIMIT /tmp/c4-count total "$2" "$3" "$T" ${4:-} > "$f.tmp" && mv "$f.tmp" "$f"
}
for h in 1 2 3 4 5 6 7 8; do
  case $h in 1|2|3|4) M=8 ;; 5|6) M=7 ;; 7) M=5 ;; 8) M=4 ;; esac
  for w in $(seq 1 "$M"); do echo "$((w * h)) $w $h"; done
done | sort -n | while read -r _ w h; do run "total-${w}x${h}" "$w" "$h"; done
for wh in 4x4 5x4 4x5 6x4 5x5 4x6; do run "playon-$wh" "${wh%x*}" "${wh#*x}" play-on; done
[ -s "$OUT/levels-7x6.json" ] || { /tmp/c4-count levels 7 6 "$PLY" > "$OUT/levels-7x6.tmp" && mv "$OUT/levels-7x6.tmp" "$OUT/levels-7x6.json"; }
echo done > "$OUT/.finished"
