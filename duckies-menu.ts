// The supervisor's interactive terminal UI — the default view when `pnpm start` runs in a TTY.
// It's a full-screen (alt-screen) notifier, ported from the standalone duckies-notifier: lanes are
// grouped into NEEDS ATTENTION / DONE / EXECUTING / DISMISSED / SNOOZED / SLEEPING sections you can
// navigate and act on (focus, snooze, sleep, dismiss, clear, open). The supervisor's own scrolling
// log is shown as a short strip along the bottom; Tab expands it to fullscreen and back.
//
// Overlays layer on top: `m` opens the config/new-label menu (edit aliases/macros/widgets/templates,
// add a label); `s`/`S` open the snooze picker; a shared-session sleep asks for confirmation. The
// supervisor NEVER stops ticking while an overlay is open — only rendering changes.
//
// Wired from duckies.ts: `log()` routes through `emit()` (buffered into the log strip, never written
// straight to the screen), `refresh()` is called after each tick to repull lane state, and
// `teardown()` restores the terminal on every exit path. The data model (lanes, store, file edits)
// lives in duckies-notify.ts so it can't drift from the supervisor and stays unit-testable.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { clearLane, dismissKey, markLaneDone, readLanes, reloadLaneWidgets, revealLaneHeader, Store, toggleSleep, type Lane } from './duckies-notify'
import type { Session } from './duckies'

export interface DashboardOpts {
	colorEnabled: boolean
	// The supervisor's state dir (hook files for completion times, and where the notifier's
	// dismiss/snooze store is kept).
	stateDir: string
	controlFiles: () => string[]
	configFiles: { aliases: string; macros: string; widgets: string; templates: string }
	// Parse every control file into the same sessions the tick drives (so the view can't drift).
	parseControlFiles: () => { file: string; sessions: Session[] }[]
	// Live tmux labels (duckies's listTmux); a lane whose label isn't here has no pane to focus.
	liveSessions: () => Promise<Set<string>>
	// Focus a lane's claude pane — the supervisor's showSession for that pane.
	revealLane: (label: string, pane: number) => void
	// Switch the watching client to an existing session (for the m-menu duplicate-label reveal).
	revealSession: (label: string) => void
	// Locate an already-defined session for a typed label (resolved through aliases), so a "new
	// label" that duplicates an existing one reveals it instead of appending a clashing header.
	locateLabel: (header: string) => { file: string; line: number; label: string } | null
}

// ── log coloring (the bottom strip / fullscreen log) ───────────────────────────────────────────
// Compact log-oriented palette (256-color). Distinct from the notifier palette below — this colors
// log LINES by category, not lanes.
const LC = {
	reset: '\x1b[0m',
	bold: '\x1b[1m',
	dim: '\x1b[38;5;240m',
	grey: '\x1b[38;5;244m',
	white: '\x1b[38;5;253m',
	red: '\x1b[38;5;203m',
	yellow: '\x1b[38;5;214m',
	green: '\x1b[38;5;78m',
	cyan: '\x1b[38;5;45m',
	magenta: '\x1b[38;5;170m',
	purple: '\x1b[38;5;141m',
}

// Pick a color for a raw log message (timestamp already stripped) by its leading verb / keywords.
function categoryColor(m: string): string {
	if (/\bWARN\b|\bfailed\b|could not|refusing|incomplete|does not exist/i.test(m)) return LC.yellow
	if (/^killing|^reaping|^repairing|\bremove\b/i.test(m)) return LC.red
	if (/^spawning|worktree add|^symlink(?! remove)/i.test(m)) return LC.green
	if (/^send\b|^cmd\b|^resuming/i.test(m)) return LC.cyan
	if (/^showing|reveal/i.test(m)) return LC.magenta
	if (/^jev\b|attention/i.test(m)) return LC.yellow
	if (/duckies agent/i.test(m)) return LC.purple
	if (/widget/i.test(m)) return LC.grey
	return LC.white
}

// Colorize one log message: category color for the whole line, with the leading verb bolded.
// Returns the message untouched when color is off. Pure — unit-tested.
export function colorizeLog(msg: string, color = true): string {
	if (!color) return msg
	const c = categoryColor(msg)
	const sp = msg.indexOf(' ')
	const verb = sp < 0 ? msg : msg.slice(0, sp)
	const rest = sp < 0 ? '' : msg.slice(sp)
	return `${c}${LC.bold}${verb}${LC.reset}${c}${rest}${LC.reset}`
}

// Append `label` as a new column-0 session header at EOF — the minimal `.dk` form for a new session.
// Normalizes trailing newlines and separates from existing content with one blank line. Pure — tested.
export function appendLabel(content: string, label: string): string {
	const body = content.replace(/\n+$/, '')
	return body === '' ? `${label}\n` : `${body}\n\n${label}\n`
}

// Named key tokens decodeKeys emits that are NOT printable input (so text fields can reject them).
const NAMED = new Set(['Up', 'Down', 'Left', 'Right', 'Home', 'End', 'Delete', 'PageUp', 'PageDown', 'Tab', 'Esc', 'Enter', 'Backspace', 'C-c', 'C-r', 'C-d', 'C-u', 'C-f', 'C-b'])

