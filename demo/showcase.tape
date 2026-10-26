# VHS tape for the duckies FEATURE SHOWCASE — a highlight-only walkthrough of every construct.
# Opens a comprehensive, richly-highlighted .dk file (no editing); short overlay captions naming
# each construct are added afterwards by demo/showcase-caption.sh. Build with: bash demo/make-showcase.sh
#
# Colors mirror the user's WezTerm theme (Gigavolt base16 + custom palette in ~/.config/wezterm/wezterm.lua).

Output demo/base.mp4

Set Shell bash
Set FontSize 15
Set Width 1200
Set Height 1000
Set Padding 24
Set Theme { "name": "wezterm-gigavolt", "background": "#101010", "foreground": "#d9dad2", "cursor": "#d9dad2", "selection": "#202126", "black": "#202126", "red": "#ee7219", "green": "#06c152", "yellow": "#ffdc2d", "blue": "#3399ff", "magenta": "#a875ff", "cyan": "#34b7aa", "white": "#d9dad2", "brightBlack": "#566061", "brightRed": "#ee7219", "brightGreen": "#06c152", "brightYellow": "#e3e4aa", "brightBlue": "#3399ff", "brightMagenta": "#ff52e8", "brightCyan": "#34b7aa", "brightWhite": "#ffffff" }

# --- hidden: seed the file with section 1, start the background builder (reveals sections 2..5),
#     open the editor, park the cursor on a blank line, then start recording already inside it ---
Hide
Type "cd /Users/j/_dev/duckies" Enter
Type "head -n 9 demo/showcase.dk > demo/demo.dk" Enter
Type "bash demo/builder.sh demo/demo.dk 8.5 4 > /dev/null 2>&1 &" Enter
Type "node_modules/.bin/tsx tui.ts demo/demo.dk" Enter
Sleep 3s
Type ":9"
Enter
Show

# --- the file builds up section by section (editor live-reloads); one caption per section ---
Sleep 21s

# --- quit (edits came from the builder via reload, not typed) ---
Type ":q!"
Enter
Sleep 600ms
