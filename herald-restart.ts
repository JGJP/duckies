// Ask a running herald supervisor to relaunch on the current source (so edits to herald.ts take
// effect), by writing the sentinel it consumes at its next tick (≤1s); the `nr start` wrapper
// (herald-run.ts) then relaunches it. SAFE to run after editing — it only nudges the EXISTING
// instance and never starts one: if no supervisor holds the lock, it does nothing but say so. Run
// via `nr restart`, which type-checks first so a broken build is never restarted into.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const STATE = join(HERE, 'state')
const LOCK = join(STATE, 'supervisor.lock')

mkdirSync(STATE, { recursive: true })
if (!existsSync(LOCK)) {
	console.log('no running herald supervisor (no lock) — start one yourself with `nr start`; not starting it here')
	process.exit(0)
}
const owner = readFileSync(LOCK, 'utf8').trim()
writeFileSync(join(STATE, 'restart'), owner)
console.log(`restart requested of supervisor pid ${owner} — it relaunches on current source within ~1s (watch its terminal)`)
