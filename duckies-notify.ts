// Data layer for the supervisor's notifier view (the default dashboard). Ported from the
// standalone duckies-notifier (src/source.ts + store.ts + duckies-edit.ts): it turns the parsed
// `.dk` sessions into a flat list of lane "notifications" (NEEDS ATTENTION / DONE / EXECUTING / …),
// persists dismissals & snoozes, and performs the `%`/`?` file edits a lane action writes back.
//
// Rendering + input live in duckies-menu.ts (the TUI); this module is the model, kept separate so
// it's unit-testable and so it can't drift from the supervisor — it consumes the SAME parsed
// sessions the tick does (passed in via `parseControlFiles`), rather than re-deriving lane state.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { widgetOutput, type Kind, type Session } from './duckies'

// Duckies's five frontier markers (duckies.ts `type Kind`); a lane's status is the single marker
// the supervisor wrote for its frontier item.
export type Status = Kind

// A session's `&name` widget as the notifier shows it: the `&name[ args]` call plus the lines of
// its live output (empty when it hasn't produced any yet). Every lane of a session carries its
// session's widgets, so the view can echo them under the lane.
export interface LaneWidget {
	call: string
	output: string[]
	// 1-based line of the `&name` call in the lane's file — where a `!` refresh-now is prepended.
	line: number
	// A `!` refresh-now is queued on this widget (e.g. just pressed `R`): the supervisor hasn't
	// rerun it yet. The view shows it as loading until the rerun lands and clears the bang.
	pending: boolean
}

// One lane = a session (repo or worktree) + a pane/lane number, e.g. `app`, `app:2`. Exactly one
// item per lane carries a marker — the "frontier" — which is the status we surface.
export interface Lane {
	id: string
	label: string
	dir: string
	pane: number
	isWorktree: boolean
	status: Status
	text: string
	// Completion/last-event time (ms). 0 when no hook file exists yet. Orders the DONE feed.
	at: number
	// The control file this lane's frontier marker lives in, and the 1-based line of the frontier
	// item (for jumping to it in an editor) and its leading whitespace (so an inserted `%` clear
	// lands at the same nesting).
	file: string
	line: number
	indent: string
	// The 1-based line of the frontier's status marker (`[NEEDS ATTENTION]` etc.), one indent below
	// the item body — flipped to [DONE] so a `%` clear can sweep a blocking attention lane.
	markerLine: number
	// The 1-based line and indent of the header whose `?` toggles this lane's sleep.
	headerLine: number
	headerIndent: string
	// duckies's sleep flag (`?` header prefix): tmux torn down but the conversation kept.
	asleep: boolean
	// The session's `&name` widgets and their live output, echoed under the lane in the view.
	widgets: LaneWidget[]
}

// ---------------------------------------------------------------- lane extraction
const paneSuffix = (n: number) => (n > 1 ? `.${n}` : '')
const mtime = (p: string): number => {
	try {
		return statSync(p).mtimeMs
	} catch {
		return 0
	}
}

// Whether a lane's latest Claude hook event says its turn has *ended* (duckies-hook overwrites
// `<label>[.n].json` on every event, so its `event` is the newest). A `Stop`, or the idle nudge
// Claude fires once it's waiting for input, both mean the turn finished. Used only to clear a
// possibly-stale `[EXECUTING]` marker (e.g. a session closed before the supervisor advanced it) so
// a completed turn stops showing as executing. Attention is left to duckies's own marker.
function turnEnded(stateDir: string, label: string, suffix: string): boolean {
	try {
		const j = JSON.parse(readFileSync(join(stateDir, `${label}${suffix}.json`), 'utf8'))
		if (j.event === 'Stop') return true
		if (j.event === 'Notification') return j.raw?.notification_type === 'idle_prompt'
	} catch {}
	return false
}

