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
