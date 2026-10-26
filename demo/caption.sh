#!/usr/bin/env bash
# Overlay short explanatory captions on demo/base.mp4 (produced by vhs from duckies.tape) and
# render demo/duckies.mp4 + demo/duckies.gif. This ffmpeg build has no drawtext (no libfreetype),
# so each caption is a single-line PNG rendered with ImageMagick and composited with the overlay
# filter in the empty lower region (never covering the editor content or its status line).
#
# Four timed beats, tuned to the authoring timeline in duckies.tape: writing the session header,
# typing the `:` prompts, typing the `$` command, then the supervisor draining the queue. If you
# re-record (the tape timing shifts a little), re-check the windows below against the new base.mp4.
set -euo pipefail
cd "$(dirname "$0")/.."

FONT=/System/Library/Fonts/Supplemental/Arial.ttf
DIR=demo/cap && mkdir -p "$DIR"

strip() { # $1 = text, $2 = out png
	magick -size 1200x68 xc:none \
		-fill "rgba(32,33,38,0.95)" -draw "roundrectangle 150,6,1050,62,16,16" \
		-font "$FONT" -pointsize 25 -fill white -gravity center -annotate +0+0 "$1" \
		"$2"
}
strip "Write a session's queue"                            "$DIR/1.png"
strip "Prompts ( : )  —  sent to Claude"                   "$DIR/2.png"
strip "Shell commands ( \$ )  —  run in the pane"           "$DIR/3.png"
strip "Supervisor drains bottom-to-top" "$DIR/4.png"

echo "rendering demo/duckies.mp4 ..."
ffmpeg -v error -y -i demo/base.mp4 -i "$DIR/1.png" -i "$DIR/2.png" -i "$DIR/3.png" -i "$DIR/4.png" \
	-filter_complex "\
[0:v][1:v]overlay=0:548:enable='between(t,0,2.3)'[a];\
[a][2:v]overlay=0:548:enable='between(t,2.3,9.9)'[b];\
[b][3:v]overlay=0:548:enable='between(t,9.9,13.2)'[c];\
[c][4:v]overlay=0:548:enable='gte(t,13.2)'[v]" \
	-map "[v]" -c:v libx264 -pix_fmt yuv420p -movflags +faststart demo/duckies.mp4

echo "rendering demo/duckies.gif ..."
ffmpeg -v error -y -i demo/duckies.mp4 -vf "fps=16,scale=1000:-1:flags=lanczos,palettegen=stats_mode=diff" "$DIR/palette.png"
ffmpeg -v error -y -i demo/duckies.mp4 -i "$DIR/palette.png" -lavfi "fps=16,scale=1000:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" demo/duckies.gif

echo "done:"; ls -la demo/duckies.gif demo/duckies.mp4