// The header line (1-based) and indent whose `?` toggles a session's sleep. Normally the session's
// own header, but a worktree that is the *only* worktree nested under its label retargets to the
// label: duckies cascades `?label` to its lone worktree, so the effect is identical while keeping
// the flag on the un-indented label rather than the indented child. Nearest-shallower-indent is the
// parent (mirrors duckies's container stack).
function nearestParent(sessions: Session[], i: number): number {
	for (let j = i - 1; j >= 0; j--) {
		if ((sessions[j].indent?.length ?? 0) < (sessions[i].indent?.length ?? 0)) return j
	}
	return -1
}
export function sleepHeader(sessions: Session[], i: number): { line: number; indent: string } {
	const s = sessions[i]
	const own = { line: s.headerIdx + 1, indent: s.indent ?? '' }
	if (s.worktreeBase === undefined || !(s.indent?.length ?? 0)) return own
	const p = nearestParent(sessions, i)
	if (p < 0) return own
	const siblings = sessions.filter((c, j) => c.worktreeBase !== undefined && nearestParent(sessions, j) === p)
	if (siblings.length !== 1) return own
	return { line: sessions[p].headerIdx + 1, indent: sessions[p].indent ?? '' }
}

// Pull each lane's frontier marker from the already-parsed control files, along with the file and
// line it sits in. A lane appears only while it carries a marker; a cleared run simply drops out.
// Deduped by id: the first file that holds the marker wins (mirrors the notifier's readLanes).
export function readLanes(parsed: { file: string; sessions: Session[] }[], stateDir: string): Lane[] {
	const byId = new Map<string, Lane>()
	for (const { file, sessions } of parsed) {
		// Raw file lines, so a widget's live output (stored inline or in a `| ` block) can be read
		// back for display. Read once per file; a read failure just yields no widget output.
		let fileLines: string[] = []
		try {
			fileLines = readFileSync(file, 'utf8').split('\n')
		} catch {}
		for (let si = 0; si < sessions.length; si++) {
			const s = sessions[si]
			const sleepAt = sleepHeader(sessions, si)
			const widgets: LaneWidget[] = s.widgets.filter((w) => !w.unknown).map((w) => ({ call: w.call, output: widgetOutput(w, fileLines), line: w.lineIdx + 1, pending: w.bang }))
			const seen = new Set<number>()
			for (const p of s.prompts) {
				if (!p.marker || seen.has(p.pane)) continue
				seen.add(p.pane)
				const id = `${s.label}#${p.pane}`
				if (byId.has(id)) continue
				const suffix = paneSuffix(p.pane)
				// Trust duckies's marker, but clear a possibly-stale EXECUTING when the latest hook event
				// shows the turn already ended. WAITING is left alone: it already means "turn ended, a
				// background shell is still running" — derived from the live pane, which we can't see.
				// Only a claude-pane frontier is subject to this: turnEnded reads the *claude* hook file,
				// which says nothing about a `$`-command frontier (or a macro mid-`$`-step) still running
				// in the shell pane — gating on it would flip a live shell lane to DONE while its command
				// (e.g. `gh-wait-for-ci`) is still blocking.
				const shellFrontier = p.isCmd || (p.isMacro && !!p.steps?.some((st) => st.isCmd))
				let status = p.marker.kind as Status
				if (status === 'EXECUTING' && !shellFrontier && turnEnded(stateDir, s.label, suffix)) status = 'DONE'
				byId.set(id, {
					id,
					label: s.label,
					dir: s.dir,
					pane: p.pane,
					isWorktree: s.worktreeBase !== undefined,
					status,
					text: p.text,
					at: Math.max(mtime(join(stateDir, `${s.label}${suffix}.json`)), mtime(join(stateDir, `${s.label}${suffix}.cmd`))),
					file,
					line: p.lineIdx + 1,
					indent: p.indent,
					markerLine: p.marker.lineIdx + 1,
					headerLine: sleepAt.line,
					headerIndent: sleepAt.indent,
					asleep: !!s.sleep,
					widgets,
				})
			}
		}
	}
	return [...byId.values()]
}

