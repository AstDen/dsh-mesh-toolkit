#!/usr/bin/env bash
# Regenerate docs/img/demo.gif: clipped rotation frames from an STL, assembled with ffmpeg.
#
#   ./scripts/make-media.sh path/to/geometry.stl [frames]
#
# Needs ParaView's pvpython (override with PVPYTHON) and ffmpeg. The PNGs in
# docs/img come from the same geometry through pv_view.py of the parent project;
# this wrapper only builds the GIF so the README animation can be reproduced.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STL="${1:-}"
FRAMES="${2:-16}"
PVPYTHON="${PVPYTHON:-pvpython}"

if [[ -z "$STL" || ! -f "$STL" ]]; then
    echo "usage: $0 <stl> [frames]" >&2
    exit 2
fi

OUT="$ROOT/docs/img"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export VTK_DEFAULT_OPENGL_WINDOW="${VTK_DEFAULT_OPENGL_WINDOW:-vtkEGLRenderWindow}"
export EGL_PLATFORM="${EGL_PLATFORM:-surfaceless}"
export LIBGL_ALWAYS_SOFTWARE="${LIBGL_ALWAYS_SOFTWARE:-1}"

"$PVPYTHON" --force-offscreen-rendering "$ROOT/scripts/make-media.py" \
    --input "$STL" --out-dir "$TMP" --frames "$FRAMES"

mkdir -p "$OUT"
ffmpeg -y -loglevel error -framerate 10 -i "$TMP/frame%02d.png" \
    -vf "scale=760:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
    -loop 0 "$OUT/demo.gif"
echo "wrote $OUT/demo.gif"
