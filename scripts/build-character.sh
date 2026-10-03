#!/bin/bash
# Turns an art pack's PNG frame folders into the animated WebP files the pet
# loads. Needs img2webp (brew install webp).
#
# Usage: scripts/build-character.sh <pack-dir> <character-id>
#   <pack-dir> holds full/NN_state/*.png and optionally mini/NN_state/*.png
#   (a pack with a single frames/ folder is treated as full/), plus a README.md
#   giving each animation's speed, as either
#     "- full/01_idle_base: loop, 12 frames @ 11 fps"   or
#     "01 idle base: 1.32s loop"
# Output: characters/<character-id>/{full,mini}/NN_state.webp

set -euo pipefail
PACK="${1:?usage: build-character.sh <pack-dir> <character-id>}"
ID="${2:?usage: build-character.sh <pack-dir> <character-id>}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/characters/$ID"
DEFAULT_FRAME_MS=100

build_set() {
  local set="$1" src="$2" dest="$3"
  [ -d "$src" ] || return 0
  mkdir -p "$dest"
  rm -f "$dest"/*.webp # a renumbered state must not leave its old file behind
  for dir in "$src"/*/; do
    local state frames count fps seconds frame_ms args=()
    state="$(basename "$dir")"
    frames=("$dir"*.png)
    count=${#frames[@]}
    fps="$(grep -E "$set/$state:.*@ *[0-9.]+ *fps" "$PACK/README.md" 2>/dev/null | head -1 | sed -E 's/.*@ *([0-9.]+) *fps.*/\1/' || true)"
    seconds="$(grep -E "^${state%%_*} .*: [0-9.]+s" "$PACK/README.md" 2>/dev/null | head -1 | sed -E 's/.*: ([0-9.]+)s.*/\1/' || true)"
    frame_ms=$DEFAULT_FRAME_MS
    if [ -n "$fps" ]; then
      frame_ms="$(awk -v f="$fps" 'BEGIN { printf "%d", 1000 / f }')"
    elif [ -n "$seconds" ]; then
      frame_ms="$(awk -v s="$seconds" -v n="$count" 'BEGIN { printf "%d", s * 1000 / n }')"
    fi
    for frame in "${frames[@]}"; do args+=(-d "$frame_ms" -lossless "$frame"); done
    img2webp -loop 0 "${args[@]}" -o "$dest/$state.webp" >/dev/null
    echo "$dest/$state.webp  ($count frames, ${frame_ms}ms each)"
  done
}

if [ -d "$PACK/full" ]; then
  build_set full "$PACK/full" "$OUT/full"
  build_set mini "$PACK/mini" "$OUT/mini"
else
  build_set frames "$PACK/frames" "$OUT/full"
fi
