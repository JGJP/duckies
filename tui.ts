#!/usr/bin/env tsx
// `pnpm herald [file.herald]` — a self-contained, vim-like modal editor for `.herald`
// control files. It owns the terminal directly (raw mode + ANSI on the alternate
// screen); there is no external editor process. While you edit, the supervisor keeps
// writing to the same file (marker updates, drained lines); a background poll folds
// those out-of-band writes into your buffer WITHOUT disturbing what you're typing:
//
//   - The merge only runs while you're idle in NORMAL mode, so keystrokes are never
//     lost — a pending update lands the moment you leave insert.
//   - With no unsaved edits it's a clean reload (your cursor stays put).
//   - With unsaved edits it 3-way merges the controller's change into your buffer
//     (your line wins on a genuine conflict) and keeps the cursor where you were.
//
// Save with `:w`. Vim-ish core: NORMAL/INSERT/VISUAL/COMMAND modes; motions
// h j k l w b e 0 ^ $ gg G f F t T {count}; edits x r i a I A o O d c y p P dd cc yy
// D C s S; undo u / redo C-r; search / n N; ex :w :q :wq :x :q! :{line}.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { diff3Merge } from 'node-diff3'

const HERE = dirname(fileURLToPath(import.meta.url))
// Which file to edit: an explicit `pnpm herald <file>` arg (a bare name is looked up
// in the repo dir), else HERALD_FILE, else the default `.herald`.
const argFile = process.argv[2]
const FILE = argFile
	? resolve(argFile.includes('/') ? argFile : join(HERE, argFile))
	: process.env.HERALD_FILE
		? resolve(process.env.HERALD_FILE)
		: join(HERE, '.herald')
const POLL_MS = 300
const TAB = 4 // display width of a tab (buffer keeps the real \t)

// ── file <-> buffer helpers (shared with the sync/merge below) ────────────────
// Split file content into buffer lines the way editors do: a trailing newline is the
// end-of-file marker, not an extra empty line.
export const toLines = (content: string): string[] => (content.endsWith('\n') ? content.slice(0, -1) : content).split('\n')
export const eq = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])

// Resolve a diff3 conflict span. When ours and theirs touched *different* lines of the
// same span (the common case: you edit a prompt while the controller flips the marker
// below it) both edits are kept. On a genuine same-line clash — or an uneven
// insert/delete on both sides — OURS wins so the line you're typing is never dropped
// (the controller re-derives markers each tick, so a marker lost this way is re-applied).
function resolveConflict(a: string[], o: string[], b: string[]): string[] {
	if (eq(a, o)) return b // ours untouched here → take theirs
	if (eq(b, o)) return a // theirs untouched here → take ours
	if (a.length === o.length && b.length === o.length) {
		return o.map((base, i) => (a[i] !== base ? a[i] : b[i])) // per-line: whoever changed it
	}
	return a
}

// 3-way line merge of the buffer (ours) and disk (theirs) against their last-agreed base.
export function merge3(ours: string[], base: string[], theirs: string[]): string[] {
	const out: string[] = []
	for (const r of diff3Merge(ours, base, theirs, { excludeFalseConflicts: true })) {
		if ('ok' in r) out.push(...r.ok)
		else out.push(...resolveConflict(r.conflict.a, r.conflict.o, r.conflict.b))
	}
	return out
}

// Index of `value` in `lines` nearest to `near` (used to keep the cursor on the same
// logical line after a merge shifts line numbers).
export function nearestIndex(lines: string[], value: string, near: number): number {
	let best = -1
	for (let i = 0; i < lines.length; i++) {
		if (lines[i] === value && (best === -1 || Math.abs(i - near) < Math.abs(best - near))) best = i
	}
	return best === -1 ? Math.min(near, lines.length - 1) : best
}

// ── syntax highlighting (mirrors parse() / herald.sublime-syntax) ─────────────
const C = {
	reset: '\x1b[0m',
	comment: '\x1b[38;5;244m',
	header: '\x1b[1;38;5;39m',
	promptSigil: '\x1b[38;5;79m',
	promptText: '\x1b[38;5;250m',
	cmdSigil: '\x1b[38;5;114m',
	cmdText: '\x1b[38;5;180m',
	show: '\x1b[38;5;170m',
	macro: '\x1b[38;5;16;48;2;6;199;85m', // black on LINE green (#06C755)
	exec: '\x1b[38;5;220m',
	done: '\x1b[38;5;114m',
	attn: '\x1b[1;38;5;203m',
	marker: '\x1b[38;5;203m',
	bang: '\x1b[1;38;5;209m',
	gutter: '\x1b[38;5;240m',
	gutterCur: '\x1b[38;5;250m',
	status: '\x1b[7m',
}

