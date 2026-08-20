# herald

Run many interactive Claude Code instances in tmux and control/observe them all
through plain-text `.herald` files.

Each file is both a **dashboard** (Claude activity is written back as status
markers) and a **control surface** (edits start/stop/clear sessions and queue
prompts). A `tsx` supervisor loop merges every `*.herald` file in the repo dir into
one logical control and reconciles it against live tmux every second. Split your
work across as many `.herald` files as you like (e.g. `work.herald`,
`personal.herald`) — they're combined into one dashboard and each is rewritten in
place. If the same label appears in more than one file (or twice in one), all its rows
are **merged into one queue** — each file's rows keep their place and markers write back
to whichever file they came from.

## Setup (once)

```sh
pnpm install
pnpm setup   # makes herald-hook executable, creates state/, installs a
             # command-completion hook for your shell (fish, zsh, and bash are
             # supported), and installs the Stop + Notification +
             # UserPromptSubmit hooks into ~/.claude/settings.json
```

`setup` merges its hooks into your **global** `~/.claude/settings.json` (backing
it up to `settings.json.herald-bak`) and is idempotent — re-run it any time (e.g.
after moving the repo). The Claude hooks are guarded by `$HERALD_LABEL` and the
shell hooks by `$HERALD_SHELL`, so both are a no-op for your normal Claude sessions
and shells and only fire for herald-launched ones.

The **command-completion hook** reports when a `$command` has finished. fish
auto-loads it from `~/.config/fish/conf.d`; bash and zsh get a `source` line
appended to `~/.bashrc` / `~/.zshrc` (each backed up once to `<rc>.herald-bak`).
Only the shell whose config exists is touched, and each hook self-activates just
in its own shell, so whichever shell the session's window runs is handled
automatically.

## Run

```sh
pnpm start            # merge every ./*.herald file and reconcile each second
pnpm start --dry-run  # log intended tmux actions / rewrites without doing them
pnpm herald           # edit .herald in the built-in live editor (see below)
pnpm herald work.herald  # …or edit a specific control file
```

## Quickstart

In one terminal, start the supervisor:

```sh
pnpm start
```

In another, put this in a `.herald` file (a bare name resolves to `~/_dev/<name>`):

```
moonbase
	: run the test suite and fix any failures
```

The supervisor spawns tmux session `__moonbase` running `claude` in
`~/_dev/moonbase`, sends the prompt, and marks it `[EXECUTING]`. Watch it work:

```sh
tmux attach -t __moonbase
```

When Claude finishes, the line flips to `[DONE]`. Queue more work by adding lines
**above** it (newest on top) — see the examples below.

## Editing live (`pnpm herald`)

`pnpm herald [file]` opens a `.herald` control file (default `.herald`) in a
**built-in, vim-like editor** — a self-contained modal TUI (no external editor
process) with `.herald` syntax highlighting. Pass a filename to edit a specific one.
While you type, the supervisor keeps writing to the same file; the editor folds the
controller's out-of-band writes (marker updates, drained `show` lines, …) into your
buffer **without disturbing what you're typing**:

- It only touches the buffer while you're idle in **normal mode**, so keystrokes are
  never lost — a pending update lands the moment you leave insert.
- With **no unsaved edits**, it's a clean reload (your cursor stays put).
- With **unsaved edits**, it 3-way merges the controller's change into your buffer
  (your line wins on a genuine conflict) and keeps the cursor on the line you were on.