// Decode a raw stdin chunk into key tokens.
function decodeKeys(buf: Buffer): string[] {
	const keys: string[] = []
	let i = 0
	while (i < buf.length) {
		const b = buf[i]
		if (b === 0x1b) {
			if (i + 1 < buf.length && (buf[i + 1] === 0x5b || buf[i + 1] === 0x4f)) {
				let j = i + 2
				while (j < buf.length && !(buf[j] >= 0x40 && buf[j] <= 0x7e)) j++
				const seq = buf.slice(i + 2, j + 1).toString()
				const map: Record<string, string> = { A: 'Up', B: 'Down', C: 'Right', D: 'Left', H: 'Home', F: 'End', '3~': 'Delete', '5~': 'PageUp', '6~': 'PageDown' }
				if (map[seq]) keys.push(map[seq])
				i = j + 1
				continue
			}
			keys.push('Esc')
			i++
			continue
		}
		if (b === 0x0d || b === 0x0a) {
			keys.push('Enter')
			i++
			continue
		}
		if (b === 0x7f || b === 0x08) {
			keys.push('Backspace')
			i++
			continue
		}
		if (b === 0x09) {
			keys.push('Tab')
			i++
			continue
		}
		if (b === 0x03) {
			keys.push('C-c')
			i++
			continue
		}
		if (b < 0x20) {
			i++
			continue
		}
		let len = 1
		if (b >= 0xf0) len = 4
		else if (b >= 0xe0) len = 3
		else if (b >= 0xc0) len = 2
		keys.push(buf.slice(i, i + len).toString('utf8'))
		i += len
	}
	return keys
}

// ── notifier palette + helpers ─────────────────────────────────────────────────────────────────
const ESC = '\x1b['
const reset = `${ESC}0m`
const dim = `${ESC}2m`
const bold = `${ESC}1m`
const fg = (r: number, g: number, b: number) => `${ESC}38;2;${r};${g};${b}m`
const bg = (r: number, g: number, b: number) => `${ESC}48;2;${r};${g};${b}m`

const C = {
	attn: `${bg(255, 204, 0)}${fg(0, 0, 0)}`,
	error: `${bg(255, 0, 0)}${fg(255, 255, 255)}`,
	done: fg(120, 220, 120),
	exec: fg(255, 121, 26),
	waiting: fg(51, 198, 255),
	label: fg(210, 210, 210),
	muted: fg(120, 120, 120),
	rule: fg(80, 80, 80),
	sel: fg(120, 220, 255),
}

const GUTTER = 2 // width of the "❯ " / "  " selection gutter every row carries
const LOG_LINES = 5 // height of the bottom log strip in the split view
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPINNER_MS = 100
const POLL_MS = 1000
const SNOOZE_OPTIONS: { label: string; ms: number }[] = [
	{ label: '15 minutes', ms: 15 * 60_000 },
	{ label: '30 minutes', ms: 30 * 60_000 },
	{ label: '1 hour', ms: 60 * 60_000 },
	{ label: '3 hours', ms: 3 * 60 * 60_000 },
	{ label: '8 hours', ms: 8 * 60 * 60_000 },
	{ label: '1 day', ms: 24 * 60 * 60_000 },
	{ label: '3 days', ms: 3 * 24 * 60 * 60_000 },
	{ label: '1 week', ms: 7 * 24 * 60 * 60_000 },
]

function truncate(s: string, width: number): string {
	const flat = s.replace(/\s+/g, ' ').trim()
	return flat.length <= width ? flat : `${flat.slice(0, Math.max(0, width - 1))}…`
}

function ago(at: number, now: number): string {
	if (!at) return ''
	const s = Math.max(0, Math.round((now - at) / 1000))
	if (s < 60) return `${s}s ago`
	const m = Math.round(s / 60)
	if (m < 60) return `${m}m ago`
	const h = Math.round(m / 60)
	if (h < 24) return `${h}h ago`
	return `${Math.round(h / 24)}d ago`
}