// Per-character color for one line (null = default). Category order follows the grammar.
function colorsFor(line: string): (string | null)[] {
	const n = line.length
	const col: (string | null)[] = new Array(n).fill(null)
	const fill = (a: number, b: number, c: string | null) => {
		for (let i = a; i < Math.min(b, n); i++) col[i] = c
	}
	if (n === 0) return col
	const lead = line.match(/^\t+[ ]*/)?.[0].length ?? 0
	// A `|` line is a multiline prompt-body continuation (YAML block-scalar style): the `|`
	// reads as a sigil, the rest as prompt text — so a pasted body never looks like a worktree.
	if (line.startsWith('\t') && line[lead] === '|') {
		fill(lead, lead + 1, C.promptSigil)
		fill(lead + 1, n, C.promptText)
		return col
	}
	const afterIndent = line.replace(/^[ \t]*/, '')
	if (afterIndent.startsWith('#')) {
		fill(0, n, C.comment)
		return col
	}
	if (!line.startsWith('\t')) {
		// column-0 session header; a trailing ` !` (or `!`) is the "show now" accent.
		fill(0, n, C.header)
		const m = line.match(/(!)[ ]*$/)
		if (m) fill(m.index!, m.index! + 1, C.bang)
		return col
	}
	const body = line.slice(lead)
	const low = body.toLowerCase()
	let m: RegExpMatchArray | null
	if (/^@[\w-]+(?:\s.*)?$/.test(body)) {
		// Macro call — a name char must follow the `@` (so a `@@@…` body line stays default).
		fill(lead, n, C.macro)
	} else if ((m = low.match(/^(prompt)?:+\d*/))) {
		fill(lead, lead + m[0].length, C.promptSigil)
		fill(lead + m[0].length, n, C.promptText)
	} else if ((m = body.match(/^\$+\d*/))) {
		fill(lead, lead + m[0].length, C.cmdSigil)
		fill(lead + m[0].length, n, C.cmdText)
	} else if (/^(show|!)[ ]*$/i.test(body)) {
		fill(lead, n, C.show)
	} else if ((m = body.match(/^(\[[^\]]*\])(!)?[ ]*$/))) {
		const inner = m[1].toLowerCase()
		const c = inner.includes('executing') ? C.exec : inner.includes('done') ? C.done : inner.includes('attention') ? C.attn : C.marker
		fill(lead, lead + m[1].length, c)
		if (m[2]) fill(lead + m[1].length, lead + m[1].length + 1, C.bang)
	} else {
		// A worktree name (indented non-sigil): a git worktree of the enclosing repo,
		// styled like the repo header it stands in for, including its trailing `!` accent.
		fill(0, n, C.header)
		const b = line.match(/(!)[ ]*$/)
		if (b) fill(b.index!, b.index! + 1, C.bang)
	}
	return col
}

// ── editor state ──────────────────────────────────────────────────────────────
type Mode = 'normal' | 'insert' | 'visual' | 'vline' | 'command'
type Reg = { type: 'char'; text: string } | { type: 'line'; lines: string[] }
interface Snapshot {
	lines: string[]
	cy: number
	cx: number
}

const out = process.stdout
let lines: string[] = ['']
let cy = 0
let cx = 0
let want = 0 // desired buffer column, preserved across j/k
let top = 0 // first visible buffer row
let left = 0 // horizontal scroll, in display cells
let mode: Mode = 'normal'
let cmdline = '' // text of the `:` or `/` line
let cmdKind: ':' | '/' = ':'
let message = ''
let base: string[] = [''] // last content we and disk agreed on
let reg: Reg = { type: 'char', text: '' }
let undoStack: Snapshot[] = []
let redoStack: Snapshot[] = []
let vAnchor = { cy: 0, cx: 0 } // visual-mode selection anchor
let lastSearch = ''
let newFile = false // editing a path that doesn't exist on disk yet
let quit = false

// pending normal-mode composition
let op: '' | 'd' | 'c' | 'y' = ''
let countBuf = ''
let awaitG = false
let awaitReplace = false
let awaitFind: '' | 'f' | 'F' | 't' | 'T' = ''

const view = () => ({ rows: out.rows || 24, cols: out.columns || 80 })
const gutterW = () => Math.max(3, String(lines.length).length) + 1

function snapshot(): Snapshot {
	return { lines: lines.slice(), cy, cx }
}
function pushUndo() {
	undoStack.push(snapshot())
	if (undoStack.length > 500) undoStack.shift()
	redoStack = []
}
const modified = () => !eq(lines, base)

function clampCursor() {
	if (lines.length === 0) lines = ['']
	cy = Math.max(0, Math.min(cy, lines.length - 1))
	const maxX = Math.max(0, lines[cy].length - (mode === 'insert' || mode === 'command' ? 0 : 1))
	cx = Math.max(0, Math.min(cx, maxX))
}

// ── screen-column math (tabs) ──────────────────────────────────────────────────
function screenXof(line: string, bufCol: number): number {
	let s = 0
	for (let i = 0; i < bufCol && i < line.length; i++) s += line[i] === '\t' ? TAB - (s % TAB) : 1
	return s
}