Save with `:w`; quit with `:q` (`:wq`/`:x` to do both). It needs an interactive
terminal and respects `HERALD_FILE`. Runs alongside `pnpm start` (that's the point).

**Keys** (a practical vim subset):

- **Modes** — `i a I A o O` enter insert; `Esc` returns to normal; `v` / `V` start
  charwise / linewise visual; `:` ex command; `/` search.
- **Motions** — `h j k l` (and arrows), `w b e`, `0 ^ $`, `gg G`, `f F t T <char>`,
  `Ctrl-d`/`Ctrl-u`/`Ctrl-f`/`Ctrl-b` to scroll; any motion takes a `{count}` prefix.
- **Edits** — `x` delete char, `r` replace char, `s`/`S`, `D`/`C`, `dd cc yy`,
  operators `d c y` + a motion (e.g. `dw`, `c$`, `y2j`), `p`/`P` paste,
  `u` undo, `Ctrl-r` redo. In visual mode `d y c x` act on the selection.
- **Ex** — `:w` `:q` `:wq` `:x` `:q!` and `:{number}` to jump to a line;
  `/text` then `n`/`N` to search.

## The `.herald` files

The supervisor picks up **every** `*.herald` file in the repo dir and merges them
into one control (sessions from all files combined, alphabetical by filename). Each
file is written back in place, so you can split work across several — one per
context — and still watch them as a single dashboard. The whole of each file is the
managed sessions region; keep your backlog and other notes elsewhere so the
supervisor's rewrites never touch them.

```
moonbase
	prompt: newest task, runs last
	prompt: please add feature X, commit, push PR
		[EXECUTING]
	prompt: please start working on X
		[DONE]
moonbase-2
	prompt: investigate the flaky test
		[NEEDS ATTENTION]
```

- A line at column 0 is a **session**. It is, in order of precedence:
  - an **alias** listed in `herald-aliases.yaml` → its mapped path, tmux session
    `__<alias>`; or
  - a **path** (`/abs`, `~/…`, or anything containing `/`) → that dir, with the
    label/tmux name taken from its basename (e.g. `~/projects/moonbase` →
    `__moonbase`). Use this to point sessions anywhere on disk; or
  - a **bare name** → dir `~/_dev/<name>`, tmux session `__<name>`.

  A trailing `!` on the header (e.g. `moonbase!`) means **show it now**: the
  supervisor switches your attached tmux client to the session immediately —
  regardless of the queue — then strips the `!` (a one-shot request). The name/path
  resolves from the header without the `!`. This is the eager cousin of a queued
  `show` line (below).
- `prompt: …` lines (`: …` is shorthand) and `$command` lines under a session form
  **one queue** that drains **bottom-to-top**, **one item at a time in file order**
  (oldest at the bottom; append new work at the top). An item runs only once the
  item **below** it — whether a prompt or a command — has finished, so the two
  never overlap and their relative order is exactly their order in the file.
- `prompt:` lines run in the **claude pane**; the supervisor marks one `[EXECUTING]`
  and advances it to `[DONE]` when Claude signals it finished (the hook's Stop
  event). `[NEEDS ATTENTION]` replaces the marker when Claude blocks waiting for
  input mid-task; answering it (submitting a prompt into the pane) flips it back to
  `[EXECUTING]`.
- **Multiline prompt.** Lines starting with `|` under a `prompt:`/`:` line are that
  prompt's **body** (YAML block-scalar style) — paste an error, a log, a spec and prefix
  each line with `|`; the whole block is sent as one multiline prompt (via bracketed paste,
  so the newlines don't submit early). The `|` and one following space are stripped, but any
  further indentation is kept, so the body's own shape survives. The explicit prefix keeps a
  body line from being mistaken for a worktree. The item stays a single queue entry and its
  status marker lands **below** the body:

  ```
  Claudia
  	: how do I resolve this? the IP changed
  	| @@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@
  	| Host key verification failed.
  		[EXECUTING]
  ```
- `$command` lines run **once** in the session's **shell window** (the 2nd window,
  not the claude pane). A command is marked `[EXECUTING]` when dispatched and only
  advances to `[DONE]` once it has actually **exited** (a per-shell hook writes its
  exit status to `state/<label>.cmd` and the controller waits for that done-file). A command
  that never exits (e.g. a server) stays `[EXECUTING]` and blocks the rest of the
  queue — by design. So e.g. `$git push` placed above `: make the change` runs only
  after that prompt is done.
- **Lanes / numbered panes.** A number on the sigil routes an item to a parallel lane
  that runs **concurrently** with the others: `:2` (or `::`) is a prompt in a *second,
  independent Claude* window; `$2` (or `$$`) a command in a *second shell*; `:::`/`$$$`
  → lane 3, and so on (repeated sigils count, or write the number — `::`≡`:2`). Base
  `:`/`$` are lane 1 (unchanged). Within a lane, items still serialize bottom-to-top;
  **across** lanes they run at once — so a long-running `$2 npm run dev` in lane 2 won't
  block `$` work in lane 1. Extra windows (`claude2`, `shell2`, …) are created on demand.
  Each lane reports completion via its own done-files (`state/<label>.2.cmd`, etc.). Note:
  every `:N` lane is a *separate* Claude conversation running concurrently under your account.
- **Worktrees.** An indented line that *isn't* a sigil (`:`/`$`/`@`/`#`/`show`) names a
  **git worktree** of its session's repo. Items indented **below** it run in that worktree
  — it's its own session (own tmux windows, own Claude), created on demand the first time it
  has work: `git worktree add --detach` at `<repo>/../<repo>-worktrees/<name>` (a detached HEAD off
  the repo's current commit). Its tmux session is `__<repo>-<name>` (the repo's label
  prefixed onto the worktree name), so it sorts next to the repo's own `__<repo>` and two
  same-named worktrees under different repos never clash. A trailing `!` on the line means
  "switch to it now", just like on a repo header. Removing the line tears the worktree down
  with its tmux session: the supervisor `git worktree remove --force`s it. Like the tmux kill
  this is unconditional — uncommitted or untracked changes in the worktree are discarded — so
  commit or move anything worth keeping first. Once a repo's last worktree goes, its now-empty
  `<repo>-worktrees` folder is removed too. A worktree line with no children is inert.

  ```
  superapp
  	: task on the main checkout
  	feature-x                       ← worktree ../superapp-worktrees/feature-x, tmux __superapp-feature-x
  		: try the risky refactor here
  		$ pnpm test
  	feature-y                       ← a second, independent worktree + Claude (__superapp-feature-y)
  		: try a different approach
  ```
- `#…` lines are **comments**, and an **indented** one is also a **barrier**: the drain
  halts when it reaches it (in its lane) until you delete the line — put one below the
  work you want to stop (the bottom-most item runs first, so a `#` at the very bottom
  blocks the whole session). A **column-0** `#` is a plain comment (no queue to halt) —
  handy for notes/outlines between sessions. Either way it's never a session, task, or
  marker, and round-trips verbatim. (Only a line that *starts* with `#` counts; a trailing
  `#` is part of a prompt/command's text.)
- A bare `show` line is a **queue item** that brings the session **on screen**: when
  the drain reaches it (the item below it is done), the supervisor switches your
  attached tmux client (e.g. the terminal you have open in WezTerm) to it, then
  deletes the `show` line — a one-shot request, ordered like everything else in the
  queue. If the session isn't running yet it's spawned first, then shown when its
  turn comes.
- Only the **current** item **per lane** keeps a marker — it is that lane's *frontier*:
  items above it (nearer the top) are still pending, items below it have already run.
  When the next item is marked `[EXECUTING]`, the previous marker is stripped, so each
  lane shows at most one marker (its active item, or its final `[DONE]` once it drains) —
  with several lanes you'll see one marker per lane. Delete a final `[DONE]` to re-run
  that lane's queue from the bottom.

## What edits do

| You do | Supervisor does |
| --- | --- |
| Add a session (bare name or path; the dir must exist) | Spawns `tmux` session `__<label>` running `claude` in that dir |
| Add a `prompt:` line | Queues it; sends it to the claude pane when it reaches the front (the item below is done); marks `[EXECUTING]` → `[DONE]` |
| Add a `$command` line | Queues it; runs it once in the shell window when it reaches the front; marks `[EXECUTING]` → `[DONE]` when it exits |
| Number a sigil (`:2`/`::`, `$2`/`$$`, `#2`/`##`) | Routes the item to a parallel lane that runs concurrently — a 2nd Claude (`claude2`) / shell (`shell2`), created on demand |
| Add an indented `#` line | Halts the drain there (a barrier / comment) until you delete it; a column-0 `#` is just a comment |
| Add a `show` line | When the queue reaches it, switches your attached tmux client to this session, then deletes the line |
| Add a `!` to a session header | Switches your attached tmux client to this session immediately (queue-independent), then strips the `!` |
| Add a space-separated ` !` to any item line (or its marker) | Reveals that item's window immediately — the shell for a `$command`, the claude pane for a prompt — then strips the `!` |
| Delete all prompts under a session | Sends `/clear` (session stays alive, idle) |
| Delete the session name | Kills the tmux session — and, for a worktree, `git worktree remove --force`s it too (uncommitted changes discarded) |
| Answer a `[NEEDS ATTENTION]` prompt | Type directly into the tmux; the marker flips back to `[EXECUTING]` on submit, then `[DONE]` when Claude finishes |

Each spawned session has **two windows**: window `claude` (driven by the
controller) and window `shell` (a free shell for you to run commands in). The
claude pane is tagged with a pane-scoped tmux option (`@herald = claude`), so
prompts always target it regardless of which window/pane is focused.

Attach to a session with `tmux attach -t __<label>` (switch windows with your
tmux prefix + `n`/`p`).

## Usage examples

All of these are just text you put in a `.herald` file while `pnpm start` runs.
Remember the queue drains **bottom-to-top**, one item at a time, so **new work
goes on top**. Indentation is with **tabs**.

### Queue several prompts (they run oldest-first)

```
moonbase
	: write a design doc for the new billing flow
	: implement it and add tests
	: open a PR
		[EXECUTING]
```

The bottom item runs first; each next one starts only when the item below it is
`[DONE]`. Here "open a PR" is the active frontier — the two above it are still
pending and carry no marker.

### Mix prompts and shell commands

`$command` lines run in the session's **shell window** and only advance once the
command actually exits, so you can interleave them with prompts and trust the
ordering:

```
moonbase
	$ pnpm test
	: fix whatever the tests flagged
	$ git add -A && git commit -m "wip"
		[EXECUTING]
```

Reading bottom-up: commit the current state, let Claude fix the tests, then run
the suite again. A long-running `$command` (e.g. `$ pnpm dev`) stays `[EXECUTING]`
and intentionally holds the queue — put it last (top) if you want it to linger.

### Run work in parallel lanes (numbered panes)

Number the sigil to open a concurrent lane. Here lane 2 keeps a dev server running
(`$$`) and drives a second Claude on the frontend (`::`) while lane 1 works the
backend — all at once, each in its own window:

```
moonbase
	# lane 1 works the backend; lane 2 runs a dev server + a frontend Claude
	: refactor the API handlers
		[EXECUTING]
	$$ pnpm dev
	:: build the settings page
		[EXECUTING]
```

Both `[EXECUTING]` markers are live simultaneously — one per lane. `::` ≡ `:2`,
`:::` ≡ `:3`, `$$` ≡ `$2`, and so on. The `claude2`/`shell2` windows are created the
first time a lane needs them. A trailing ` !` on any line reveals *that* lane's pane.

### Comment or block with `#`

Any row starting with `#` is comment-styled and never runs. A **column-0** `#` is a
plain note (it sits between sessions). An **indented** `#` is also a **barrier** — the
drain stops there until you remove it. Since the queue drains bottom-to-top, a `#` below
an item blocks that item (and everything above it); a `#` at the very bottom freezes the
whole session:

```
# release notes — top-level comment
moonbase
	: cut the release branch
	: publish the release
		[EXECUTING]
	# blocked: waiting on sign-off — delete to continue
```

Here `publish the release` is running; the `# blocked` below it stops the drain from
starting anything else, and once you delete it the queue continues. (Only a line that
**starts** with `#` counts; a trailing `#` stays part of a prompt/command's text.)

### Bring a session on screen

A queued `show` line switches your attached tmux client when the drain reaches it
(ordered like everything else). A bare `!` line is shorthand for `show`:

```
moonbase
	: crunch through the migration
	show
	: warm up the caches
		[DONE]
```

A trailing `!` on the **header** instead switches **immediately**, regardless of
the queue, then strips itself — the "look at this one right now" button:

```
moonbase!
	: something just broke — look now
```

A space-separated trailing `!` on **any item line** reveals *that item's* window
right away: the shell window for a `$command`, the claude pane for a prompt. The `!`
strips itself once shown. The separating space keeps ordinary end punctuation as text
(`: ship it!` stays text; `: ship it !` is a reveal):

```
moonbase
	: crunch through the migration
	$ tail -f build.log !
	: warm up the caches
```

(The same `!` also works appended to an item's status marker, e.g. `[EXECUTING]!`.)

### Clear a session without killing it

Delete all the prompt/command lines under a header but keep the header:

```
moonbase
```

The supervisor sends `/clear` to the claude pane; the tmux session stays alive and
idle, ready for the next prompt. Delete the header line itself to **kill** the
session.

### Answer a blocked task

When Claude stops mid-task to ask something, its line shows `[NEEDS ATTENTION]`:

```
moonbase
	: refactor the auth module
		[NEEDS ATTENTION]
```

Attach (`tmux attach -t __moonbase`) and type your answer into the claude pane.
On submit the marker flips back to `[EXECUTING]`, then `[DONE]` when it finishes.

### Re-run a finished queue

Only the final `[DONE]` remains once a queue drains. Delete that marker line and
the whole queue re-runs from the bottom.

### Several sessions at once

```
moonbase
	: run the test suite
		[EXECUTING]
infra
	$ terraform plan
		[EXECUTING]
scratch
	: prototype the new parser
		[DONE]
```

Each header is an independent session with its own queue; they run in parallel.
`infra` and `scratch` resolve to `~/_dev/infra` and `~/_dev/scratch`; give any of
them a full path or an alias instead (below).

### Point a session anywhere / use an alias

```
~/work/infra-monorepo
	: bump the node version
/tmp/experiment
	: throwaway spike
infra
	: same repo as above, via alias
```

A header containing `/` is used as a path (tmux name = its basename); a bare name
that matches `herald-aliases.yaml` uses the mapped path. See the aliases section.

## Editor syntax highlighting

`.herald` grammars for three editors, all mirroring `parse()` in `herald.ts`:

- **Sublime Text** — `herald.sublime-syntax` (drop into `Packages/User`). Drop
  `herald.tmPreferences` in alongside it so `toggle_comment` (`Cmd`/`Ctrl`+`/`)
  comments rows out with `#`. For the black-on-yellow **macro** styling, copy
  `herald.sublime-color-scheme`, rename it to match your active color scheme (e.g.
  `Mariana.sublime-color-scheme`), and place it where Sublime will merge it — in
  `Packages/User` if your scheme is built-in, or in its own package folder (e.g.
  `Packages/herald/`) if your scheme itself lives in `Packages/User`.
- **Neovim / Vim** — `editors/nvim/` (`syntax` + `ftdetect` + `ftplugin`). Symlink or
  copy the three `herald.vim` files into the matching dirs under `~/.config/nvim/`;
  filetype detection and highlighting then load automatically. Status markers render
  white-on-red (override with `hi heraldStatus …`).
- **VS Code** — `editors/vscode/` (a TextMate-grammar extension; colors follow your
  theme). See its `README.md` to install from source or package a `.vsix`.

## Notes

- Permissions: launched Claudes inherit your global bypass setting
  (`skipDangerousModePermissionPrompt`); the supervisor does nothing about them.
- Identity: each Claude launches with `HERALD_LABEL`/`HERALD_STATE` exported; the
  hooks inherit these and write `state/<label>.json`, which the loop reads (using
  the file's mtime as the event time).
- Missing `~/_dev/<label>` ⇒ the session is annotated `[NO DIR …]` and skipped.
- The loop is the sole writer of markers; it computes changes, writes each file,
  then runs tmux actions, and defers if you edit any `.herald` file mid-tick.
- A label appearing in multiple files (or twice in one) is merged into a single queue,
  its rows concatenated in filename order; each marker writes back to its own file, and
  session-level state (dir, `[NO DIR …]`, a header `!`) comes from the first file.

## Repo aliases (`herald-aliases.yaml`)

Optional. A YAML map of `label: path`, so a header in a `.herald` file can be a
short label instead of a full path. `~` expands to your home dir; the label
becomes the tmux session name. See `herald-aliases.example.yaml`.

```yaml
moonbase: ~/projects/moonbase
infra: ~/work/infra-monorepo
```

The file is re-read every tick, so alias edits take effect without a restart. A
header that isn't a listed alias falls back to the path / bare-name rules above.

## Macros (`herald-macros.yaml`)

Optional. A YAML map of `name: |<multiline block>`, so a `@name` line on its own in a
`.herald` file runs a reusable block of rows. See `herald-macros.example.yaml`.

```yaml
ship: |
  $ gh pr view --web
  : commit, push, and open the PR, no claude attribution
  : run the tests and fix anything broken
```

Drop `@ship` under a session and it becomes **one queue item** whose block expands **in
memory** — the `@ship` line stays in the file, and its rows (`:` prompts, `$` commands;
`#` lines are comments, dropped) run **in sequence** as the item's steps:

```
core-iac
	@ship
		[EXECUTING]     ← one overall marker: [EXECUTING] while any step runs, [DONE] when all finish
```

Steps run **bottom-to-top**, like every herald queue — the block's **last** line runs
first (put the setup command at the bottom, the follow-up prompt above it). Only a single
marker is written — the macro is tracked as a whole, not row by row (the step cursor lives
in the controller runtime, so it resumes mid-macro across ticks and restarts). A body line
like `@@@…` never matches (a name char must follow the `@`).

**Arguments.** Pass them after the name; the block fills placeholders from them:

```yaml
review: |
  : review PR {0} — focus on {1}, no claude attribution
  $ gh pr view {0} --web
```

```
core-iac
	@review 2500 "the auth refactor"
```

`{0}`, `{1}`, … are the positional args (**0-based**; **quote** a value to keep its
spaces), `{*}` is all of them space-joined, and a missing one expands blank. Braces are
used (not `$1`) so a placeholder never clashes with a `$2`/`:2` lane sigil inside the block.

## Env overrides (mainly for testing)

- `HERALD_DIR` — scan a different directory for `*.herald` files instead of the repo dir.
- `HERALD_FILE` — single-file mode: watch exactly this one file (ignores the `*.herald` scan).
- `HERALD_ALIASES` — read aliases from a different file instead of `./herald-aliases.yaml`.
- `HERALD_MACROS` — read macros from a different file instead of `./herald-macros.yaml`.
- `HERALD_READY_MS` — boot grace before the first prompt is sent (default 6000).

## Test

```sh
pnpm test         # parser round-trip + reconciler unit tests
pnpm type-check
```
