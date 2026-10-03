# herald

## Never leave the supervisor running

Do **not** start the herald supervisor for the user — `nr start` / `pnpm start` /
`tsx herald.ts` (and don't background it). The user runs it themselves in their own terminal
for real work. A copy started by Claude runs the **old** code (tsx doesn't hot-reload) and
lingers for hours, clobbering the real instance's `state/` files and driving their live tmux
sessions. This has caused real annoyance — assume the answer is "no, the user will start it."

The **only** exception is when a development task genuinely requires running it to verify a
change. Even then:

- Prefer non-invasive checks first: `nr test`, `nr type-check`, and `nr dry-run`
  (`--dry-run` doesn't touch live sessions).
- If you must run the real supervisor, run it briefly and **stop it (kill the process) the
  moment you're done** — never leave it alive at the end of a turn.

Before editing `herald.ts` / `setup.ts` / the `.herald` control files / `state/`, check for a
running supervisor and stop it first (see the `terminate-running-process` skill).

## Restarting the supervisor after a code change (you MAY do this)

`tsx` doesn't hot-reload, so after you edit `herald.ts` (or anything it imports) the user's
running supervisor keeps executing the **old** code until it's relaunched. You may trigger that
relaunch yourself — this does **not** contradict the rule above, because it only nudges the
user's **existing** instance to re-exec; it never starts a new one.

Mechanism (built in `herald-run.ts` / `herald-restart.ts`):

- `nr start` runs the supervisor under a wrapper that relaunches it whenever it exits with the
  restart sentinel. The user must be running it this way for a restart to take — a pre-wrapper
  instance (e.g. one started with a bare `tsx herald.ts`) won't relaunch, so it needs one manual
  restart to adopt the wrapper.
- `nr restart` type-checks, then writes `state/restart`; the running supervisor consumes it at its
  next tick (≤1s) and re-execs on the current source, leaving tmux sessions up. If no supervisor
  holds the lock it's a safe no-op (it does **not** start one).

So the workflow after changing supervisor code: `nr type-check` + `nr test`, then **`nr restart`**
to make the change live. Still never run a bare `tsx herald.ts` / `nr start` yourself to "apply"
a change, and never leave an instance you started alive at the end of a turn.
