#!/usr/bin/env bash
# Annotate the static showcase recording (demo/base.mp4) with right-side caption pills, each
# aligned to its section and revealed in sequence (they accumulate into a labelled diagram), then
# render demo/showcase.gif + demo/showcase.mp4. This ffmpeg build has no drawtext (no libfreetype),
# so pills are PNGs rendered with ImageMagick and composited with overlay.
set -euo pipefail
cd "$(dirname "$0")/.."

FONT=/System/Library/Fonts/Supplemental/Arial.ttf
X=612                      # left edge of the pill column (content sits left of this)
DIR=demo/cap && mkdir -p "$DIR"

pill() { # $1 = text, $2 = out png
	magick -size 576x54 xc:none \
		-fill "rgba(32,33,38,0.96)" -draw "roundrectangle 0,0,575,53,14,14" \
		-font "$FONT" -pointsize 20 -fill "#e6e6e6" -gravity west -annotate +22+0 "$1" \
		"$2"
}
pill "session · : prompt · | body · \$ command · -> recap" "$DIR/1.png"
pill "5 marker states · parallel lanes  :: =:2  \$\$ =:2"  "$DIR/2.png"
pill "# comment & barrier · ! reveal · show · % clear"     "$DIR/3.png"
pill "@ macro · > template (paste) · & widget (live)"      "$DIR/4.png"
pill "worktrees · ? sleep · DUCKIES: edits the .dk"        "$DIR/5.png"

echo "rendering demo/showcase.mp4 ..."
ffmpeg -v error -y -i demo/base.mp4 -i "$DIR/1.png" -i "$DIR/2.png" -i "$DIR/3.png" -i "$DIR/4.png" -i "$DIR/5.png" \
	-filter_complex "\
[0:v][1:v]overlay=${X}:68:enable='between(t,0.3,3.6)'[a];\
[a][2:v]overlay=${X}:273:enable='between(t,3.6,6.6)'[b];\
[b][3:v]overlay=${X}:457:enable='between(t,6.6,9.6)'[c];\
[c][4:v]overlay=${X}:642:enable='between(t,9.6,13.6)'[d];\
[d][5:v]overlay=${X}:826:enable='gte(t,13.6)'[v]" \
	-map "[v]" -c:v libx264 -pix_fmt yuv420p -movflags +faststart demo/showcase.mp4

echo "rendering demo/showcase.gif ..."
ffmpeg -v error -y -i demo/showcase.mp4 -vf "fps=15,scale=1000:-1:flags=lanczos,palettegen=stats_mode=diff" "$DIR/palette.png"
ffmpeg -v error -y -i demo/showcase.mp4 -i "$DIR/palette.png" -lavfi "fps=15,scale=1000:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" demo/showcase.gif

echo "done:"; ls -la demo/showcase.gif demo/showcase.mp4
