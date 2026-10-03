// Run the herald supervisor, relaunching it whenever it exits with the restart sentinel
// (RESTART_EXIT = 97, written by `nr restart` → state/restart, consumed in herald.ts). Because
// `tsx` re-reads the source on each launch, this is how a code change is picked up WITHOUT a manual
// restart — and it stays one instance in the same terminal (the child inherits this TTY), so no
// rogue copy is ever started. Any other exit (clean quit, Ctrl-C, a crash, a type error) propagates
// and stops the loop, so a broken build can't spin-restart. `nr start` runs this; pass-through argv
// reaches herald.ts, and `nr dry-run` bypasses it (it runs herald.ts directly).
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RESTART_EXIT = 97

for (;;) {
	const r = spawnSync('tsx', [join(HERE, 'herald.ts'), ...process.argv.slice(2)], { stdio: 'inherit', cwd: HERE })
	if (r.status !== RESTART_EXIT) process.exit(r.status ?? 0)
	console.log('[herald-run] restart requested — relaunching on current source')
}
