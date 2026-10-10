#!/bin/bash
# Runs native/cli.c jobs ("mode W H [moves [s]]" per line on stdin), P at a time, each capped
# at CAP seconds of wall clock. One JSON file per job in tools/runs/solve/; a job that hits
# the cap leaves {"timeout": CAP} instead.
# Usage: tools/run-solver.sh [P] [CAP] < jobs
set -euo pipefail
cd "$(dirname "$0")/.."
P=${1:-3}; CAP=${2:-600}
OUT=tools/runs/solve; mkdir -p "$OUT"
BIN=/tmp/c4-native-$$
cc -O3 -march=native -o "$BIN" native/cli.c
xargs -P "$P" -L 1 sh -c '
  f="'"$OUT"'/$0-$1x$2${3:+-$3}${4:+-$4}.json"
  [ -s "$f" ] && exit 0
  if perl -e "alarm '"$CAP"'; exec @ARGV" "'"$BIN"'" "$0" "$1" "$2" ${3:+"$3"} ${4:+"$4"} > "$f.tmp" 2>/dev/null; then
    mv "$f.tmp" "$f"
  else
    echo "{\"mode\":\"$0\",\"w\":$1,\"h\":$2,\"moves\":\"${3:-}\",\"timeout\":'"$CAP"'}" > "$f"; rm -f "$f.tmp"
  fi'