// A short future duration, e.g. "14m", "2h", "3d" — for a snooze's remaining time.
function dur(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000))
	if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`
	if (s < 86400) return `${Math.round(s / 3600)}h`
	return `${Math.round(s / 86400)}d`
}

const laneName = (l: { label: string; pane: number }): string => `${l.label}${l.pane > 1 ? `:${l.pane}` : ''}`

// Clip a string containing ANSI escapes to `width` visible columns, so a line can never wrap onto
// the next physical row (which would throw off the frame's line count and scroll the display). ANSI
// sequences are copied but don't count toward the width.
function clip(s: string, width: number): string {
	let outStr = ''
	let vis = 0
	let i = 0
	while (i < s.length && vis < width) {
		if (s[i] === '\x1b') {
			const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i))
			if (m) {
				outStr += m[0]
				i += m[0].length
				continue
			}
		}
		outStr += s[i]
		vis++
		i++
	}
	return `${outStr}${reset}`
}

// ── dashboard ────────────────────────────────────────────────────────────────────────────────
// Start the interactive dashboard: enter the alt screen, render the notifier view + log strip, and
// drive input. Returns `emit` (route `log()` here), `refresh` (repull lanes; call after each tick),
// and `teardown` (restore the terminal, idempotent).
export function startDashboard(opts: DashboardOpts) {
	const out = process.stdout
	const color = opts.colorEnabled
	const store = new Store(join(opts.stateDir, 'notify.json'))

	const cols = () => out.columns || 80
	const rows = () => out.rows || 24
	const now = () => Date.now()

	// A rendered lane row: its display text plus, when selectable, that lane's index in `flat`.
	interface Row {
		text: string
		sel: number | null
	}

	// ── state ──
	let sel = 0 // index into the flattened selectable-lane list
	let scrollTop = 0
	let lanes: Lane[] = []
	let flat: Lane[] = [] // selectable lanes, in display order
	let live = new Set<string>() // duckies labels with a live tmux session
	let spinnerFrame = 0
	let filter = ''
	let filtering = false
	let logFull = false // Tab: the log strip expands to fill the screen
	let showWidgets = true // `w`: echo each lane's widget output below it
	let pendingG = false // first `g` of a `gg` (jump-to-top)
	const undoStack: string[] = [] // keys of dismissals, newest last, for `u`
	const logRing: string[] = [] // formatted log lines (ts + colorized), newest last
	// Overlays (each owns input while open). `snooze` is the duration picker; `confirm` is a y/n
	// prompt; `panel` is the `m` config/new-label menu.
	let snooze: { lane: Lane; index: number; sleep: boolean } | null = null
	let confirm: { message: string[]; onYes: () => void } | null = null
	type PanelMode = 'menu' | 'pick' | 'input'
	let panel: { mode: PanelMode; sel: number; pickFiles: string[]; inputFile: string; inputText: string } | null = null

	let tornDown = false
	let renderQueued = false
	const timers: ReturnType<typeof setInterval>[] = []

	const isLive = (l: Lane): boolean => live.has(l.label)
	// Suffix noting a session with no live pane: intentionally slept (`?`) vs. just gone.
	const sessTag = (l: Lane): string => (l.asleep ? ' · asleep' : isLive(l) ? '' : ' · closed')
	const isDismissed = (l: Lane): boolean => store.isDismissed(dismissKey(l))
	const isSnoozed = (l: Lane): boolean => store.isSnoozed(dismissKey(l), now())
	const matchesFilter = (l: Lane): boolean => !filter || `${l.label} ${l.text}`.toLowerCase().includes(filter.toLowerCase())

	interface Sections {
		attention: Lane[]
		done: Lane[]
		executing: Lane[]
		dismissedLanes: Lane[]
		snoozedLanes: Lane[]
		sleepingLanes: Lane[]
	}

	function sections(): Sections {
		const src = lanes.filter(matchesFilter)
		// Asleep sessions are their own bottom category — pull them out before the status split.
		const active = src.filter((l) => !l.asleep && !isDismissed(l) && !isSnoozed(l))
		const attention = active.filter((l) => l.status === 'ATTENTION' || l.status === 'ERROR')
		const done = active.filter((l) => l.status === 'DONE').sort((a, b) => a.at - b.at)
		const executing = active.filter((l) => l.status === 'EXECUTING' || l.status === 'WAITING')
		const dismissedLanes = src.filter((l) => isDismissed(l) && !l.asleep).sort((a, b) => a.at - b.at)
		// A sleep-snoozed lane is both asleep and snoozed; surface it under SNOOZED (with its wake
		// timer) rather than SLEEPING, so only lanes slept indefinitely sit in SLEEPING.
		const snoozedLanes = src.filter((l) => isSnoozed(l) && !isDismissed(l)).sort((a, b) => (store.snoozeUntil(dismissKey(a)) ?? 0) - (store.snoozeUntil(dismissKey(b)) ?? 0))
		const sleepingLanes = src.filter((l) => l.asleep && !isSnoozed(l)).sort((a, b) => laneName(a).localeCompare(laneName(b)))
		return { attention, done, executing, dismissedLanes, snoozedLanes, sleepingLanes }
	}

	// Recompute the flattened selectable list from the current lanes/filter, clamping the cursor.
	function rebuild(): void {
		const { attention, done, executing, dismissedLanes, snoozedLanes, sleepingLanes } = sections()
		flat = [...attention, ...done, ...executing, ...dismissedLanes, ...snoozedLanes, ...sleepingLanes]
		// Hold the cursor at its position rather than following the row it was on; just clamp.
		if (sel >= flat.length) sel = Math.max(0, flat.length - 1)
	}

	// Re-pull lane state from the (freshly parsed) control files. Cheap enough to run each tick.
	function refresh(): void {
		lanes = readLanes(opts.parseControlFiles(), opts.stateDir)
		const t = now()
		// A sleep-snooze that has elapsed must wake its session back up (strip the `?`), the mirror of
		// what sleep & snooze did when it started. Do this before prune drops the entry.
		for (const l of lanes) {
			if (!l.asleep) continue
			const key = dismissKey(l)
			if (store.isSleepSnoozed(key) && !store.isSnoozed(key, t)) {
				toggleSleep(l)
				store.clearSleepSnooze(key)
			}
		}
		store.prune(new Set(lanes.map(dismissKey)), t)
		rebuild()
		scheduleRender()
	}

	// ── rendering ──
	const rule = (title: string, count: number): string => {
		const plain = `── ${title} (${count}) `
		const pad = Math.max(0, cols() - GUTTER - plain.length)
		return `${C.rule}── ${reset}${bold}${title}${reset} ${C.muted}(${count})${reset} ${C.rule}${'─'.repeat(pad)}${reset}`
	}

	const STATUS_WORD: Record<Lane['status'], string> = { ATTENTION: 'attn', ERROR: 'err', DONE: 'done', EXECUTING: 'exec', WAITING: 'wait' }

	// Non-selectable rows echoing a lane's `&name` widgets below it: a single-line output folds onto
	// the call (`&pr: 3 open`); a multi-line one is the call with each output line under a `│ ` guide.
	// Lines aren't flattened (widget output can be tabular) — blit clips them to the terminal width.
	function widgetRows(l: Lane): Row[] {
		if (!showWidgets) return []
		const out: Row[] = []
		for (const wg of l.widgets) {
			if (wg.pending) {
				const spin = `${C.exec}${SPINNER[spinnerFrame % SPINNER.length]}${reset}`
				out.push({ text: `   ${spin} ${dim}${C.muted}${wg.call} · reloading…${reset}`, sel: null })
				continue
			}
			if (wg.output.length <= 1) {
				const head = wg.output[0] ? `${wg.call}: ${wg.output[0]}` : wg.call
				out.push({ text: `   ${dim}${C.muted}${head}${reset}`, sel: null })
			} else {
				out.push({ text: `   ${dim}${C.muted}${wg.call}${reset}`, sel: null })
				for (const line of wg.output) out.push({ text: `     ${dim}${C.rule}│ ${C.muted}${line}${reset}`, sel: null })
			}
		}
		return out
	}

	function buildRows(): Row[] {
		const { attention, done, executing, dismissedLanes, snoozedLanes, sleepingLanes } = sections()
		const w = cols() - GUTTER
		const t = now()
		const rowsOut: Row[] = []
		let i = 0 // running index into `flat`

		rowsOut.push({ text: rule('NEEDS ATTENTION', attention.length), sel: null })
		if (!attention.length) rowsOut.push({ text: `  ${C.muted}nothing stuck${reset}`, sel: null })
		for (const l of attention) {
			const label = `${laneName(l)}${sessTag(l)}`
			const text = truncate(l.text, Math.max(10, w - label.length - 26))
			if (isLive(l)) {
				const tag = l.status === 'ERROR' ? `${C.error} ERROR ${reset}` : `${C.attn} NEEDS ATTENTION ${reset}`
				rowsOut.push({ text: `${tag} ${C.label}${label}${reset} ${C.rule}▸${reset} ${C.muted}${text}${reset}`, sel: i++ })
			} else {
				const tag = l.status === 'ERROR' ? ' ERROR ' : ' NEEDS ATTENTION '
				rowsOut.push({ text: `${dim}${C.muted}${tag} ${label} ▸ ${text}${reset}`, sel: i++ })
			}
			rowsOut.push(...widgetRows(l))
		}
		rowsOut.push({ text: '', sel: null })

		rowsOut.push({ text: rule('DONE', done.length), sel: null })
		if (!done.length) rowsOut.push({ text: `  ${C.muted}no completions${reset}`, sel: null })
		for (const l of done) {
			const when = ago(l.at, t)
			const label = `${laneName(l)}${sessTag(l)}`
			const budget = Math.max(10, w - label.length - when.length - 8)
			const text = truncate(l.text, budget)
			if (isLive(l)) {
				rowsOut.push({ text: `${C.done}✓ ${label}${reset} ${C.rule}▸${reset} ${C.label}${text}${reset}  ${C.muted}${when}${reset}`, sel: i++ })
			} else {
				rowsOut.push({ text: `${dim}${C.muted}✓ ${label} ▸ ${text}  ${when}${reset}`, sel: i++ })
			}
			rowsOut.push(...widgetRows(l))
		}
		rowsOut.push({ text: '', sel: null })

		rowsOut.push({ text: rule('EXECUTING', executing.length), sel: null })
		if (!executing.length) rowsOut.push({ text: `  ${C.muted}idle${reset}`, sel: null })
		for (const l of executing) {
			const spin = `${l.status === 'WAITING' ? C.waiting : C.exec}${SPINNER[spinnerFrame % SPINNER.length]}${reset}`
			const budget = Math.max(10, w - laneName(l).length - 8)
			rowsOut.push({ text: `${spin} ${dim}${laneName(l)} ▸ ${truncate(l.text, budget)}${reset}`, sel: i++ })
			rowsOut.push(...widgetRows(l))
		}

		if (dismissedLanes.length) {
			rowsOut.push({ text: '', sel: null })
			rowsOut.push({ text: rule('DISMISSED', dismissedLanes.length), sel: null })
			for (const l of dismissedLanes) {
				const label = `${laneName(l)}${sessTag(l)}`
				const head = `${STATUS_WORD[l.status]} ${label}`
				const budget = Math.max(10, w - head.length - 6)
				rowsOut.push({ text: `${dim}${C.muted}${head} ▸ ${truncate(l.text, budget)}${reset}`, sel: i++ })
				rowsOut.push(...widgetRows(l))
			}
		}

		if (snoozedLanes.length) {
			rowsOut.push({ text: '', sel: null })
			rowsOut.push({ text: rule('SNOOZED', snoozedLanes.length), sel: null })
			for (const l of snoozedLanes) {
				const wake = `wakes in ${dur((store.snoozeUntil(dismissKey(l)) ?? 0) - t)}`
				const label = `${laneName(l)}${sessTag(l)}`
				const budget = Math.max(10, w - label.length - wake.length - 8)
				rowsOut.push({ text: `${dim}${C.muted}${label} ▸ ${truncate(l.text, budget)} · ${wake}${reset}`, sel: i++ })
				rowsOut.push(...widgetRows(l))
			}
		}

		if (sleepingLanes.length) {
			rowsOut.push({ text: '', sel: null })
			rowsOut.push({ text: rule('SLEEPING', sleepingLanes.length), sel: null })
			for (const l of sleepingLanes) {
				const budget = Math.max(10, w - laneName(l).length - 6)
				rowsOut.push({ text: `${dim}${C.muted}${laneName(l)} ▸ ${truncate(l.text, budget)}${reset}`, sel: i++ })
				rowsOut.push(...widgetRows(l))
			}
		}

		return rowsOut
	}

	// Write exactly rows() lines, each clipped to the terminal width so nothing wraps.
	function blit(screen: string[]): void {
		const w = cols()
		const h = rows()
		const lines = screen.slice(0, h).map((l) => clip(l, w))
		while (lines.length < h) lines.push(`${reset}`)
		out.write(`${ESC}H${lines.map((l) => `${l}${ESC}K`).join('\r\n')}${ESC}J`)
	}

	// The bottom log strip: the newest `n` log lines, oldest first, blank-padded to `n` rows.
	function logTail(n: number): string[] {
		const tail = logRing.slice(-n)
		const pad = Array.from({ length: Math.max(0, n - tail.length) }, () => '')
		return [...pad, ...tail]
	}

	function render(): void {
		if (tornDown) return
		if (confirm) return renderConfirm()
		if (snooze) return renderSnooze()
		if (panel) return renderPanel()
		if (logFull) return renderLogFull()

		const built = buildRows()
		const rendered = built.map((r) => {
			const selected = r.sel !== null && r.sel === sel
			const gutter = selected ? `${C.sel}${bold}❯ ${reset}` : '  '
			return { line: `${gutter}${selected ? bold : ''}${r.text}`, selLine: selected }
		})

		// Layout: 1 title + bodyH lanes + 1 log rule + LOG_LINES log + 1 footer = rows().
		const bodyH = Math.max(1, rows() - 3 - LOG_LINES)
		const selLineIdx = rendered.findIndex((l) => l.selLine)
		if (selLineIdx >= 0) {
			if (selLineIdx < scrollTop) scrollTop = selLineIdx
			if (selLineIdx >= scrollTop + bodyH) scrollTop = selLineIdx - bodyH + 1
		}
		scrollTop = Math.max(0, Math.min(scrollTop, Math.max(0, rendered.length - bodyH)))
		const view = rendered.slice(scrollTop, scrollTop + bodyH)

		const { attention, done, executing, dismissedLanes, snoozedLanes, sleepingLanes } = sections()
		const dismCount = dismissedLanes.length ? ` · ${dismissedLanes.length} dismissed` : ''
		const snzCount = snoozedLanes.length ? ` · ${snoozedLanes.length} snoozed` : ''
		const slpCount = sleepingLanes.length ? ` · ${sleepingLanes.length} sleeping` : ''
		const filterTag = filter ? ` ${C.sel}/${filter}${reset}` : ''
		const title = `${bold}duckies${reset}  ${C.muted}${attention.length} attention · ${done.length} done · ${executing.length} executing${dismCount}${snzCount}${slpCount}${reset}${filterTag}`
		const more = rendered.length > bodyH ? ` · ${scrollTop + 1}-${Math.min(rendered.length, scrollTop + bodyH)}/${rendered.length}` : ''

		const screen: string[] = [title]
		for (const l of view) screen.push(l.line)
		while (screen.length < 1 + bodyH) screen.push('')
		const logRule = `${C.rule}── ${reset}${C.muted}log${reset} ${C.rule}${'─'.repeat(Math.max(0, cols() - 7 - 18))}${reset} ${C.muted}Tab: fullscreen${reset}`
		screen.push(logRule)
		for (const l of logTail(LOG_LINES)) screen.push(l)
		const footer = filtering
			? `${C.sel}/${reset}${filter}${C.sel}█${reset}  ${C.muted}enter/esc keep filter & navigate${reset}`
			: `${C.muted}j/k move · space focus · s/S snooze · z sleep · d dismiss · D done · u undo · x clear · h open · w widgets · R reload · / filter · m menu · q quit${more}${reset}`
		screen.push(footer)
		blit(screen)
	}

	function renderLogFull(): void {
		const h = rows()
		const title = `${bold}duckies — log${reset}  ${C.muted}${logRing.length} lines${reset}`
		const body = logTail(Math.max(1, h - 2))
		blit([title, ...body, `${C.muted}Tab: back to notifier · q quit${reset}`])
	}

	// The snooze duration picker overlay.
	function renderSnooze(): void {
		if (!snooze) return
		const verb = snooze.sleep ? 'sleep & snooze' : 'snooze'
		const title = `${bold}${verb}${reset}  ${C.muted}${laneName(snooze.lane)} ▸ ${truncate(snooze.lane.text, 48)}${reset}`
		const body = ['', ...SNOOZE_OPTIONS.map((o, idx) => {
			const selected = idx === snooze!.index
			const gutter = selected ? `${C.sel}${bold}❯ ${reset}` : '  '
			return `${gutter}${selected ? bold : C.label}${idx + 1}  ${o.label}${reset}`
		})]
		blitFrame(title, body, `${C.muted}j/k select · enter ${verb} · esc cancel${reset}`)
	}

	// A y/n confirmation overlay.
	function renderConfirm(): void {
		if (!confirm) return
		const body = ['', ...confirm.message.map((m) => `  ${C.label}${m}${reset}`)]
		blitFrame(`${bold}confirm${reset}`, body, `${C.muted}y confirm · n/esc cancel${reset}`)
	}

	// The `m` config/new-label menu overlay.
	function renderPanel(): void {
		if (!panel) return
		if (panel.mode === 'menu') {
			const body = ['', ...MENU_ITEMS.map((it, idx) => {
				const selected = idx === panel!.sel
				const gutter = selected ? `${C.sel}${bold}❯ ${reset}` : '  '
				return `${gutter}${selected ? bold : C.label}[${it.key}]  ${it.label}${reset}`
			})]
			return blitFrame(`${bold}menu${reset}`, body, `${C.muted}↑/↓ or a/c/w/t/n · enter · esc${reset}`)
		}
		if (panel.mode === 'pick') {
			if (!panel.pickFiles.length) return blitFrame(`${bold}new label${reset}  ${C.muted}pick a .dk file${reset}`, ['', `  ${C.muted}(no .dk files in control dir)${reset}`], `${C.muted}esc to close${reset}`)
			const body = ['', ...panel.pickFiles.map((f, idx) => {
				const selected = idx === panel!.sel
				const gutter = selected ? `${C.sel}${bold}❯ ${reset}` : '  '
				return `${gutter}${selected ? bold : C.label}${basename(f)}${reset}`
			})]
			return blitFrame(`${bold}new label${reset}  ${C.muted}pick a .dk file${reset}`, body, `${C.muted}↑/↓ · enter · esc${reset}`)
		}
		// input
		blitFrame(`${bold}new label${reset}  ${C.muted}in ${basename(panel.inputFile)}${reset}`, ['', `  ${panel.inputText}${C.sel}█${reset}`], `${C.muted}type a label · enter · esc${reset}`)
	}

	// Paint a centered-ish overlay frame: title, body (padded), footer — exactly rows() lines.
	function blitFrame(title: string, body: string[], footer: string): void {
		const h = rows()
		const bodyH = Math.max(1, h - 2)
		const lines = [title]
		for (const l of body.slice(0, bodyH)) lines.push(l)
		while (lines.length < 1 + bodyH) lines.push('')
		lines.push(footer)
		blit(lines)
	}

	function scheduleRender(): void {
		if (renderQueued || tornDown) return
		renderQueued = true
		setTimeout(() => {
			renderQueued = false
			render()
		}, 16)
	}

	// ── actions ──
	function move(delta: number): void {
		if (!flat.length) return
		sel = Math.max(0, Math.min(flat.length - 1, sel + delta))
		render()
	}

	function focusSelected(): void {
		const l = flat[sel]
		if (!l) return
		// A live session we can switch to directly. One whose tmux was reaped (a fully-[DONE] lane)
		// has nothing to switch to, so bang its header instead: the supervisor spawns it (--resuming
		// the kept conversation) and reveals it on the next tick.
		if (isLive(l)) opts.revealLane(l.label, l.pane)
		else {
			revealLaneHeader(l)
			emit(`focus: ${laneName(l)} has no live session — spawning + revealing it`)
		}
	}

	function dismissSelected(): void {
		const l = flat[sel]
		if (!l) return
		const key = dismissKey(l)
		if (!store.isDismissed(key)) undoStack.push(key)
		store.toggleDismiss(key)
		refresh()
	}

	function undoDismiss(): void {
		while (undoStack.length) {
			const key = undoStack.pop()!
			if (!store.isDismissed(key)) continue // already restored some other way
			store.toggleDismiss(key)
			refresh()
			const i = flat.findIndex((l) => dismissKey(l) === key)
			if (i >= 0) sel = i
			render()
			return
		}
	}

	// Write a `%` clear for the selected lane (duckies collapses its finished run) and dismiss it.
	// Re-reads for the freshest file/line, since a clear edits the .dk file on disk.
	function clearSelected(): void {
		const id = flat[sel]?.id
		if (!id) return
		const l = readLanes(opts.parseControlFiles(), opts.stateDir).find((x) => x.id === id)
		if (!l) return
		// A [NEEDS ATTENTION] frontier blocks duckies's `%` clear, so demote it to [DONE] first.
		if (l.status === 'ATTENTION') markLaneDone(l)
		clearLane(l)
		store.dismiss(dismissKey(l))
		refresh()
	}

	// Flip a [NEEDS ATTENTION] lane's frontier to [DONE] in place — resolve it without dismissing or
	// clearing its run. Re-reads for the freshest file/line, since it edits the .dk file on disk.
	function markDoneSelected(): void {
		const id = flat[sel]?.id
		if (!id) return
		const l = readLanes(opts.parseControlFiles(), opts.stateDir).find((x) => x.id === id)
		if (!l) return
		if (l.status !== 'ATTENTION') {
			emit(`mark done: ${laneName(l)} isn't [NEEDS ATTENTION] (${l.status})`)
			return
		}
		markLaneDone(l)
		emit(`mark done: ${laneName(l)}`)
		refresh()
	}

	function openSelected(): void {
		const l = flat[sel]
		if (l) openInEditor(l.file, l.line)
	}

	// Force a refresh-now on the selected lane's `&name` widgets (prepend `!`); the supervisor reruns
	// them next tick. Re-reads for the freshest line numbers, since it edits the .dk file on disk.
	function reloadSelected(): void {
		const id = flat[sel]?.id
		if (!id) return
		const l = readLanes(opts.parseControlFiles(), opts.stateDir).find((x) => x.id === id)
		if (!l || !l.widgets.length) return
		reloadLaneWidgets(l)
		emit(`widget reload: ${laneName(l)} (${l.widgets.length} widget${l.widgets.length === 1 ? '' : 's'})`)
		refresh()
	}

	// Other live lanes sharing this lane's sleep scope (same control file + sleep header line). Sleep
	// is per-session, so a session with several panes/lanes sleeps them all at once.
	function sleepScopeSiblings(l: Lane, all: Lane[]): Lane[] {
		return all.filter((x) => x.id !== l.id && x.file === l.file && x.headerLine === l.headerLine)
	}

	function sleepSelected(): void {
		const id = flat[sel]?.id
		if (!id) return
		const fresh = readLanes(opts.parseControlFiles(), opts.stateDir)
		const l = fresh.find((x) => x.id === id)
		if (!l) return
		const apply = () => {
			toggleSleep(l)
			refresh()
		}
		const siblings = sleepScopeSiblings(l, fresh)
		if (!l.asleep && siblings.length) return askSleepScope(l, siblings.length, apply)
		apply()
	}

	function askSleepScope(l: Lane, others: number, onYes: () => void): void {
		const n = `${others} other notification${others === 1 ? '' : 's'}`
		confirm = { message: [`Sleeping ${laneName(l)} will also sleep ${n} in this session.`, '', 'Sleep them all?'], onYes }
		render()
	}

	function openSnoozeMenu(sleep = false): void {
		const l = flat[sel]
		if (!l) return
		const lastMs = store.lastSnoozeMs()
		const idx = SNOOZE_OPTIONS.findIndex((o) => o.ms === lastMs)
		snooze = { lane: l, index: idx >= 0 ? idx : 2, sleep }
		render()
	}

	function confirmSnooze(): void {
		if (!snooze) return
		const ms = SNOOZE_OPTIONS[snooze.index].ms
		const { lane, sleep } = snooze
		snooze = null
		const fresh = sleep ? readLanes(opts.parseControlFiles(), opts.stateDir) : []
		const l = sleep ? fresh.find((x) => x.id === lane.id) ?? lane : lane
		const apply = () => {
			store.snooze(dismissKey(l), now() + ms, ms, sleep)
			if (sleep && !l.asleep) toggleSleep(l)
			refresh()
		}
		const siblings = sleep ? sleepScopeSiblings(l, fresh) : []
		if (sleep && !l.asleep && siblings.length) return askSleepScope(l, siblings.length, apply)
		apply()
	}

	function startFilter(): void {
		filtering = true
		sel = 0
		render()
	}

	// Open a `.dk`/config file in the editor — Sublime Text by default (`subl <file>[:line]`);
	// override with $DUCKIES_EDITOR (a command receiving the `<file>[:line]` target as final arg).
	function openInEditor(file: string, line?: number): void {
		try {
			mkdirSync(dirname(file), { recursive: true })
		} catch {}
		const target = line ? `${file}:${line}` : file
		const override = process.env.DUCKIES_EDITOR
		const [cmd, ...args] = override ? override.split(/\s+/) : ['subl']
		const launch = () => spawn(cmd, [...args, target], { detached: true, stdio: 'ignore' }).unref()
		try {
			launch()
			// Sublime activates asynchronously: when it isn't already frontmost the goto-line runs
			// before the view is focused, so the caret doesn't move (you'd have to press again).
			// Re-issue once it's up so the jump lands on the first press.
			if (!override && line) setTimeout(launch, 150)
		} catch (e) {
			emit(`WARN editor ${cmd} failed: ${(e as Error).message}`)
		}
	}

	// ── the `m` menu ──
	const MENU_ITEMS: { key: string; label: string; file: (() => string) | null }[] = [
		{ key: 'a', label: 'Edit aliases', file: () => opts.configFiles.aliases },
		{ key: 'c', label: 'Edit macros', file: () => opts.configFiles.macros },
		{ key: 'w', label: 'Edit widgets', file: () => opts.configFiles.widgets },
		{ key: 't', label: 'Edit templates', file: () => opts.configFiles.templates },
		{ key: 'n', label: 'New label…', file: null },
	]

	function activatePanel(i: number): void {
		const it = MENU_ITEMS[i]
		if (!panel) return
		if (it.file === null) {
			panel = { mode: 'pick', sel: 0, pickFiles: opts.controlFiles(), inputFile: '', inputText: '' }
			return render()
		}
		openInEditor(it.file())
		panel = null
		render()
	}

	function commitInput(): void {
		if (!panel) return
		const label = panel.inputText.trim()
		if (!label) {
			panel = null
			return render()
		}
		// Already a session with this label? Reveal its tmux and open its `.dk` at the header line
		// rather than appending a clashing duplicate.
		const existing = opts.locateLabel(label)
		if (existing) {
			opts.revealSession(existing.label)
			emit(`menu: ${label} already exists in ${basename(existing.file)} — revealing its tmux + opening in editor`)
			openInEditor(existing.file, existing.line)
			panel = null
			return render()
		}
		let content = ''
		try {
			content = readFileSync(panel.inputFile, 'utf8')
		} catch {}
		const tmp = `${panel.inputFile}.tmp`
		// `!` prefix: the supervisor spawns the session and switches the client to its claude window
		// once it's up, then consumes the `!`. No editor — you land straight inside the session.
		writeFileSync(tmp, appendLabel(content, `!${label}`))
		renameSync(tmp, panel.inputFile)
		emit(`menu: added ${label} to ${basename(panel.inputFile)} — spawning + revealing its claude window`)
		panel = null
		render()
	}

	// ── input routing ──
	function handleConfirmKey(k: string): void {
		if (!confirm) return
		if (k === 'y' || k === 'Y') {
			const onYes = confirm.onYes
			confirm = null
			return onYes()
		}
		if (k === 'n' || k === 'N' || k === 'Esc' || k === 'q') {
			confirm = null
			render()
		}
	}

	function handleSnoozeKey(k: string): void {
		if (!snooze) return
		if (k === 'Esc' || k === 'q') {
			snooze = null
			return render()
		}
		if (k === 'j' || k === 'Down') snooze.index = Math.min(SNOOZE_OPTIONS.length - 1, snooze.index + 1)
		else if (k === 'k' || k === 'Up') snooze.index = Math.max(0, snooze.index - 1)
		else if (k === 'Enter' || k === ' ') return confirmSnooze()
		else if (/^[1-9]$/.test(k)) {
			const idx = Number(k) - 1
			if (idx < SNOOZE_OPTIONS.length) {
				snooze.index = idx
				return confirmSnooze()
			}
		} else return
		render()
	}

	function handlePanelKey(k: string): void {
		if (!panel) return
		if (k === 'Esc') {
			panel = null
			return render()
		}
		if (panel.mode === 'menu') {
			if (k === 'Up') panel.sel = (panel.sel - 1 + MENU_ITEMS.length) % MENU_ITEMS.length
			else if (k === 'Down') panel.sel = (panel.sel + 1) % MENU_ITEMS.length
			else if (k === 'Enter') return activatePanel(panel.sel)
			else {
				const i = MENU_ITEMS.findIndex((it) => it.key === k)
				if (i >= 0) return activatePanel(i)
				return
			}
			return render()
		}
		if (panel.mode === 'pick') {
			if (!panel.pickFiles.length) return
			if (k === 'Up') panel.sel = (panel.sel - 1 + panel.pickFiles.length) % panel.pickFiles.length
			else if (k === 'Down') panel.sel = (panel.sel + 1) % panel.pickFiles.length
			else if (k === 'Enter') {
				panel = { mode: 'input', sel: 0, pickFiles: [], inputFile: panel.pickFiles[panel.sel], inputText: '' }
				return render()
			} else return
			return render()
		}
		// input
		if (k === 'Enter') return commitInput()
		if (k === 'Backspace') panel.inputText = panel.inputText.slice(0, -1)
		else if (!NAMED.has(k) && (k.codePointAt(0) ?? 0) >= 0x20) panel.inputText += k
		else return
		render()
	}

	function handleFilterKey(k: string): void {
		if (k === 'Esc' || k === 'Enter') {
			// leave input mode but keep the query, so you can navigate the filtered view.
			filtering = false
			return render()
		}
		if (k === 'C-c') return quit()
		if (k === 'Up') return move(-1)
		if (k === 'Down') return move(1)
		if (k === 'Backspace') filter = filter.slice(0, -1)
		else if (!NAMED.has(k) && (k.codePointAt(0) ?? 0) >= 0x20) filter += k
		else return
		sel = 0
		rebuild()
		render()
	}

	function handleKey(k: string): void {
		if (confirm) return handleConfirmKey(k)
		if (snooze) return handleSnoozeKey(k)
		if (panel) return handlePanelKey(k)
		if (filtering) return handleFilterKey(k)
		if (k === 'C-c') return quit()
		if (logFull) {
			if (k === 'Tab' || k === 'q' || k === 'Esc') {
				logFull = false
				return render()
			}
			return
		}
		if (k === 'g') {
			// `gg` jumps to the top; a lone `g` waits for the second press.
			if (pendingG) move(-flat.length)
			pendingG = !pendingG
			return
		}
		pendingG = false
		if (k === 'Esc') {
			// Esc clears an active filter but never exits the supervisor (only q / Ctrl-C do).
			if (filter) {
				filter = ''
				rebuild()
				render()
			}
			return
		}
		if (k === 'q') return quit()
		if (k === 'Tab') {
			logFull = true
			return render()
		}
		if (k === '/') return startFilter()
		if (k === 'm') {
			panel = { mode: 'menu', sel: 0, pickFiles: [], inputFile: '', inputText: '' }
			return render()
		}
		if (k === 'j' || k === 'Down') return move(1)
		if (k === 'k' || k === 'Up') return move(-1)
		if (k === ' ' || k === 'Enter') return focusSelected()
		if (k === 's') return openSnoozeMenu()
		if (k === 'S') return openSnoozeMenu(true)
		if (k === 'd') return dismissSelected()
		if (k === 'u') return undoDismiss()
		if (k === 'x') return clearSelected()
		if (k === 'D') return markDoneSelected()
		if (k === 'z') return sleepSelected()
		if (k === 'h') return openSelected()
		if (k === 'R') return reloadSelected()
		if (k === 'w') {
			showWidgets = !showWidgets
			return render()
		}
		if (k === 'G') return move(flat.length)
	}

	// ── log channel ──
	const ts = () => new Date().toTimeString().slice(0, 8)
	function emit(msg: string): void {
		const line = color ? `${LC.dim}${ts()}${LC.reset} ${colorizeLog(msg, true)}` : `${ts()} ${msg}`
		logRing.push(line)
		if (logRing.length > 1000) logRing.shift()
		scheduleRender()
	}

	// ── lifecycle ──
	function quit(): void {
		teardown()
		process.exit(0)
	}

	function teardown(): void {
		if (tornDown) return
		tornDown = true
		for (const t of timers) clearInterval(t)
		out.write(`${ESC}?25h${ESC}?1049l`) // show cursor, leave alt screen
		try {
			if (process.stdin.isTTY) process.stdin.setRawMode(false)
		} catch {}
		// Spill whatever's in the log ring back to the normal screen, so the last activity isn't lost
		// when the alt screen is torn down.
		for (const l of logRing.slice(-LOG_LINES)) out.write(`${l}\n`)
	}

	out.write(`${ESC}?1049h${ESC}?25l`) // alt screen, hide cursor
	try {
		if (process.stdin.isTTY) process.stdin.setRawMode(true)
	} catch {}
	process.stdin.resume()
	process.stdin.on('data', (chunk: Buffer) => {
		for (const k of decodeKeys(chunk)) handleKey(k)
	})
	out.on('resize', () => render())

	// Initial data, then poll as a backstop (the supervisor's post-tick refresh is the fast path).
	const updateLive = () =>
		opts
			.liveSessions()
			.then((set) => {
				live = set
				scheduleRender()
			})
			.catch(() => {})
	refresh()
	updateLive()
	render()
	timers.push(setInterval(() => {
		refresh()
		updateLive()
	}, POLL_MS))
		// Animate the EXECUTING spinner (and any reloading-widget spinner) while such a row exists and
		// no overlay/log is up.
		const anyReloading = (): boolean => lanes.some((l) => l.widgets.some((w) => w.pending))
		timers.push(setInterval(() => {
		if (snooze || confirm || panel || logFull) return
		if (!sections().executing.length && !anyReloading()) return
		spinnerFrame++
		render()
	}, SPINNER_MS))

	return { emit, teardown, refresh }
}