// ── flat-buffer offsets, for word motions and charwise operators ───────────────
function toOffset(r: number, c: number): number {
	let o = 0
	for (let i = 0; i < r; i++) o += lines[i].length + 1
	return o + c
}
function fromOffset(o: number): { r: number; c: number } {
	let r = 0
	while (r < lines.length && o > lines[r].length) {
		o -= lines[r].length + 1
		r++
	}
	return { r: Math.min(r, lines.length - 1), c: Math.max(0, o) }
}
const flat = () => lines.join('\n')
const cls = (ch: string | undefined) => (ch === undefined || ch === ' ' || ch === '\t' || ch === '\n' ? 0 : /\w/.test(ch) ? 2 : 1)

function wordFwd(o: number): number {
	const t = flat()
	const n = t.length
	const c0 = cls(t[o])
	o++
	if (c0 !== 0) while (o < n && cls(t[o]) === c0) o++
	while (o < n && cls(t[o]) === 0) o++
	return Math.min(o, n)
}
function wordBack(o: number): number {
	const t = flat()
	o--
	while (o > 0 && cls(t[o]) === 0) o--
	const c = cls(t[o])
	while (o > 0 && cls(t[o - 1]) === c && c !== 0) o--
	return Math.max(0, o)
}
function wordEnd(o: number): number {
	const t = flat()
	const n = t.length
	o++
	while (o < n - 1 && cls(t[o]) === 0) o++
	const c = cls(t[o])
	while (o < n - 1 && cls(t[o + 1]) === c && c !== 0) o++
	return Math.min(o, n - 1)
}

const firstNonBlank = (line: string) => {
	const m = line.match(/^[ \t]*/)
	return Math.min(m![0].length, Math.max(0, line.length - 1))
}

// ── motion resolution for operators & plain movement ───────────────────────────
// Returns a linewise range or a charwise [from,to) span (with an inclusive flag).
type Motion =
	| { kind: 'line'; r1: number; r2: number }
	| { kind: 'char'; from: number; to: number; inclusive: boolean }
	| null

function resolveMotion(key: string, count: number, findCh?: string): Motion {
	const o = toOffset(cy, cx)
	switch (key) {
		case 'h':
			return { kind: 'char', from: toOffset(cy, Math.max(0, cx - count)), to: o, inclusive: false }
		case 'l':
		case ' ':
			return { kind: 'char', from: o, to: toOffset(cy, Math.min(lines[cy].length, cx + count)), inclusive: false }
		case 'j':
			return { kind: 'line', r1: cy, r2: Math.min(lines.length - 1, cy + count) }
		case 'k':
			return { kind: 'line', r1: Math.max(0, cy - count), r2: cy }
		case 'G':
			return { kind: 'line', r1: cy, r2: countBuf ? Math.min(lines.length - 1, count - 1) : lines.length - 1 }
		case 'g': // gg (caller ensures the second g)
			return { kind: 'line', r1: countBuf ? Math.min(lines.length - 1, count - 1) : 0, r2: cy }
		case 'w':
		case 'W': {
			let p = o
			for (let i = 0; i < count; i++) p = wordFwd(p)
			return { kind: 'char', from: o, to: p, inclusive: false }
		}
		case 'b':
		case 'B': {
			let p = o
			for (let i = 0; i < count; i++) p = wordBack(p)
			return { kind: 'char', from: p, to: o, inclusive: false }
		}
		case 'e': {
			let p = o
			for (let i = 0; i < count; i++) p = wordEnd(p)
			return { kind: 'char', from: o, to: p, inclusive: true }
		}
		case '0':
			return { kind: 'char', from: toOffset(cy, 0), to: o, inclusive: false }
		case '^':
			return { kind: 'char', from: toOffset(cy, firstNonBlank(lines[cy])), to: o, inclusive: false }
		case '$':
			return { kind: 'char', from: o, to: toOffset(cy, Math.max(0, lines[cy].length - 1)), inclusive: true }
		case 'f':
		case 't': {
			if (!findCh) return null
			const idx = lines[cy].indexOf(findCh, cx + 1)
			if (idx < 0) return null
			const to = key === 't' ? idx - 1 : idx
			return { kind: 'char', from: o, to: toOffset(cy, to), inclusive: true }
		}
		case 'F':
		case 'T': {
			if (!findCh) return null
			const idx = lines[cy].lastIndexOf(findCh, cx - 1)
			if (idx < 0) return null
			const to = key === 'T' ? idx + 1 : idx
			return { kind: 'char', from: toOffset(cy, to), to: o, inclusive: false }
		}
	}
	return null
}

// Move the cursor per a motion result (plain movement, no operator).
function moveBy(m: Motion, key: string) {
	if (!m) return
	if (m.kind === 'line') {
		cy = key === 'k' || key === 'g' ? m.r1 : m.r2
		if (key === 'g' && countBuf) cy = m.r1
		if (key === 'gg') cy = m.r1
		cx = Math.min(want, Math.max(0, lines[cy].length - 1))
		return
	}
	// charwise: land the cursor on the appropriate end.
	const backward = ['h', 'b', 'B', '0', '^', 'F', 'T'].includes(key)
	const target = backward ? m.from : m.inclusive ? m.to : m.to
	const p = fromOffset(target)
	cy = p.r
	cx = p.c
	want = cx
}