// ---------------------------------------------------------------- `.dk` file edits
function writeFileAtomic(file: string, lines: string[]): void {
	try {
		const tmp = `${file}.notify.tmp`
		writeFileSync(tmp, lines.join('\n'))
		renameSync(tmp, file)
	} catch {}
}

// Insert a `%` clear for a lane just above its frontier item, at the frontier's indentation.
// duckies's clear (buildOps) deletes the `%` plus every same-lane item physically below it, so this
// sweeps the frontier and older finished items while leaving pending work above untouched. The
// sigil repeats per lane — `%` for lane 1, `%%` for lane 2, … (duckies.ts CLEAR_RE). Atomic, so the
// supervisor's directory watch picks up one clean change.
export function clearLane(lane: Lane): void {
	const sigil = '%'.repeat(lane.pane)
	let lines: string[]
	try {
		lines = readFileSync(lane.file, 'utf8').split('\n')
	} catch {
		return
	}
	const at = Math.max(0, Math.min(lines.length, lane.line - 1))
	lines.splice(at, 0, `${lane.indent}${sigil}`)
	writeFileAtomic(lane.file, lines)
}

// Flip a lane's frontier marker to [DONE]. duckies won't fire a `%` clear while the item just below
// is [NEEDS ATTENTION]/[ERROR]/[EXECUTING]/[WAITING] (its stranded-clear check), so clearing an
// attention lane needs its marker demoted first. Safe: duckies only re-latches attention onto an
// item it still sees as active; a [DONE] item isn't re-flagged.
export function markLaneDone(lane: Lane): void {
	let lines: string[]
	try {
		lines = readFileSync(lane.file, 'utf8').split('\n')
	} catch {
		return
	}
	const at = lane.markerLine - 1
	if (at < 0 || at >= lines.length) return
	lines[at] = `${lane.indent}\t[DONE]`
	writeFileAtomic(lane.file, lines)
}

// Force a "refresh now" on every `&name` widget in the lane's session by prepending `!` to each
// widget line (duckies's bang: a one-shot rerun regardless of the widget's interval gate). The
// supervisor consumes the `!` on its next tick, reruns the commands, and rewrites the line clean.
// Already-banged lines are left as-is. Atomic, so the directory watch sees one clean change.
export function reloadLaneWidgets(lane: Lane): void {
	if (!lane.widgets.length) return
	let lines: string[]
	try {
		lines = readFileSync(lane.file, 'utf8').split('\n')
	} catch {
		return
	}
	let changed = false
	for (const w of lane.widgets) {
		const at = w.line - 1
		if (at < 0 || at >= lines.length) continue
		const line = lines[at]
		const amp = line.indexOf('&')
		if (amp < 0 || line[amp - 1] === '!') continue
		lines[at] = `${line.slice(0, amp)}!${line.slice(amp)}`
		changed = true
	}
	if (changed) writeFileAtomic(lane.file, lines)
}

// Toggle duckies's `?` sleep flag on the lane's session header line (after its indent, so a worktree
// label keeps its tabs). Present → wake (strip `?` and any following space); absent → sleep (prefix
// `?`). duckies tears the tmux session down while `?` is present and `--resume`s on wake.
export function toggleSleep(lane: Lane): void {
	let lines: string[]
	try {
		lines = readFileSync(lane.file, 'utf8').split('\n')
	} catch {
		return
	}
	const at = lane.headerLine - 1
	if (at < 0 || at >= lines.length) return
	const rest = lines[at].slice(lane.headerIndent.length)
	const woke = rest.startsWith('?') ? rest.slice(1).replace(/^\s*/, '') : `?${rest}`
	lines[at] = `${lane.headerIndent}${woke}`
	writeFileAtomic(lane.file, lines)
}

