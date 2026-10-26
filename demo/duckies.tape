# VHS tape for the duckies demo — base recording (short captions are overlaid afterwards
# by demo/caption.sh). Record the whole pipeline with:  bash demo/make.sh
#
# Starts from an EMPTY file and authors the whole .dk live in the built-in highlighted
# editor — a session header, prompts (`:`) and a shell command (`$`). On save, the
# supervisor (simulated by demo/driver.ts via the real reconcile functions) drains the
# lane bottom-to-top, marching the [EXECUTING] marker up to [DONE].

Output demo/base.mp4

Set Shell bash
Set FontSize 18
Set Width 1200
Set Height 720
Set Padding 24
Set TypingSpeed 60ms
# Colors mirror the user's WezTerm theme (Gigavolt base16 + custom palette in ~/.config/wezterm/wezterm.lua).
Set Theme { "name": "wezterm-gigavolt", "background": "#101010", "foreground": "#d9dad2", "cursor": "#d9dad2", "selection": "#202126", "black": "#202126", "red": "#ee7219", "green": "#06c152", "yellow": "#ffdc2d", "blue": "#3399ff", "magenta": "#a875ff", "cyan": "#34b7aa", "white": "#d9dad2", "brightBlack": "#566061", "brightRed": "#ee7219", "brightGreen": "#06c152", "brightYellow": "#e3e4aa", "brightBlue": "#3399ff", "brightMagenta": "#ff52e8", "brightCyan": "#34b7aa", "brightWhite": "#ffffff" }

# --- setup (hidden): empty file, background the simulated supervisor, AND open the editor so the
#     recording starts already inside the .dk file — the shell is never shown. ---
Hide
Type "cd /Users/j/_dev/duckies" Enter
Type ": > demo/demo.dk" Enter
Type "node_modules/.bin/tsx demo/driver.ts demo/demo.dk --label api-server --wait 'token refresh' --step 1700 --hold 6000 > demo/driver.log 2>&1 &" Enter
Type "node_modules/.bin/tsx tui.ts demo/demo.dk" Enter
Sleep 3s
Show

# --- editor is already open on the empty file; a beat, then author it from scratch ---
Sleep 900ms

# --- author the whole file from scratch (Enter carries the indent, so Tab is pressed once) ---
# Order of authored lines maps to the caption beats: header (writing) -> `:` prompts -> `$` command.
Type "i"
Type "~/dev/api-server"
Enter
Tab
Sleep 700ms
Type ": refactor the auth middleware"
Enter
Type ": add rate limiting to the login route"
Enter
Type ": write tests for the token refresh flow"
Enter
Sleep 700ms
Type "$ git checkout -b auth-hardening"
Escape
Sleep 1.2s

# --- save: the supervisor picks it up and starts draining the queue ---
Type ":w"
Enter
Sleep 10s

# --- quit the editor ---
Type ":q!"
Enter
Sleep 800ms