// ── editing primitives ─────────────────────────────────────────────────────────
function deleteRange(m: Motion): Reg | null {
	if (!m) return null
	if (m.kind === 'line') {
		const a = Math.min(m.r1, m.r2)
		const b = Math.max(m.r1, m.r2)
		const removed = lines.slice(a, b + 1)
		lines.splice(a, b - a + 1)
		if (lines.length === 0) lines = ['']
		cy = Math.min(a, lines.length - 1)
		cx = firstNonBlank(lines[cy])
		return { type: 'line', lines: removed }
	}
	let s = m.from
	let e = m.inclusive ? m.to + 1 : m.to
	if (e < s) [s, e] = [e, s]
	const t = flat()
	const removed = t.slice(s, e)
	const nt = t.slice(0, s) + t.slice(e)
	lines = nt.split('\n')
	const p = fromOffset(s)
	cy = p.r
	cx = p.c
	return { type: 'char', text: removed }
}

function applyOperator(o: 'd' | 'c' | 'y', m: Motion) {
	if (!m) return
	if (o === 'y') {
		reg = yankRange(m)
		// yank leaves the cursor at range start for linewise/back motions (vim-ish)
		if (m.kind === 'char') {
			const s = Math.min(m.from, m.inclusive ? m.to + 1 : m.to)
			const p = fromOffset(s)
			cy = p.r
			cx = p.c
		}
		return
	}
	pushUndo()
	const removed = deleteRange(m)
	if (removed) reg = removed
	if (o === 'c') {
		if (m.kind === 'line') {
			// cc: keep an empty line where the range was, insert there.
			lines.splice(cy, 0, '')
			cx = 0
		}
		mode = 'insert'
	}
	clampCursor()
}

function yankRange(m: NonNullable<Motion>): Reg {
	if (m.kind === 'line') {
		const a = Math.min(m.r1, m.r2)
		const b = Math.max(m.r1, m.r2)
		return { type: 'line', lines: lines.slice(a, b + 1) }
	}
	let s = m.from
	let e = m.inclusive ? m.to + 1 : m.to
	if (e < s) [s, e] = [e, s]
	return { type: 'char', text: flat().slice(s, e) }
}

function paste(after: boolean) {
	pushUndo()
	if (reg.type === 'line') {
		const at = after ? cy + 1 : cy
		lines.splice(at, 0, ...reg.lines)
		cy = at
		cx = firstNonBlank(lines[cy])
	} else {
		const parts = reg.text.split('\n')
		const line = lines[cy]
		const at = after ? Math.min(line.length, cx + 1) : cx
		if (parts.length === 1) {
			lines[cy] = line.slice(0, at) + parts[0] + line.slice(at)
			cx = at + parts[0].length - 1
		} else {
			const tail = line.slice(at)
			lines[cy] = line.slice(0, at) + parts[0]
			const mid = parts.slice(1)
			mid[mid.length - 1] += tail
			lines.splice(cy + 1, 0, ...mid)
			cy += parts.length - 1
			cx = Math.max(0, parts[parts.length - 1].length - 1)
		}
	}
	clampCursor()
}

// ── rendering ───────────────────────────────────────────────────────────────────
interface Cell {
	ch: string
	color: string | null
	sel: boolean
}

function selected(r: number, c: number): boolean {
	if (mode === 'vline') {
		const a = Math.min(vAnchor.cy, cy)
		const b = Math.max(vAnchor.cy, cy)
		return r >= a && r <= b
	}
	if (mode === 'visual') {
		const start = toOffset(vAnchor.cy, vAnchor.cx)
		const end = toOffset(cy, cx)
		const [lo, hi] = start <= end ? [start, end] : [end, start]
		const off = toOffset(r, c)
		return off >= lo && off <= hi
	}
	return false
}

function buildCells(row: number): Cell[] {
	const line = lines[row]
	const colors = colorsFor(line)
	const cells: Cell[] = []
	for (let i = 0; i < line.length; i++) {
		const ch = line[i]
		const sel = selected(row, i)
		if (ch === '\t') {
			const w = TAB - (cells.length % TAB)
			for (let k = 0; k < w; k++) cells.push({ ch: ' ', color: null, sel })
		} else {
			cells.push({ ch, color: colors[i], sel })
		}
	}
	// a selection that includes the (virtual) newline shows one trailing cell
	if ((mode === 'vline' || mode === 'visual') && selected(row, line.length)) cells.push({ ch: ' ', color: null, sel: true })
	return cells
}

function renderCells(cells: Cell[], width: number): string {
	let s = ''
	let cur = ''
	for (let i = left; i < left + width; i++) {
		const cell = cells[i]
		const style = cell ? (cell.sel ? '\x1b[7m' : '') + (cell.color || '') : ''
		if (style !== cur) {
			s += C.reset + style
			cur = style
		}
		s += cell ? cell.ch : ' '
	}
	return s + C.reset
}

