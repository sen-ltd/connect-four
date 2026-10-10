#!/bin/bash
# Builds src/c4.wasm from native/solver.c (no libc, no Emscripten).
# Needs a clang with the wasm32 target and wasm-ld; `zig cc` provides both.
set -euo pipefail
cd "$(dirname "$0")/.."
CC=${CC:-zig cc}
$CC --target=wasm32-freestanding -O3 -nostdlib -fno-builtin \
  -Wl,--no-entry -Wl,--export-dynamic -Wl,--initial-memory=33554432 \
  -o src/c4.wasm native/solver.c
ls -l src/c4.wasm
