#!/usr/bin/env bash
# Reveal the showcase file section by section: rewrite the open .dk with progressively more of
# demo/showcase.dk (the editor live-reloads each step), so the file appears to build up bit by bit.
# Section 1 is written by the tape before the editor opens; this appends sections 2..5 on a timer.
#   usage: builder.sh <open-file> [first-delay-s] [step-s]
set -euo pipefail
cd "$(dirname "$0")/.."
src=demo/showcase.dk
out="$1"
first="${2:-6.5}"
step="${3:-3}"
sleep "$first"
for n in 19 28 37 46; do          # cumulative line counts: +billing, +infra, +core-iac, +superapp
	head -n "$n" "$src" > "$out.tmp" && mv "$out.tmp" "$out"
	sleep "$step"
done