function adjustScroll() {
	const { rows, cols } = view()
	const h = rows - 1
	if (cy < top) top = cy
	if (cy >= top + h) top = cy - h + 1
	const gw = gutterW()
	const scr = screenXof(lines[cy], cx)
	const textW = cols - gw
	if (scr < left) left = scr
	if (scr >= left + textW) left = scr - textW + 1
	if (left < 0) left = 0
}

function render() {
	clampCursor()
	adjustScroll()
	const { rows, cols } = view()
	const h = rows - 1
	const gw = gutterW()
	const textW = cols - gw
	let buf = '\x1b[?25l\x1b[H' // hide cursor, home
	for (let i = 0; i < h; i++) {
		const row = top + i
		buf += '\x1b[K'
		if (row < lines.length) {
			const num = String(row + 1).padStart(gw - 1)
			buf += (row === cy ? C.gutterCur : C.gutter) + num + ' ' + C.reset
			buf += renderCells(buildCells(row), textW)
		} else {
			buf += C.gutter + '~' + C.reset
		}
		buf += '\r\n'
	}
	// status / command line
	buf += '\x1b[K'
	if (mode === 'command') {
		buf += cmdKind + cmdline
	} else {
		const tag = mode === 'insert' ? '-- INSERT --' : mode === 'visual' ? '-- VISUAL --' : mode === 'vline' ? '-- VISUAL LINE --' : ''
		const name = FILE.replace(process.env.HOME || '~', '~')
		const flag = (newFile ? ' [New]' : '') + (modified() ? ' [+]' : '')
		const leftStr = ` ${tag || name + flag}`
		const rightStr = `${message ? message + '  ' : ''}${cy + 1}:${cx + 1}  ${lines.length}L `
		const pad = Math.max(1, cols - leftStr.length - rightStr.length)
		buf += C.status + leftStr + ' '.repeat(pad) + rightStr + C.reset
	}
	// place & shape the cursor
	if (mode === 'command') {
		out.write(buf + `\x1b[${rows};${1 + cmdKind.length + cmdline.length}H\x1b[6 q\x1b[?25h`)
		return
	}
	const scr = screenXof(lines[cy], cx) - left
	const srow = cy - top + 1
	const scol = gw + scr + 1
	const shape = mode === 'insert' ? '\x1b[6 q' : '\x1b[2 q' // bar vs block
	out.write(buf + `\x1b[${srow};${scol}H${shape}\x1b[?25h`)
}

// ── key input ───────────────────────────────────────────────────────────────────
// Decode a raw stdin chunk into a queue of key tokens.
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
		if (b === 0x12) {
			keys.push('C-r')
			i++
			continue
		}
		if (b === 0x04) {
			keys.push('C-d')
			i++
			continue
		}
		if (b === 0x15) {
			keys.push('C-u')
			i++
			continue
		}
		if (b === 0x06) {
			keys.push('C-f')
			i++
			continue
		}
		if (b === 0x02) {
			keys.push('C-b')
			i++
			continue
		}
		if (b < 0x20) {
			i++
			continue
		}
		// printable, decode UTF-8 width
		let len = 1
		if (b >= 0xf0) len = 4
		else if (b >= 0xe0) len = 3
		else if (b >= 0xc0) len = 2
		keys.push(buf.slice(i, i + len).toString('utf8'))
		i += len
	}
	return keys
}

// ── mode handlers ────────────────────────────────────────────────────────────────
function resetPending() {
	op = ''
	countBuf = ''
	awaitG = false
	awaitReplace = false
	awaitFind = ''
}

