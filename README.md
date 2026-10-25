# duckies

Run many interactive Claude Code instances in tmux and control/observe them all
through plain-text `.dk` files.

Each file is both a **dashboard** (Claude activity is written back as status
markers) and a **control surface** (edits start/stop/clear sessions and queue
prompts). A `tsx` supervisor loop merges every `*.dk` file in `~/.config/duckies/duckspaces`
into one logical control and reconciles it against live tmux every second. Split your
work across as many `.dk` files as you like (e.g. `work.dk`,
`personal.dk`) — they're combined into one dashboard and each is rewritten in
place. If the same label appears in more than one file (or twice in one), all its rows
are **merged into one queue** — each file's rows keep their place and markers write back
to whichever file they came from.

## Requirements

- **tmux** and **Node 18+** (with `pnpm`) — required on any platform.
- **Claude Code** (`claude`) on your `PATH` — or point `DUCKIES_AGENT_CMD` at another agent CLI.
- A shell duckies can install a completion hook for: **fish**, **zsh**, or **bash**.
- **macOS** is optional-nice: set `DUCKIES_TERM_APP` to have a `show`/`!` foreground your
  terminal app. Everything else (the supervisor, TUI, tmux control) is cross-platform.

## Setup (once)

```sh
pnpm install
pnpm setup   # makes duckies-hook executable, creates state/, installs a
             # command-completion hook for your shell (fish, zsh, and bash are
             # supported), and installs the Stop + Notification +
             # UserPromptSubmit hooks into ~/.claude/settings.json
```

`setup` merges its hooks into your **global** `~/.claude/settings.json` (backing
it up to `settings.json.dk-bak`) and is idempotent — re-run it any time (e.g.
after moving the repo). The Claude hooks are guarded by `$DUCKIES_LABEL` and the
shell hooks by `$DUCKIES_SHELL`, so both are a no-op for your normal Claude sessions
and shells and only fire for duckies-launched ones.

The **command-completion hook** reports when a `$command` has finished. fish
auto-loads it from `~/.config/fish/conf.d`; bash and zsh get a `source` line
appended to `~/.bashrc` / `~/.zshrc` (each backed up once to `<rc>.dk-bak`).
Only the shell whose config exists is touched, and each hook self-activates just
in its own shell, so whichever shell the session's window runs is handled
automatically.

## Run

```sh
pnpm start            # merge every ./*.dk file and reconcile each second
pnpm start --dry-run  # log intended tmux actions / rewrites without doing them
pnpm duckies           # edit .dk in the built-in live editor (see below)
pnpm duckies work.dk  # …or edit a specific control file
```

### Supervisor view

When `pnpm start` runs in a real terminal, the supervisor shows a full-screen **notifier**: every lane
is grouped by state and the supervisor's own log runs as a short strip along the bottom. The supervisor
keeps reconciling the whole time — only the display changes. Sections, top to bottom:

1. **NEEDS ATTENTION** — lanes stuck at `[NEEDS ATTENTION]` (and `[ERROR]`).
2. **DONE** — lanes whose frontier is `[DONE]`, oldest first.
3. **EXECUTING** — lanes currently running (and `[WAITING]`), dimmed with a spinner.
4. **DISMISSED** / **SNOOZED** / **SLEEPING** — lanes you've set aside (appear only when non-empty). A
   closed session shows `· closed`; a slept one `· asleep`.

Keys (the selected row has a `❯` gutter):

- **`j`/`k`** (or `↓`/`↑`) move · **`g`/`G`** jump to first/last.
- **`space`/`enter`** focus the selected lane's tmux pane (switches the watching client to it).
- **`h`** open the lane's spot in its `.dk` file in the editor (Sublime by default; override with
  `DUCKIES_EDITOR`, e.g. `DUCKIES_EDITOR="code --goto"`).
- **`s`** snooze (pick a duration; hidden until it lapses, then reappears) · **`S`** sleep & snooze
  (also sleeps the session for that time, waking it on expiry) · **`z`** toggle sleep (`?`) on the
  session · **`d`** dismiss / restore · **`u`** undo the last dismissal · **`x`** clear (writes a `%`
  so duckies collapses the finished run) · **`/`** filter by lane name + text.
