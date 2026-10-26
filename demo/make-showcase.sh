#!/usr/bin/env bash
# Rebuild the feature-showcase gif end to end: record the static, fully-highlighted showcase.dk
# with vhs, then overlay the right-side annotation pills → demo/showcase.gif + demo/showcase.mp4.
#   deps: vhs (brew install vhs), ffmpeg, imagemagick
set -euo pipefail
cd "$(dirname "$0")/.."
vhs demo/showcase.tape
bash demo/showcase-caption.sh