function handleNormal(key: string) {
	message = ''
	// pending single-char operations first
	if (awaitReplace) {
		awaitReplace = false
		if (key.length === 1 && key !== 'Esc') {
			pushUndo()
			const line = lines[cy]
			if (cx < line.length) lines[cy] = line.slice(0, cx) + key + line.slice(cx + 1)
		}
		return
	}
	if (awaitFind) {
		const fk = awaitFind
		awaitFind = ''
		if (key.length === 1) {
			const m = resolveMotion(fk, Math.max(1, parseInt(countBuf || '1', 10)), key)
			if (op) applyOperator(op as any, m)
			else moveBy(m, fk)
		}
		resetPending()
		return
	}
	if (awaitG) {
		awaitG = false
		if (key === 'g') {
			const count = parseInt(countBuf || '1', 10)
			const m = resolveMotion('g', count)
			if (op) applyOperator(op as any, { kind: 'line', r1: Math.min((m as any).r1, cy), r2: Math.max((m as any).r1, cy) } as any)
			else {
				cy = countBuf ? Math.min(lines.length - 1, count - 1) : 0
				cx = Math.min(want, Math.max(0, lines[cy].length - 1))
			}
		}
		resetPending()
		return
	}

	// digit → count (0 is a motion only when no count is building)
	if (/[0-9]/.test(key) && !(key === '0' && countBuf === '')) {
		countBuf += key
		return
	}
	const count = Math.max(1, parseInt(countBuf || '1', 10))

	// motions usable as operator targets
	const motionKeys = ['h', 'l', 'j', 'k', 'w', 'W', 'b', 'B', 'e', '0', '^', '$', 'G', 'Left', 'Right', 'Up', 'Down', ' ']
	const normKey = key === 'Left' ? 'h' : key === 'Right' ? 'l' : key === 'Up' ? 'k' : key === 'Down' ? 'j' : key
	if (motionKeys.includes(key) || motionKeys.includes(normKey)) {
		// `cw`/`cW` act like `ce` in vim — they don't swallow the trailing whitespace.
		const mKey = op === 'c' && (normKey === 'w' || normKey === 'W') ? 'e' : normKey
		const m = resolveMotion(mKey, count)
		if (op) {
			applyOperator(op, m)
		} else moveBy(m, normKey)
		resetPending()
		return
	}
	if (key === 'g') {
		awaitG = true
		return
	}
	if (key === 'f' || key === 'F' || key === 't' || key === 'T') {
		awaitFind = key as any
		return
	}

	// operators
	if (key === 'd' || key === 'c' || key === 'y') {
		if (op === key) {
			// doubled: linewise over count lines
			applyOperator(op, { kind: 'line', r1: cy, r2: Math.min(lines.length - 1, cy + count - 1) })
			resetPending()
		} else {
			op = key
			countBuf = ''
		}
		return
	}
	if (op) {
		// an unrecognized key cancels a pending operator
		resetPending()
	}

	switch (key) {
		case 'Esc':
		case 'C-c':
			resetPending()
			break
		case 'i':
			pushUndo()
			mode = 'insert'
			break
		case 'I':
			pushUndo()
			cx = firstNonBlank(lines[cy])
			mode = 'insert'
			break
		case 'a':
			pushUndo()
			cx = Math.min(lines[cy].length, cx + 1)
			mode = 'insert'
			break
		case 'A':
			pushUndo()
			cx = lines[cy].length
			mode = 'insert'
			break
		case 'o':
			pushUndo()
			lines.splice(cy + 1, 0, '')
			cy++
			cx = 0
			mode = 'insert'
			break
		case 'O':
			pushUndo()
			lines.splice(cy, 0, '')
			cx = 0
			mode = 'insert'
			break
		case 'x': {
			pushUndo()
			const line = lines[cy]
			if (line.length) {
				const end = Math.min(line.length, cx + count)
				reg = { type: 'char', text: line.slice(cx, end) }
				lines[cy] = line.slice(0, cx) + line.slice(end)
			}
			clampCursor()
			break
		}
		case 'D':
			applyOperator('d', resolveMotion('$', 1))
			break
		case 'C':
			applyOperator('c', resolveMotion('$', 1))
			break
		case 's':
			pushUndo()
			{
				const line = lines[cy]
				lines[cy] = line.slice(0, cx) + line.slice(Math.min(line.length, cx + count))
			}
			mode = 'insert'
			break
		case 'S':
			applyOperator('c', { kind: 'line', r1: cy, r2: Math.min(lines.length - 1, cy + count - 1) })
			break
		case 'r':
			awaitReplace = true
			break
		case 'p':
			paste(true)
			break
		case 'P':
			paste(false)
			break
		case 'u':
			doUndo()
			break
		case 'C-r':
			doRedo()
			break
		case 'v':
			vAnchor = { cy, cx }
			mode = 'visual'
			break
		case 'V':
			vAnchor = { cy, cx }
			mode = 'vline'
			break
		case ':':
			mode = 'command'
			cmdKind = ':'
			cmdline = ''
			break
		case '/':
			mode = 'command'
			cmdKind = '/'
			cmdline = ''
			break
		case 'n':
			searchNext(1)
			break
		case 'N':
			searchNext(-1)
			break
		case 'C-d':
		case 'PageDown':
		case 'C-f': {
			const { rows } = view()
			const step = key === 'C-d' ? Math.floor(rows / 2) : rows - 2
			cy = Math.min(lines.length - 1, cy + step)
			top = Math.min(Math.max(0, lines.length - 1), top + step)
			break
		}
		case 'C-u':
		case 'PageUp':
		case 'C-b': {
			const { rows } = view()
			const step = key === 'C-u' ? Math.floor(rows / 2) : rows - 2
			cy = Math.max(0, cy - step)
			top = Math.max(0, top - step)
			break
		}
		case 'Home':
			cx = 0
			want = 0
			break
		case 'End':
			cx = Math.max(0, lines[cy].length - 1)
			want = cx
			break
	}
	resetPending()
}