- **`Tab`** expand the log strip to fullscreen (and back).
- **`m`** open the config/new-label menu (arrow keys + enter, or the shortcut letter):
  - **`a`/`c`/`w`/`t`** — open `aliases.yaml` / `macros.yaml` / `widgets.yaml` / `templates.yaml` in the editor.
  - **`n`** — add a new label: pick one of your `.dk` files, type the label, and it's appended as a new
    session header prefixed with `!`. The supervisor spawns the tmux session on its next tick and switches
    your client to its claude window (then consumes the `!`) — you land straight in the session. (If the
    label already exists, it reveals that session's tmux and opens its `.dk` at the header instead.)
- **`q`** (or `Esc` / `Ctrl-C`) stop the supervisor (restoring the terminal).

Editing opens in a GUI editor (`subl`), so it never takes over the terminal. The view auto-disables when
stdout isn't a TTY (dry-run, piped) or `DUCKIES_TUI=0`, falling back to a plain scrolling log.

## Quickstart

In one terminal, start the supervisor:

```sh
pnpm start
```

In another, put this in a `.dk` file (a bare name resolves to `~/_dev/<name>`):

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

## Editing live (`pnpm duckies`)

`pnpm duckies [file]` opens a `.dk` control file (default `.dk`) in a
**built-in, vim-like editor** — a self-contained modal TUI (no external editor
process) with `.dk` syntax highlighting. Pass a filename to edit a specific one.
While you type, the supervisor keeps writing to the same file; the editor folds the
controller's out-of-band writes (marker updates, drained `show` lines, …) into your
buffer **without disturbing what you're typing**:

- It only touches the buffer while you're idle in **normal mode**, so keystrokes are
  never lost — a pending update lands the moment you leave insert.
- With **no unsaved edits**, it's a clean reload (your cursor stays put).
- With **unsaved edits**, it 3-way merges the controller's change into your buffer
  (your line wins on a genuine conflict) and keeps the cursor on the line you were on.

Save with `:w`; quit with `:q` (`:wq`/`:x` to do both). It needs an interactive
terminal and respects `DUCKIES_FILE`. Runs alongside `pnpm start` (that's the point).

### Per-session view window

Every managed session opens with this editor as its **first window** (`duckies`),
already scoped to that session: `pnpm duckies --session <label>`. The buffer is the
session's blocks **compiled across every `*.dk` file** (a label can appear in
more than one — they're merged into one queue), shown verbatim with all status
markers, notes, and in-block comments. It syncs both ways — the supervisor's marker
writes fold in live, and `:w` writes your edits back into the exact source file each
block came from (new blocks go to the first file that holds the label). A worktree
session gets the same view of its own block, compiled with the parent repo header as
a context line (its block is indented, so the header keeps the buffer parseable and
shows where the worktree lives); edits write back to just the worktree's own lines.

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

## The `.dk` files

The supervisor picks up **every** `*.dk` file in `~/.config/duckies/duckspaces` and merges them
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
  - an **alias** listed in `~/.config/duckies/aliases.yaml` → its mapped path, tmux session
    `__<alias>`; or
  - a **path** (`/abs`, `~/…`, or anything containing `/`) → that dir, with the
    label/tmux name taken from its basename (e.g. `~/projects/moonbase` →
    `__moonbase`). Use this to point sessions anywhere on disk; or
  - a **bare name** → dir `~/_dev/<name>`, tmux session `__<name>`.

  A header may also carry a `:<worktree>` suffix (`<repo>:<feature>`) — the
  concatenated [worktree](#the-duckies-files) form, equivalent to nesting a bare
  `<feature>` line under the `<repo>` header but without the extra indent. The part
  before the `:` resolves by the three rules above; a colon inside a known alias key
  is left intact rather than split.

  A leading `!` on the header (e.g. `!moonbase`) means **show it now**: the
  supervisor switches your attached tmux client to the session immediately —
  regardless of the queue — then strips the `!` (a one-shot request). The name/path
  resolves from the header without the `!`. This is the eager cousin of a queued
  `show` line (below).

  A leading `?` on the header (e.g. `?moonbase`) means **sleep**: the supervisor
  tears down that session's tmux session but **keeps its tracked conversation ids**,
  and won't respawn it while the `?` is there. Remove the `?` and it comes back,
  `--resume`-ing the same conversation(s) (see [Conversation resume](#notes)). Unlike
  `!`, the `?` is a **persistent toggle** — duckies leaves it in the file for you to
  flip. Sleep **cascades** to the worktrees nested under that header, so `?moonbase`
  parks the repo and all its worktrees at once — but only the ones under *that*
  occurrence: if the same repo appears in another block without a `?`, that block's
  worktrees stay awake. A `?` on a worktree label alone sleeps just that worktree. A
  slept worktree's tree is left on disk so a wake reopens it in place. Use it to park
  sessions you don't want running right now without losing their context or queued work.
- `prompt: …` lines (`: …` is shorthand) and `$command` lines under a session form
  **one queue** that drains **bottom-to-top**, **one item at a time in file order**
  (oldest at the bottom; append new work at the top). An item runs only once the
  item **below** it — whether a prompt or a command — has finished, so the two
  never overlap and their relative order is exactly their order in the file.
- `prompt:` lines run in the **claude pane**; the supervisor marks one `[EXECUTING]`
  and advances it to `[DONE]` when Claude signals it finished (the hook's Stop
  event). `[NEEDS ATTENTION]` replaces the marker when Claude blocks waiting for
  input mid-task — or, with `TYPESAFE_API_KEY` set, when a turn *ends* but its final
  message reads as waiting on you (a question or follow-ups pending a go-ahead; see
  [Env overrides](#env-overrides)); answering it (submitting a prompt into the pane)
  flips it back to `[EXECUTING]`. `[WAITING]` marks a turn that has ended but left **backgrounded
  tasks running** (e.g. a `/watch-pr-comments` loop polling CI): the pane's `· N
  shells` indicator tells duckies a `<task-notification>` will resume Claude on its
  own (no hook fires), so the item is held — not latched `[DONE]`, and the next
  queued item is not dispatched into a pane that's about to wake. It oscillates
  `[WAITING]`↔`[EXECUTING]` as the loop wakes, and settles to `[DONE]` only once the
  background work clears.
- **One-line summary (`->`).** When a `:` prompt finishes, duckies mirrors a one-line
  recap of the turn into the file just below the prompt, prefixed with `-> ` (at the
  marker's indent). Every duckies-launched Claude is asked — via a combined system-prompt
  file passed at spawn (`--append-system-prompt-file`, folding in your own base prompt from
  `DUCKIES_SYSTEM_PROMPT_FILE` so it isn't clobbered) — to end each turn with a `-> …` line;
  duckies reads that line from the transcript and writes it back, so the recap survives even
  after the `[DONE]` marker is stripped as the frontier moves on. It's inert (never re-runs,
  isn't a worktree). No `-> ` line in Claude's reply ⇒ nothing is written.

  ```
  myrepo
  	: add a health-check endpoint and a test
  		[DONE]
  		-> added /healthz + a passing test
  ```
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
- `$command` lines run **once** in the session's **shell window** (a separate window
  from the claude pane; the windows are `duckies` view, `claude`, then `shell`). A
  command is marked `[EXECUTING]` when dispatched and only
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
  Delete all of a lane's lines and its extra windows (`claude<N>`/`shell<N>`) are torn down
  on the next tick — the session and its other lanes stay alive; only that lane goes.
- **Worktrees.** An indented line that *isn't* a sigil (`:`/`$`/`@`/`#`/`show`) names a
  **git worktree** of its session's repo. Items indented **below** it run in that worktree
  — it's its own session (own tmux windows, own Claude), created on demand the first time it
  has work: `git worktree add --detach` at `<repo>/../<repo>-worktrees/<name>` (a detached HEAD off
  the repo's current commit). Its tmux session is `__<repo>-<name>` (the repo's label
  prefixed onto the worktree name), so it sorts next to the repo's own `__<repo>` and two
  same-named worktrees under different repos never clash. A leading `!` on the line means
  "switch to it now", just like on a repo header. Removing the line tears the worktree down
  with its tmux session: the supervisor `git worktree remove --force`s it. Like the tmux kill
  this is unconditional — uncommitted or untracked changes in the worktree are discarded — so
  commit or move anything worth keeping first. Once a repo's last worktree goes, its now-empty
  `<repo>-worktrees` folder is removed too. The removal runs **in the background** (it scans the
  whole tree, so it would otherwise stall every session's tick) — removals are serialized per
  base repo but parallel across repos, and a delete-then-re-add waits for the pending removal
  rather than racing git's lock. A worktree line with no children is inert.
  - If the base **isn't a git repo** (a plain labeled directory), it can't be worktree'd, so
    the same `<base>-worktrees/<name>` path is instead a **symlink to the base** — the session
    runs directly on the original files (no isolation; `worktree/copy`/`worktree/cmd` setup is
    skipped). Removing the line just unlinks the symlink, leaving the base untouched.

  ```
  superapp
  	: task on the main checkout
  	feature-x                       ← worktree ../superapp-worktrees/feature-x, tmux __superapp-feature-x
  		: try the risky refactor here
  		$ pnpm test
  	feature-y                       ← a second, independent worktree + Claude (__superapp-feature-y)
  		: try a different approach
  ```
  - **Concatenated form.** A column-0 header `<repo>:<worktree>` is the *same* worktree
    session as the nested form above, just without the extra indent — its items sit one level
    under it instead of two. The `<repo>` part resolves like any header (alias / path / bare
    name) and supplies the worktree's base; the leading `!`, the `__<repo>-<name>` tmux
    identity, and the base repo's `worktree/copy`/`worktree/cmd` setup all behave identically.
    These two are equivalent:

    ```
    superapp                          superapp:feature-x
    	feature-x               ≡     	: try the risky refactor here
    		: try the risky refactor here
    ```
- `#…` lines are **comments**, and an **indented** one is also a **barrier**: the drain
  halts when it reaches it until you delete the line — put one below the
  work you want to stop (the bottom-most item runs first, so a `#` at the very bottom
  blocks the whole session). A plain `#` is **global** — it halts *every* lane, so a
  `:2`/`:3` prompt with a `#` below it is blocked too; a **numbered** `#2`/`##` halts only
  that lane, letting the others drain past. A **column-0** `#` is a plain comment (no queue to halt) —
  handy for notes/outlines between sessions. Either way it's never a session, task, or
  marker, and round-trips verbatim. (Only a line that *starts* with `#` counts; a trailing
  `#` is part of a prompt/command's text.)
- A bare `show` line is a **queue item** that brings the session **on screen**: when
  the drain reaches it (the item below it is done), the supervisor switches your
  attached tmux client (e.g. the terminal you have open in WezTerm) to it, then
  deletes the `show` line — a one-shot request, ordered like everything else in the
  queue. If the session isn't running yet it's spawned first, then shown when its
  turn comes.
- A bare `%` line is a **queue item** that **collapses its lane's completed run**: when
  the drain reaches it (everything below it in the lane has run), the supervisor deletes
  every `prompt`/`$command` below it in that lane — along with itself — leaving only the
  work above it. It's lane-scoped like the other sigils: `%`/`%1` clears lane 1, `%%`/`%2`
  clears lane 2, and so on; a `%2` leaves lane 1 (and every other lane) untouched. Use it
  to keep a session tidy — the old `[DONE]` pile below the mark clears itself once it's run.
  If clearing empties a **live** label entirely, the label itself is then removed (a worktree
  cascades up to remove its now-empty repo), so a `%` at the top of a worktree cleans the whole
  thing away when its work is done. Idle or never-spawned empty headers are left in place.
- A **`DUCKIES: …`** line asks a background Claude to **edit the `.dk` files themselves** (e.g.
  `DUCKIES: remove every idle lane here`) — it's a one-shot meta-command, not a queue item. See
  [DUCKIES directives](#duckies-directives) below.
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
| Add an indented `#` line | Halts the drain there (a barrier / comment) until you delete it — a plain `#` halts every lane, a numbered `#2`/`##` only that lane; a column-0 `#` is just a comment |
| Add a `show` line | When the queue reaches it, switches your attached tmux client to this session, then deletes the line |
| Add a `%` line (`%`/`%%`/`%N`) | When the drain reaches it, deletes that lane's completed `prompt`/`$command` lines below it — and itself — collapsing the finished run |
| Add a leading `!` to a session header | Switches your attached tmux client to this session immediately (queue-independent), then strips the `!` |
| Add a leading `!` at the start of any item line (or its marker, or a `|` body line → the parent prompt) | Reveals that item's window immediately — the shell for a `$command`, the claude pane for a prompt — then strips the `!` |
| Delete all prompts under a session (keeping the header / other lines) | Sends `/clear` (session stays alive, idle) |
| Delete all of a numbered lane's lines (`:N`/`$N`) | Tears down that lane's `claude<N>`/`shell<N>` windows and state — the session and its other lanes stay alive |
| Empty a **live** label completely (no lines left under it — e.g. via `%`) | Removes the label itself; a finished worktree cascades up to remove its now-empty repo too. Idle/never-spawned empty headers are left alone |
| Delete the session name | Kills the tmux session — and, for a worktree, `git worktree remove --force`s it too (uncommitted changes discarded) |
| Answer a `[NEEDS ATTENTION]` prompt | Type directly into the tmux; the marker flips back to `[EXECUTING]` on submit, then `[DONE]` when Claude finishes |
| Type a prompt straight into the claude pane | Mirrors it back into the file as a new `:` row (marked `[EXECUTING]` → `[DONE]`) — see below |
| Run a command straight in the shell window | Mirrors it back into the file as a finished `$` row (`[DONE]`) — see below |

Each spawned session has **two windows**: window `claude` (driven by the
controller) and window `shell` (a free shell for you to run commands in). The
claude pane is tagged with a pane-scoped tmux option (`@duckies = claude`), so
prompts always target it regardless of which window/pane is focused.

Attach to a session with `tmux attach -t __<label>` (switch windows with your
tmux prefix + `n`/`p`).

### Capturing what you type

The `.dk` file isn't one-way. When you type a prompt **directly** into a
controlled `claude` pane, or run a command **directly** in its `shell` window,
duckies mirrors that back into the file so the session's log stays complete —
whether the work came from the file or from your hands.

- The row is added as the session's **newest** already-run/running item: inserted
  just above the lane's frontier (its single marker), which moves onto your new
  row — `[EXECUTING]` for a live prompt (then tracked to `[DONE]` like any prompt),
  or `[DONE]` for a finished command. Anything already queued **above** the
  frontier stays pending and resumes once your prompt finishes.
- A command that finishes while a prompt is still `[EXECUTING]` (the two panes run
  at once) is logged **below** that prompt without disturbing it.
- duckies knows its **own** sends (they fire the same hooks), so only input *you*
  typed is captured — never the prompts/commands the controller dispatched.
- Numbered lanes are preserved: typing into `claude2` writes a `:2` row, a command
  in `shell2` writes a `$2` row.

This relies on the shell command-completion hook (for `$` capture) and the
`UserPromptSubmit` hook (for `:` capture) that `pnpm setup` installs. Prompt
capture works immediately; command capture applies to shell windows started
**after** re-running setup (existing panes keep the old hook until they re-source
their rc / are recreated).

## Usage examples

All of these are just text you put in a `.dk` file while `pnpm start` runs.
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
first time a lane needs them. A leading `!` on any line reveals *that* lane's pane.

### Comment or block with `#`

Any row starting with `#` is comment-styled and never runs. A **column-0** `#` is a
plain note (it sits between sessions). An **indented** `#` is also a **barrier** — the
drain stops there until you remove it. Since the queue drains bottom-to-top, a `#` below
an item blocks that item (and everything above it); a `#` at the very bottom freezes the
whole session. A plain `#` blocks **every lane** (a `:2`/`:3` prompt above it waits too);
number it (`#2`/`##`) to block just that lane:

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

A leading `!` on the **header** instead switches **immediately**, regardless of
the queue, then strips itself — the "look at this one right now" button:

```
!moonbase
	: something just broke — look now
```

A leading `!` at the start of **any item line** reveals *that item's* window
right away: the shell window for a `$command`, the claude pane for a prompt. The `!`
strips itself once shown, and reads well when you're pointing at a line
(`!$ tail -f build.log`, `!moonbase`, `!feat`):

```
moonbase
	: crunch through the migration
	!$ tail -f build.log
	: warm up the caches
```

(The same `!` also works at the start of an item's status marker, e.g. `![EXECUTING]`, and
at the start of a `|` multiline body line — `!| …` reveals the **parent prompt's** pane.)

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
that matches `~/.config/duckies/aliases.yaml` uses the mapped path. See the aliases section.

## Editor syntax highlighting

`.dk` grammars for three editors, all mirroring `parse()` in `duckies.ts`:

- **Sublime Text** — `duckies.sublime-syntax` (drop into `Packages/User`). Drop
  `duckies.tmPreferences` in alongside it so `toggle_comment` (`Cmd`/`Ctrl`+`/`)
  comments rows out with `#`. For the green **macro** / blue **command** styling, copy
  `duckies.sublime-color-scheme`, rename it to match your active color scheme (e.g.
  `Mariana.sublime-color-scheme`), and place it where Sublime will merge it — in
  `Packages/User` if your scheme is built-in, or in its own package folder (e.g.
  `Packages/duckies/`) if your scheme itself lives in `Packages/User`. `pnpm setup` also
  installs a **reveal plugin** (`duckies_reveal.py` + `duckies.sublime-commands`): run
  *"Duckies: Reveal this line's pane"* from the command palette to add a leading `!` to the
  current line and save — one click to bring that item's pane on screen.
- **Neovim / Vim** — `editors/nvim/` (`syntax` + `ftdetect` + `ftplugin`). Symlink or
  copy the three `duckies.vim` files into the matching dirs under `~/.config/nvim/`;
  filetype detection and highlighting then load automatically. Status markers render
  white-on-red (override with `hi duckiesStatus …`).
- **VS Code** — `editors/vscode/` (a TextMate-grammar extension; colors follow your
  theme). See its `README.md` to install from source or package a `.vsix`.

## Notes

- Permissions: launched Claudes inherit your global bypass setting
  (`skipDangerousModePermissionPrompt`); the supervisor does nothing about them.
- Identity: each Claude launches with `DUCKIES_LABEL`/`DUCKIES_STATE` exported; the
  hooks inherit these and write `state/<label>.json`, which the loop reads (using
  the file's mtime as the event time).
- Missing `~/_dev/<label>` ⇒ the session is annotated `[NO DIR …]` and skipped.
- The loop is the sole writer of markers; it computes changes, writes each file,
  then runs tmux actions, and defers if you edit any `.dk` file mid-tick.
- A label appearing in multiple files (or twice in one) is merged into a single queue,
  its rows concatenated in filename order; each marker writes back to its own file, and
  session-level state (dir, `[NO DIR …]`, a header `!`) comes from the first file.
- Conversation resume: the supervisor tracks each lane's Claude conversation id (persisted
  in `state/controller.json`) and, when it has to (re)spawn a session that isn't live — e.g.
  you add a prompt after a reboot killed the tmux session — relaunches with `claude --resume`
  so the prompt lands in the **same conversation**, not a fresh one. `/resume`-ing a different
  conversation inside the pane is followed automatically (the next hook reports the new id).
  Deleting the whole session block (a teardown) drops the tracked id, so re-adding it starts
  fresh. Only applies to `claude` agents; a custom `DUCKIES_AGENT_CMD` launches as-is.

## Repo aliases (`~/.config/duckies/aliases.yaml`)

Optional. A YAML map of `label: path`, so a header in a `.dk` file can be a
short label instead of a full path. `~` expands to your home dir; the label
becomes the tmux session name. Copy `duckies-aliases.example.yaml` to
`~/.config/duckies/aliases.yaml` to start.

```yaml
moonbase: ~/projects/moonbase
infra: ~/work/infra-monorepo
```

The file is re-read every tick, so alias edits take effect without a restart. A
header that isn't a listed alias falls back to the path / bare-name rules above.

### Per-repo worktree setup

Give an alias the **object form** to run setup when a [worktree](#the-duckies-files) of that
repo is first created (right after `git worktree add`; inherited by nested worktrees):

```yaml
webapp:
  dir: ~/projects/webapp
  worktree/copy:            # files/dirs copied in from the base repo (relative paths) —
    - .env                  # for things git doesn't track but setup needs
    - .env.local
  worktree/cmd:             # shell commands run in the new worktree, in order
    - pnpm install
    - direnv allow
```

`worktree/copy` runs first (a missing source warns and is skipped), then the session spawns and
`worktree/cmd` is typed into its own tmux **shell** window — the commands run in the real pane,
so you can watch them and they get that shell's full env (PATH, asdf/nvm/direnv). Both are
skipped in `--dry-run`. Queued `$commands` wait out the boot grace, so they land after setup.

## Macros (`~/.config/duckies/macros.yaml`)

Optional. A YAML map of `name: |<multiline block>`, so a `@name` line on its own in a
`.dk` file runs a reusable block of rows. Copy `duckies-macros.example.yaml` to
`~/.config/duckies/macros.yaml` to start.

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

Steps run **bottom-to-top**, like every duckies queue — the block's **last** line runs
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

## Templates (`~/.config/duckies/templates.yaml`)

Optional. A YAML map of `name: |<multiline block>`, like macros — but a `>name args` line
is a **paste**, not a background item. When the supervisor sees one it **physically replaces
that line** in the `.dk` file with the template's body, so the injected rows become ordinary,
**visible, editable** queue items. Copy `duckies-templates.example.yaml` to
`~/.config/duckies/templates.yaml` to start.

```yaml
handle-pr: |
  : /handle-pr-comments {0}
  $ gh pr checkout {0}
```

Type `>handle-pr 2011` under a session and the next tick rewrites it in place to:

```
myrepo
	: /handle-pr-comments 2011
	$ gh pr checkout 2011
```

This is the difference from a **macro** (`@name`): a macro keeps its one `@name` line and
expands **in memory**, running its steps silently under a single marker; a template leaves
**real rows** behind that you can see, reorder, or delete — then drain and get markers like
anything you'd typed by hand.

- **Any level.** Author the body with ordinary YAML indentation (spaces are fine) — duckies
  re-indents it to the `.dk` tab convention (one tab per level) and prefixes the call's own
  indent, so the same template pastes correctly at **top level**, under a **label**, or under a
  **worktree**. Indent a row further than its parent to nest it one level deeper — a template can
  even inject a whole worktree block with its own queued work.
- **Still bottom-to-top.** The pasted rows are plain `.dk` content, so they drain
  bottom-to-top like everything else — put the first thing to run at the **bottom** of the
  body, and add an indented `#` barrier row to hold the injected work back until you delete it.
- **Arguments** work exactly like macros: `>review 2500 "auth refactor"` fills `{0}`/`{1}`/`{*}`
  (0-based, quote to keep spaces, missing = blank).
- An **unknown** `>name` is left untouched (a typo stays a visible inert line). A name char must
  follow the `>`, so a `->` note or a `>` inside a prompt is never a call — the call is the whole line.

## Widgets (`~/.config/duckies/widgets.yaml`)

Optional. A **status display**, defined like a macro but with a **list of commands** and
a refresh **interval**. A `&name` line on its own in a `.dk` block runs those commands and
mirrors their combined stdout back into the file, indented below the line as `| `-prefixed rows.
A single `&` runs the commands **once** (a one-shot capture); doubling the sigil to `&&` makes it
**live** — duckies reruns it every `interval` ms:

```yaml
pr:
  interval: 10000
  commands:
    - gh pr view --json title,state,reviewDecision --jq '.title + "  " + .state'
    - gh pr checks
```

Drop `&pr` under a session for a one-off capture, or `&&pr` to keep its output fresh.
**Single-line** output renders **inline** on the widget line; **multi-line** output renders as a
`| ` block below it:

```
myrepo
	&pr: Add widgets  OPEN  ✓ all checks passing
	&&deploy
		| staging   ✓ live   v1.2.3
		| prod      ⏳ rolling out
```

Unlike a macro, a widget is **not** a queue item — it never drains, never blocks a lane, and
gets no `[DONE]` marker; it's just a readout. Commands run in the session's dir via `fish -c`
(each capped at 15s), and the output is rewritten only when it actually changes. A one-shot (`&`)
runs a single time and is never rerun after; a live (`&&`) widget's refresh interval is floored
at the ~1s tick. Because the block form is `| `-prefixed and terminal escapes (colors,
hyperlinks) are stripped, arbitrary output — even lines that look like `> prompt` or a worktree
header — round-trips as inert plain text.

A leading **`!`** forces a **single refresh now** — `!&pr` reruns the widget once this tick,
whatever the gate would otherwise say, and the `!` is consumed (like a `!` on a prompt). Handy to
kick a stale one-shot without deleting and re-adding it.

**Arguments** work exactly like macros: `&pr 2500` (or `&&pr 2500`) fills `{0}`/`{*}` in the commands. The
widgets file is per-machine, like `~/.config/duckies/aliases.yaml` / `macros.yaml`.

## DUCKIES directives

A line starting with **`DUCKIES:`** asks a **background Claude to edit the `.dk` files
themselves** — a self-referential meta-command for tidying and reshaping the control files without
leaving your editor. It's the one line whose "work" is the dashboard, not a repo.

```
moonbase
	: some pending task
		[EXECUTING]
	feature-x
		: risky refactor
			[DONE]
	DUCKIES: remove every idle lane here
```

When duckies sees a new `DUCKIES:` line it spawns a **visible tmux window** running `claude`, told
**where the line is** — the file and line number and the session block it sits under — so words like
*here*, *this*, or *this worktree* resolve. The window lives in a dedicated **`__duckies-agent`**
tmux session (one window per running directive); the agent's cwd is a dedicated **agent directory**
whose `CLAUDE.md` explains the `.dk` format and the task contract, with the control dir added so
it can edit the files. It does the edit, then duckies mirrors its `-> ` summary just below the
directive — exactly like a finished prompt:

```
	DUCKIES: remove every idle lane here
		-> removed 2 idle lanes
```

That `-> ` note is the **done-marker**: the directive runs **once** and isn't re-run while the note
is there — **delete the note to run it again** (just like deleting a `[DONE]` re-runs a lane). Some
things you might write:

```
DUCKIES: move this worktree to a new file this-worktree.dk
DUCKIES: remove every idle lane here
DUCKIES: remove low-importance commands and prompts here that are already processed
```

**The window stays open.** After the directive finishes, its `__duckies-agent` window is **kept
alive as a live conversation** — switch to it (`!DUCKIES:`, below) and keep prompting the same agent.
It's torn down only once it's sat **idle for an hour** (`DUCKIES_AGENT_IDLE_MS`); any new prompt in
the window resets that timer. Deleting the `DUCKIES:` line also tears its window down at once.

Prefix a **`!`** (`!DUCKIES: …`) to **switch to the agent's window** as soon as it's up, so you can
watch it work — the eager cousin of a queued reveal. The `!` is consumed (stripped) once it fires.

A directive can sit **anywhere** — indented under a session/worktree (so *here*/*this worktree*
resolve to that block), or at **column 0** as a top-level, file-wide directive:

```
DUCKIES: sort the sessions and drop every finished block
	-> sorted; dropped 4 done blocks

app
	: real work
```

A top-level directive's agent window and state are keyed by the **control file's name** (e.g.
`app.dk` → `app`); its `-> ` note lands one tab in, just below the line.

Notes:

- It's **not a queue item**: it never joins a session's prompt/command queue or blocks a lane, and a
  block that holds *only* a `DUCKIES:` line doesn't spawn that session — the agent runs in its own
  `__duckies-agent` window regardless.
- `DUCKIES:` is **case-sensitive**, so ordinary prose (or a `duckies:` in a prompt body) never trips it.
- The agent runs with `--permission-mode bypassPermissions` by default (it can't stop to answer
  approval prompts). It acts on your control files autonomously — keep directives scoped to
  file-tidying, which is what its `CLAUDE.md` steers it toward. See the env overrides to change the
  permission mode, model, agent dir, or timeout.

## Env overrides

- `DUCKIES_DIR` — scan a different directory for `*.dk` files instead of `~/.config/duckies/duckspaces`.
- `DUCKIES_FILE` — single-file mode: watch exactly this one file (ignores the `*.dk` scan).
- `DUCKIES_CONFIG_DIR` — where aliases/macros/widgets/templates are read from; default `~/.config/duckies`.
- `DUCKIES_ALIASES` — read aliases from a different file instead of `~/.config/duckies/aliases.yaml`.
- `DUCKIES_MACROS` — read macros from a different file instead of `~/.config/duckies/macros.yaml`.
- `DUCKIES_WIDGETS` — read widgets from a different file instead of `~/.config/duckies/widgets.yaml`.
- `DUCKIES_TEMPLATES` — read templates from a different file instead of `~/.config/duckies/templates.yaml`.
- `DUCKIES_DEV_DIR` — where a bare session name resolves (`<dir>/<name>`); default `~/_dev`.
- `DUCKIES_AGENT_CMD` — the command launched in each claude pane; default `claude` (point it at
  a wrapper or a different agent CLI). Also used for the `DUCKIES:` agent window.
- `DUCKIES_AGENT_DIR` — cwd (and `CLAUDE.md` location) for the `DUCKIES:` agent; default `./agent`.
- `DUCKIES_AGENT_PERMISSION_MODE` — the `DUCKIES:` agent's `--permission-mode`; default
  `bypassPermissions` (it can't stop to answer approval prompts).
- `DUCKIES_AGENT_MODEL` — optional `--model` for the `DUCKIES:` agent; default: the CLI's own default.
- `DUCKIES_AGENT_IDLE_MS` — how long a finished `DUCKIES:` agent window is kept alive before it's torn
  down for inactivity; any new prompt in it resets the timer (default 3600000 = 1h).
- `DUCKIES_TERM_APP` — macOS only, opt-in: the terminal app to bring to the foreground on a
  `show`/`!` (e.g. `WezTerm`, `iTerm`, `Terminal`). Unset ⇒ no app foregrounding (the tmux
  client still switches). Ignored off macOS.
- `DUCKIES_READY_MS` — boot grace before the first prompt is sent (default 6000).
- `DUCKIES_TUI` — set to `0` to disable the interactive supervisor view (notifier + log strip) and fall
  back to a plain scrolling log. Also auto-disabled when stdout isn't a TTY.
- `DUCKIES_EDITOR` — the command the supervisor view opens `.dk`/config files with (`h`, and the `m`
  menu's edit items); default `subl`. It receives the `<file>[:line]` target as its final argument, e.g.
  `DUCKIES_EDITOR="code --goto"`.
- `TYPESAFE_API_KEY` — enables the Jev attention check: when a Claude turn ends cleanly, its final
  message is judged by [TypeSafe](https://typesafe.ai)'s Jev model, and if it reads as *waiting on
  you* (a question, follow-ups pending a go-ahead, a blocked/needs-a-decision ending) the lane is
  flagged `[NEEDS ATTENTION]` and held instead of draining to `[DONE]`. A missing key, an error, or
  a timeout falls back to plain `[DONE]`, so an outage never stalls the queue.
- `DUCKIES_JEV_ATTENTION` — set to `0` to disable the Jev attention check even when a key is present.
- `DUCKIES_JEV_THRESHOLD` — yes-probability cutoff for the flag (default `0.6`; higher ⇒ fewer flags).
- `DUCKIES_JEV_TIMEOUT_MS` — how long the Jev call may take before falling back to `[DONE]` (default 6000).
- `DUCKIES_JEV_MODEL` — optionally pin a Jev model; default: the SDK's own default.
- `DUCKIES_SUBLIME_DIR` — (setup only) override Sublime's `Packages/User` dir the syntax is
  copied into.

## Test

```sh
pnpm test         # parser round-trip + reconciler unit tests
pnpm type-check
```
