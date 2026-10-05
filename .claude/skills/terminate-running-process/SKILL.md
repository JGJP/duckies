---
name: terminate-running-process
description: Before doing anything that could disrupt (or be disrupted by) the live duckies supervisor loop, stop that process first. Trigger when editing duckies.ts / setup.ts, the .dk control files, or state/, and when running the supervisor or tests while an instance may already be running.
---

This project's supervisor (`pnpm start` → `tsx duckies.ts`) runs as a **watch loop**:
every second it reads every `*.dk` control file, rewrites them in place (status
markers), and drives tmux — spawning/killing `__<label>` sessions and sending
keystrokes into panes. If it's live while you work, it will fight you: overwrite
your edits to a `.dk` file, act on half-finished code, or race your own test run.

**So: if you're asked to do something that might mess up (or be messed up by) a
running instance, terminate it before working.** Then do the work, and only
restart it when you (or the user) explicitly want it live again.

## When this applies

- Editing `duckies.ts`, `setup.ts`, or the reconcile/parse/queue logic.
- Editing a `.dk` control file by hand, or inspecting/clearing `state/`.
- Running the supervisor yourself (`pnpm start`, `pnpm dry-run`) or `pnpm test`.
- Restructuring tmux sessions the supervisor manages (`__*`).

A read-only task (just reading files, answering a question) does **not** need this.

## Steps

1. **Check** whether the supervisor is running (ignore `--dry-run`, which is a
   one-shot). The live process runs under tsx as `node …/tsx/…/cli.mjs duckies.ts`,
   so match the tsx-launched script — a plain `'tsx duckies.ts'` gives a false
   negative:

   ```sh
   pgrep -fl 'tsx.*duckies\.ts' | grep -v -- '--dry-run'
   ```

2. If it's running, **tell the user you're stopping it** and terminate it:

   ```sh
   pkill -f 'tsx.*duckies\.ts'
   ```

   Confirm it's gone (re-run the `pgrep`). Prefer this over `kill -9` so it exits
   cleanly mid-tick.

3. **Do the requested work** now that nothing is racing you.

4. When finished, note that the supervisor was stopped. Restart it only if the
   user asked you to, or asked you to leave it running:

   ```sh
   pnpm start
   ```

Don't kill the `__<label>` tmux sessions themselves unless that's the actual task
— they hold live Claude conversations. Only the supervisor loop needs to stop.
