// Non-interactive snapshot of the notifier board: the same lanes the supervisor's
// dashboard shows (NEEDS ATTENTION / DONE / EXECUTING / WAITING), grouped and printed as
// plain text so it can be piped, messaged, or read over a wire. Reuses the SAME parse +
// readLanes the supervisor uses, so it can't drift from the live view.
//
//   tsx duckies-status.ts            # human-readable board
//   tsx duckies-status.ts --json     # machine-readable {attention,done,running} lane lists
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { controlFiles, loadAliases, loadMacros, loadWidgets, parse } from './duckies'
import { dismissKey, readLanes, Store, type Lane } from './duckies-notify'

const STATE = join(dirname(fileURLToPath(import.meta.url)), 'state')

function lanes(): Lane[] {
	const aliases = loadAliases()
	const macros = loadMacros()
	const widgets = loadWidgets()
	const parsed = controlFiles().map((f) => {
		try {
			return { file: f, sessions: parse(readFileSync(f, 'utf8'), aliases, macros, widgets).sessions }
		} catch {
			return { file: f, sessions: [] }
		}
	})
	return readLanes(parsed, STATE)
}

// Show only lanes the supervisor's board shows as active — drop the ones the human
// has dismissed, snoozed, or put to sleep (same filter as the menu's `active` set).
const store = new Store(join(STATE, 'notify.json'))
const now = Date.now()
const all = lanes().filter((l) => !l.asleep && !store.isDismissed(dismissKey(l)) && !store.isSnoozed(dismissKey(l), now))
const attention = all.filter((l) => l.status === 'ATTENTION' || l.status === 'ERROR')
const done = all.filter((l) => l.status === 'DONE').sort((a, b) => a.at - b.at)
const running = all.filter((l) => l.status === 'EXECUTING' || l.status === 'WAITING')

if (process.argv.includes('--json')) {
	const slim = (l: Lane) => ({ id: l.id, label: l.label, status: l.status, text: l.text })
	process.stdout.write(JSON.stringify({ attention: attention.map(slim), done: done.map(slim), running: running.map(slim) }, null, 2) + '\n')
	process.exit(0)
}

const clip = (s: string, n = 72) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const line = (l: Lane) => `  ${l.label}${l.pane > 1 ? `:${l.pane}` : ''} — ${clip(l.text.replace(/\s+/g, ' ').trim())}`

const out: string[] = []
out.push(`NEEDS ATTENTION (${attention.length})`)
out.push(...(attention.length ? attention.map(line) : ['  —']))
out.push('')
out.push(`DONE (${done.length})`)
out.push(...(done.length ? done.map(line) : ['  —']))
out.push('')
out.push(`RUNNING (${running.length})`)
out.push(...(running.length ? running.map(line) : ['  —']))

process.stdout.write(out.join('\n') + '\n')