function handleInsert(key: string) {
	const line = lines[cy]
	switch (key) {
		case 'Esc':
		case 'C-c':
			mode = 'normal'
			cx = Math.max(0, cx - 1)
			break
		case 'Enter': {
			const indent = line.match(/^[ \t]*/)![0]
			lines[cy] = line.slice(0, cx)
			lines.splice(cy + 1, 0, indent + line.slice(cx))
			cy++
			cx = indent.length
			break
		}
		case 'Backspace':
			if (cx > 0) {
				lines[cy] = line.slice(0, cx - 1) + line.slice(cx)
				cx--
			} else if (cy > 0) {
				const prev = lines[cy - 1]
				cx = prev.length
				lines[cy - 1] = prev + line
				lines.splice(cy, 1)
				cy--
			}
			break
		case 'Delete':
			if (cx < line.length) lines[cy] = line.slice(0, cx) + line.slice(cx + 1)
			else if (cy < lines.length - 1) {
				lines[cy] = line + lines[cy + 1]
				lines.splice(cy + 1, 1)
			}
			break
		case 'Tab':
			lines[cy] = line.slice(0, cx) + '\t' + line.slice(cx)
			cx++
			break
		case 'Left':
			cx = Math.max(0, cx - 1)
			break
		case 'Right':
			cx = Math.min(line.length, cx + 1)
			break
		case 'Up':
			if (cy > 0) {
				cy--
				cx = Math.min(cx, lines[cy].length)
			}
			break
		case 'Down':
			if (cy < lines.length - 1) {
				cy++
				cx = Math.min(cx, lines[cy].length)
			}
			break
		case 'Home':
			cx = 0
			break
		case 'End':
			cx = line.length
			break
		default:
			if (key.length >= 1 && !key.startsWith('C-') && !['PageUp', 'PageDown'].includes(key)) {
				lines[cy] = line.slice(0, cx) + key + line.slice(cx)
				cx += key.length
			}
	}
	want = cx
}

function handleVisual(key: string) {
	if (key === 'Esc' || key === 'C-c' || key === 'v' || key === 'V') {
		mode = 'normal'
		clampCursor()
		return
	}
	// movement within the selection reuses normal-mode motions
	const normKey = key === 'Left' ? 'h' : key === 'Right' ? 'l' : key === 'Up' ? 'k' : key === 'Down' ? 'j' : key
	if (/[0-9]/.test(key) && !(key === '0' && countBuf === '')) {
		countBuf += key
		return
	}
	const count = Math.max(1, parseInt(countBuf || '1', 10))
	countBuf = ''
	const isLine = mode === 'vline'
	const rangeLine = (): NonNullable<Motion> => ({ kind: 'line', r1: Math.min(vAnchor.cy, cy), r2: Math.max(vAnchor.cy, cy) })
	const rangeChar = (): NonNullable<Motion> => {
		const a = toOffset(vAnchor.cy, vAnchor.cx)
		const b = toOffset(cy, cx)
		return a <= b ? { kind: 'char', from: a, to: b, inclusive: true } : { kind: 'char', from: b, to: a, inclusive: true }
	}
	switch (key) {
		case 'd':
		case 'x':
			pushUndo()
			reg = deleteRange(isLine ? rangeLine() : rangeChar())!
			mode = 'normal'
			clampCursor()
			return
		case 'y':
			reg = yankRange(isLine ? rangeLine() : rangeChar())
			cy = Math.min(vAnchor.cy, cy)
			if (!isLine) cx = Math.min(vAnchor.cx, cx)
			mode = 'normal'
			clampCursor()
			return
		case 'c':
		case 's':
			pushUndo()
			reg = deleteRange(isLine ? rangeLine() : rangeChar())!
			if (isLine) {
				lines.splice(cy, 0, '')
				cx = 0
			}
			mode = 'insert'
			clampCursor()
			return
		case 'g':
			awaitG = true
			return
	}
	if (awaitG) {
		awaitG = false
		if (key === 'g') {
			cy = countBuf ? count - 1 : 0
			cx = Math.min(want, Math.max(0, lines[cy].length - 1))
		}
		return
	}
	const m = resolveMotion(normKey, count)
	if (m) moveBy(m, normKey)
	// keep cx valid for visual (can sit on last char)
	cy = Math.max(0, Math.min(cy, lines.length - 1))
	cx = Math.max(0, Math.min(cx, Math.max(0, lines[cy].length - 1)))
}

function handleCommand(key: string) {
	switch (key) {
		case 'Esc':
		case 'C-c':
			mode = 'normal'
			cmdline = ''
			break
		case 'Enter':
			mode = 'normal'
			if (cmdKind === ':') runEx(cmdline)
			else {
				lastSearch = cmdline
				searchNext(1)
			}
			cmdline = ''
			break
		case 'Backspace':
			if (cmdline.length) cmdline = cmdline.slice(0, -1)
			else {
				mode = 'normal'
			}
			break
		default:
			if (key.length >= 1 && !key.startsWith('C-') && !['Tab', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'Delete', 'PageUp', 'PageDown'].includes(key)) cmdline += key
	}
}

// ── ex commands, search, undo, save ──────────────────────────────────────────────
function runEx(raw: string) {
	const cmd = raw.trim()
	if (/^\d+$/.test(cmd)) {
		cy = Math.max(0, Math.min(parseInt(cmd, 10) - 1, lines.length - 1))
		cx = firstNonBlank(lines[cy])
		return
	}
	const write = () => {
		save()
		message = `"${FILE.split('/').pop()}" written`
	}
	switch (cmd) {
		case 'w':
			write()
			break
		case 'wq':
		case 'x':
		case 'wq!':
			write()
			quit = true
			break
		case 'q':
			if (modified()) message = 'E37: No write since last change (add ! to override)'
			else quit = true
			break
		case 'q!':
			quit = true
			break
		default:
			message = `E492: Not an editor command: ${cmd}`
	}
}

