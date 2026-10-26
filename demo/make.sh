#!/usr/bin/env bash
# Rebuild the duckies demo end to end: record the terminal session with vhs, then overlay
# the explanatory captions and render demo/duckies.gif + demo/duckies.mp4.
#   deps: vhs (brew install vhs), ffmpeg, imagemagick
set -euo pipefail
cd "$(dirname "$0")/.."
vhs demo/duckies.tape
bash demo/caption.sh