// ---------------------------------------------------------------- dismiss/snooze store
// A lane is keyed by its id + current status + frontier text, so a dismissal/snooze stays attached
// while it shows that exact state but lapses the moment the lane moves on (a new completion, or it
// flips to NEEDS ATTENTION). Persisted across restarts.
export const dismissKey = (l: Lane): string => `${l.id}\t${l.status}\t${l.text}`

interface Persisted {
	dismissed: string[]
	snoozed: Record<string, number> // key -> wake time (epoch ms)
	sleepSnoozed: string[] // snooze keys whose session was slept and must wake on expiry
	lastSnoozeMs?: number // duration of the most recent snooze, to preselect next time
}

export class Store {
	private dismissedSet: Set<string>
	private snoozed: Map<string, number>
	private sleepSnoozedSet: Set<string>
	private lastMs: number | undefined

	constructor(private file: string) {
		const p = this.load()
		this.dismissedSet = new Set(p.dismissed)
		this.snoozed = new Map(Object.entries(p.snoozed))
		this.sleepSnoozedSet = new Set(p.sleepSnoozed)
		this.lastMs = p.lastSnoozeMs
	}

	lastSnoozeMs(): number | undefined {
		return this.lastMs
	}

	isDismissed(key: string): boolean {
		return this.dismissedSet.has(key)
	}

	toggleDismiss(key: string): void {
		if (this.dismissedSet.has(key)) this.dismissedSet.delete(key)
		else this.dismissedSet.add(key)
		this.save()
	}

	dismiss(key: string): void {
		this.dismissedSet.add(key)
		this.save()
	}

	isSnoozed(key: string, now: number): boolean {
		const at = this.snoozed.get(key)
		return at !== undefined && at > now
	}

	snoozeUntil(key: string): number | undefined {
		return this.snoozed.get(key)
	}

	snooze(key: string, wakeAt: number, ms?: number, sleep = false): void {
		this.snoozed.set(key, wakeAt)
		if (ms !== undefined) this.lastMs = ms
		if (sleep) this.sleepSnoozedSet.add(key)
		else this.sleepSnoozedSet.delete(key)
		this.dismissedSet.delete(key) // snoozing supersedes a dismissal
		this.save()
	}

	// Whether this snooze also slept the lane's session (so it must be woken on expiry).
	isSleepSnoozed(key: string): boolean {
		return this.sleepSnoozedSet.has(key)
	}

	clearSleepSnooze(key: string): void {
		if (this.sleepSnoozedSet.delete(key)) this.save()
	}

	// Drop dismissals/snoozes that no longer match a live lane, plus snoozes that have woken (wake
	// time passed) — so the set stays bounded and woken lanes reappear.
	prune(liveKeys: Set<string>, now: number): void {
		let changed = false
		for (const k of this.dismissedSet) if (!liveKeys.has(k)) (this.dismissedSet.delete(k), (changed = true))
		for (const [k, at] of this.snoozed) if (!liveKeys.has(k) || at <= now) (this.snoozed.delete(k), this.sleepSnoozedSet.delete(k), (changed = true))
		if (changed) this.save()
	}

	private load(): Persisted {
		try {
			const raw = JSON.parse(readFileSync(this.file, 'utf8'))
			return { dismissed: raw.dismissed ?? [], snoozed: raw.snoozed ?? {}, sleepSnoozed: raw.sleepSnoozed ?? [], lastSnoozeMs: raw.lastSnoozeMs }
		} catch {
			return { dismissed: [], snoozed: {}, sleepSnoozed: [] }
		}
	}

	private save(): void {
		try {
			mkdirSync(join(this.file, '..'), { recursive: true })
			const tmp = `${this.file}.tmp`
			writeFileSync(tmp, JSON.stringify({ dismissed: [...this.dismissedSet], snoozed: Object.fromEntries(this.snoozed), sleepSnoozed: [...this.sleepSnoozedSet], lastSnoozeMs: this.lastMs }))
			renameSync(tmp, this.file)
		} catch {}
	}
}