function save() {
	writeFileSync(FILE, lines.join('\n') + '\n')
	base = lines.slice() // we and disk now agree
	newFile = false
}

function searchNext(dir: number) {
	if (!lastSearch) return
	const n = lines.length
	for (let step = 1; step <= n; step++) {
		const r = (((cy + dir * step) % n) + n) % n
		const idx = lines[r].indexOf(lastSearch)
		if (idx >= 0) {
			cy = r
			cx = idx
			want = cx
			return
		}
	}
	// also try the current line ahead of the cursor
	const idx = dir > 0 ? lines[cy].indexOf(lastSearch, cx + 1) : lines[cy].lastIndexOf(lastSearch, Math.max(0, cx - 1))
	if (idx >= 0) {
		cx = idx
		want = cx
	} else message = `E486: Pattern not found: ${lastSearch}`
}

function doUndo() {
	if (!undoStack.length) {
		message = 'Already at oldest change'
		return
	}
	redoStack.push(snapshot())
	const s = undoStack.pop()!
	lines = s.lines
	cy = s.cy
	cx = s.cx
	clampCursor()
}
function doRedo() {
	if (!redoStack.length) {
		message = 'Already at newest change'
		return
	}
	undoStack.push(snapshot())
	const s = redoStack.pop()!
	lines = s.lines
	cy = s.cy
	cx = s.cx
	clampCursor()
}

// ── live sync with the supervisor ─────────────────────────────────────────────────
function sync() {
	if (mode !== 'normal' || op || awaitG || awaitReplace || awaitFind) return
	let disk: string[]
	try {
		disk = toLines(readFileSync(FILE, 'utf8'))
	} catch {
		return
	}
	if (eq(disk, base)) return // no external write since we last synced
	if (!modified()) {
		// clean reload — keep the cursor on the same logical line
		const anchor = lines[cy] ?? ''
		lines = disk
		cy = Math.max(0, Math.min(nearestIndex(lines, anchor, cy), lines.length - 1))
	} else {
		const anchor = lines[cy] ?? ''
		const merged = merge3(lines, base, disk)
		if (!eq(merged, lines)) {
			lines = merged
			cy = Math.max(0, Math.min(nearestIndex(lines, anchor, cy), lines.length - 1))
		}
	}
	base = disk
	clampCursor()
	render()
}

// ── bootstrap ─────────────────────────────────────────────────────────────────────
function restore() {
	out.write('\x1b[2 q\x1b[?25h\x1b[?1049l') // reset cursor shape, show, leave alt screen
	if (process.stdin.isTTY) process.stdin.setRawMode(false)
}

function main() {
	if (!process.stdin.isTTY) {
		console.error('herald tui needs an interactive terminal')
		process.exit(1)
	}
	if (!existsSync(FILE)) {
		// With no explicit arg the default is `.herald`; if that's absent but other
		// `*.herald` files exist, point the user at them rather than opening a stray
		// empty `.herald`. An explicitly named missing file opens as a new buffer.
		if (!argFile) {
			let siblings: string[] = []
			try {
				siblings = readdirSync(dirname(FILE)).filter((f) => f.endsWith('.herald') && f !== '.herald').sort()
			} catch {}
			if (siblings.length) {
				console.error(`no .herald file here. edit one of these instead:\n${siblings.map((s) => `  pnpm herald ${s}`).join('\n')}`)
				process.exit(1)
			}
		}
	}
	const initial = existsSync(FILE) ? readFileSync(FILE, 'utf8') : ''
	newFile = !existsSync(FILE)
	lines = toLines(initial)
	base = lines.slice()
	if (lines.length === 0) lines = ['']

	process.stdin.setRawMode(true)
	process.stdin.resume()
	out.write('\x1b[?1049h') // alt screen
	render()

	process.stdin.on('data', (chunk: Buffer) => {
		for (const key of decodeKeys(chunk)) {
			if (mode === 'insert') handleInsert(key)
			else if (mode === 'command') handleCommand(key)
			else if (mode === 'visual' || mode === 'vline') handleVisual(key)
			else handleNormal(key)
			if (quit) {
				restore()
				process.exit(0)
			}
		}
		render()
	})

	const timer = setInterval(() => {
		try {
			sync()
		} catch {}
	}, POLL_MS)

	out.on('resize', () => render())
	const bye = () => {
		clearInterval(timer)
		restore()
		process.exit(0)
	}
	process.on('SIGTERM', bye)
	process.on('SIGHUP', bye)
	process.on('uncaughtException', (e) => {
		restore()
		console.error(e)
		process.exit(1)
	})
}

const isMain = (() => {
	const entry = process.argv[1]
	if (!entry) return false
	try {
		return statSync(entry).ino === statSync(fileURLToPath(import.meta.url)).ino
	} catch {
		return false
	}
})()

if (isMain) main()
