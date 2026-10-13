---
name: duckies-files
description: How the duckies `*.dk` control files work and how to add prompts, commands, sessions, lanes, and worktrees to them. Use whenever asked to queue/add/edit work in a `.dk` file, or to explain the format. Key rule the user always wants respected — the queue runs BOTTOM-TO-TOP, and anything that should NOT run immediately must be held back by an indented `#` barrier row placed below it.
---

# The `.dk` files

Each `*.dk` file in `~/.config/duckies/duckspaces` is a live control file. The supervisor reads every
one of them once a second, and for each **session** drives a tmux session + a Claude Code
pane, sending queued prompts and running queued commands. It also **rewrites the files in
place** to stamp status markers (`[EXECUTING]`, `[DONE]`, `[NEEDS ATTENTION]`). So editing a
`.dk` file *is* the interface: add a line, and it gets queued and run.

Indent with **tabs** (one tab per nesting level), matching the rows already in the file.

## The two golden rules (read before editing)

1. **The queue drains bottom-to-top.** Under a session, the **bottom-most** item runs
   **first**; items above it wait until everything below them has finished. So **append new
   work at the top**, and know that a new line still runs only when its turn comes (after the
   queue below it drains).

2. **To stop something from running, block it with an indented `#` row.** A `#` line under a
   session is a **barrier**: the drain climbs up from the bottom and **halts when it hits the
   `#`**, so everything **above** the `#` is held until you delete that line. If you add work
   that should NOT execute yet, put a `#` row directly **below** it (between it and the live
   frontier). See [Holding work back](#holding-work-back-) — do this by default whenever the
   user says something is "not ready", "don't run yet", "for later", "draft", etc.

Do **not** hand-write status markers (`[EXECUTING]` / `[DONE]` / `[NEEDS ATTENTION]`) — the
supervisor owns those. Just add the sigil line; the marker appears on its own.

## Adding work

Under a session header (a column-0 line naming a repo/dir), add indented lines:

- **Prompt to Claude** — `: <text>` (or the long form `prompt: <text>`). Runs in the Claude
  pane; marked `[EXECUTING]` → `[DONE]` when Claude finishes.
  ```
  myrepo
  	: add a health-check endpoint and write a test for it
  ```
- **Shell command** — `$ <command>`. Runs once in the session's shell window; `[EXECUTING]`
  until it **exits**. A command that never exits (e.g. `$ pnpm dev`) stays `[EXECUTING]` and
  holds the lane — by design.
  ```
  myrepo
  	$ git push
  	: make the change, commit it
  ```
  (Here `git push` is above the prompt, so it runs *after* the prompt is done.)
- **Multiline prompt body** — continue a `:` line with `|` rows (paste an error/log/spec).
  The `|` and one following space are stripped; further indentation is kept.
  ```
  myrepo
  	: why is this failing?
  	| TypeError: cannot read properties of undefined (reading 'id')
  	|   at getUser (src/user.ts:42)
  ```
- **Slash commands / macros** — a prompt can be a slash command (`: /ship`). A `@name` line is
  a **macro** that expands to a saved sequence of steps (see `~/.config/duckies/macros.yaml` for the
  defined ones, e.g. `@sm`, `@gcom`).
- **Templates** — a `>name args` line (any indent) is a **template** call: the supervisor
  physically **replaces that line in the file** with the named body (see
  `~/.config/duckies/templates.yaml`), arg-filled (`{0}`/`{1}`/`{*}`) and re-indented under the call
  site. Unlike a macro (which expands in memory and runs silently under one `@name` line), a
  template leaves **real, visible rows** behind — ordinary prompts/commands/worktrees that then
  drain bottom-to-top like anything typed by hand. Use it to paste a reusable block at top level,
  under a label, or under a worktree, e.g. `>handle-pr 2011`.

## Parallel lanes

A number (or repeated sigil) routes an item to a **concurrent** lane — a *separate* Claude
conversation / shell that runs at the same time as lane 1. `::` ≡ `:2`, `$$` ≡ `$2`, `:::`/`$$$`
→ lane 3, and so on. Within a lane items still serialize bottom-to-top; across lanes they run
at once.
```
myrepo
	:2 work the frontend in a second Claude
	$$ pnpm dev            ← long-running dev server in lane 2's shell, won't block lane 1
	: work the backend in lane 1
```

## Sessions, worktrees, show

- **Session header** (column 0): an alias from `~/.config/duckies/aliases.yaml`, a path, or a bare name
  (→ `~/_dev/<name>`). A leading `!` (`!myrepo`) switches your tmux client to it now.
- **Worktree**: an indented line that *isn't* a sigil names a git worktree of the session's
  repo; items nested under it run there. If the base isn't a git repo, it's symlinked instead
  (runs on the original files). A worktree line with no children is inert.
- **Worktree, concatenated**: a column-0 header `<repo>:<worktree>` is the same worktree
  session without the extra indent — items go one level under it instead of two. These are
  identical:
  ```
  myrepo               myrepo:feat
  	feat        ≡  	: work in the worktree
  		: work in the worktree
  ```
  The `<repo>` part resolves like any header (alias / path / bare name); a leading `!` and the
  worktree's `worktree/cmd`+`worktree/copy` setup work the same as the nested form.
- **`show`**: a bare `show` queue item brings the session on screen when the drain reaches it.

## Holding work back (`#`)

This is the mechanism for "queue it but don't run it yet". Because the queue runs
bottom-to-top, a `#` barrier stops the drain from reaching anything above it.

```
myrepo
	: refactor the auth module        ← held: will NOT run while the # below exists
	# not ready — remove this line to release the task above
	: fix the login bug               ← runs first (nearest the bottom)
		[DONE]
```

Notes:
- The `#` must be **indented** (under a session). A column-0 `#` is just a plain comment, not
  a barrier.
- A `#` at the very **bottom** of a session blocks the **whole** session (nothing runs).
- Barriers are per-lane: `##` / `#2` halts only lane 2, etc.
- The `#` text is free — use it as a note ("waiting on review", "TODO", etc.). Delete the line
  when you want the held work to run.

## After editing

The running supervisor picks the file up within a second — no restart needed for content
edits. (Editing the duckies **source** — `duckies.ts`/`setup.ts` — or clearing `state/` is
different: stop the supervisor first via the `terminate-running-process` skill.)
