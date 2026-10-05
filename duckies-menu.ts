// Interactive dashboard for the supervisor's own terminal: colorizes the scrolling log and adds a
// key-triggered popup menu (edit the aliases/macros/widgets YAML in $EDITOR, or add a label to a
// chosen `.dk` file). No alt-screen — the log keeps scrolling; the menu is an in-place block drawn
// below it and erased on close. The supervisor NEVER stops ticking while the menu or editor is open;
// only log OUTPUT is held (buffered) so stdout stays clean for the overlay/editor, then flushed.
//
// Wired from duckies.ts: `log()` routes through `emit()`; `teardown()` restores the terminal on every
// exit path (quit, restart-exit, signal) so the relaunched instance inherits a clean screen.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'

export interface DashboardOpts {
	controlFiles: () => string[]
	configFiles: { aliases: string; macros: string; widgets: string }
	editor: string
	colorEnabled: boolean
}

// Compact log-oriented palette (256-color). Distinct from tui.ts's syntax palette — this colors log
// LINES by category, not `.dk` tokens.
const C = {
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
	if (/\bWARN\b|\bfailed\b|could not|refusing|incomplete|does not exist/i.test(m)) return C.yellow
	if (/^killing|^reaping|^repairing|\bremove\b/i.test(m)) return C.red
	if (/^spawning|worktree add|^symlink(?! remove)/i.test(m)) return C.green
	if (/^send\b|^cmd\b|^resuming/i.test(m)) return C.cyan
	if (/^showing|reveal/i.test(m)) return C.magenta
	if (/^jev\b|attention/i.test(m)) return C.yellow
	if (/duckies agent/i.test(m)) return C.purple
	if (/widget/i.test(m)) return C.grey
	return C.white
}

// Colorize one log message: category color for the whole line, with the leading verb bolded. Returns
// the message untouched when color is off. Pure — unit-tested.
export function colorizeLog(msg: string, color = true): string {
	if (!color) return msg
	const c = categoryColor(msg)
	const sp = msg.indexOf(' ')
	const verb = sp < 0 ? msg : msg.slice(0, sp)
	const rest = sp < 0 ? '' : msg.slice(sp)
	return `${c}${C.bold}${verb}${C.reset}${c}${rest}${C.reset}`
}

// Append `label` as a new column-0 session header at EOF — the minimal `.dk` form for a new session.
// Normalizes trailing newlines and separates from existing content with one blank line. Pure — tested.
export function appendLabel(content: string, label: string): string {
	const body = content.replace(/\n+$/, '')
	return body === '' ? `${label}\n` : `${body}\n\n${label}\n`
}

// Named key tokens decodeKeys emits that are NOT printable input (so text fields can reject them).
const NAMED = new Set(['Up', 'Down', 'Left', 'Right', 'Home', 'End', 'Delete', 'PageUp', 'PageDown', 'Tab', 'Esc', 'Enter', 'Backspace', 'C-c', 'C-r', 'C-d', 'C-u', 'C-f', 'C-b'])

// Decode a raw stdin chunk into key tokens (copied from tui.ts — the supervisor has no editor state to
// share, so a local copy keeps this module free of a circular import).
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

// Start the interactive dashboard: enable raw mode, colorize/buffer log output, and drive the popup
// menu. Returns `emit` (route `log()` here) and `teardown` (restore the terminal, idempotent).
export function startDashboard(opts: DashboardOpts) {
	const out = process.stdout
	const color = opts.colorEnabled
	let modal = false // true while a menu or the editor owns the screen → buffer log output
	const buffer: string[] = []
	let drawn = 0 // lines the current overlay block occupies (for in-place redraw / erase)
	let tornDown = false
	type Mode = 'idle' | 'menu' | 'pick' | 'input'
	let mode: Mode = 'idle'
	let sel = 0
	let pickFiles: string[] = []
	let inputFile = ''
	let inputText = ''

	const ts = () => new Date().toTimeString().slice(0, 8)
	const write = (s: string) => out.write(s)
	// Raw mode doesn't translate \n → \r\n, so every line we print needs an explicit \r.
	const NL = '\r\n'

	// Move the cursor back to the top of the overlay block and clear to end of screen.
	const overlayStart = () => {
		if (drawn) write(`\x1b[${drawn}A`)
		write('\x1b[J')
		drawn = 0
	}
	const paint = (lines: string[]) => {
		overlayStart()
		write(lines.join(NL) + NL)
		drawn = lines.length
	}
	const hideCursor = () => write('\x1b[?25l')
	const showCursor = () => write('\x1b[?25h')

	const emit = (msg: string) => {
		const line = color ? `${C.dim}${ts()}${C.reset} ${colorizeLog(msg, true)}` : `${ts()} ${msg}`
		if (modal) {
			buffer.push(line)
			if (buffer.length > 500) buffer.shift()
			return
		}
		write(line + NL)
	}
	const flush = () => {
		for (const l of buffer) write(l + NL)
		buffer.length = 0
	}

	const menuItems: { key: string; label: string; file: (() => string) | null }[] = [
		{ key: 'a', label: 'Edit aliases', file: () => opts.configFiles.aliases },
		{ key: 'c', label: 'Edit macros', file: () => opts.configFiles.macros },
		{ key: 'w', label: 'Edit widgets', file: () => opts.configFiles.widgets },
		{ key: 'n', label: 'New label…', file: null },
	]

	const paintList = (title: string, rows: string[], selIdx: number, hint: string) => {
		const lines = [color ? `${C.bold}${C.cyan}${title}${C.reset}` : title]
		rows.forEach((r, i) => {
			const base = `  ${i === selIdx ? '›' : ' '} ${r}`
			lines.push(color ? (i === selIdx ? `${C.bold}${C.white}${base}${C.reset}` : `${C.grey}${base}${C.reset}`) : base)
		})
		lines.push(color ? `${C.dim}  ${hint}${C.reset}` : `  ${hint}`)
		paint(lines)
	}

	const drawMenu = () => paintList(' duckies — menu ', menuItems.map((it) => `[${it.key}] ${it.label}`), sel, '↑/↓ · enter · esc')

	const drawPick = () => {
		if (!pickFiles.length) {
			const title = color ? `${C.bold}${C.cyan} new label — pick a .dk file ${C.reset}` : ' new label — pick a .dk file'
			paint([title, color ? `${C.yellow}  (no .dk files in control dir)${C.reset}` : '  (no .dk files in control dir)', color ? `${C.dim}  esc to close${C.reset}` : '  esc to close'])
			return
		}
		paintList(' new label — pick a .dk file ', pickFiles.map((f) => basename(f)), sel, '↑/↓ · enter · esc')
	}

	const drawInput = () => {
		const title = color ? `${C.bold}${C.cyan} new label ${C.reset}${C.dim}in ${basename(inputFile)}${C.reset}` : ` new label in ${basename(inputFile)}`
		const field = `  ${inputText}█`
		paint([title, color ? `${C.white}${field}${C.reset}` : field, color ? `${C.dim}  type a label · enter · esc${C.reset}` : '  type a label · enter · esc'])
	}

	const openMenu = () => {
		modal = true
		mode = 'menu'
		sel = 0
		hideCursor()
		drawMenu()
	}
	// Erase the overlay and return to the scrolling log, flushing anything buffered while it was open.
	const closeOverlay = () => {
		overlayStart()
		showCursor()
		modal = false
		mode = 'idle'
		flush()
	}

	// Open a file in $EDITOR without stopping the supervisor: hand the keyboard to the child (pause our
	// stdin, leave raw mode) while Node keeps ticking; buffer log output so the editor's screen stays
	// clean. On the child's exit, re-enter raw mode and flush what accrued.
	const openEditor = (file: string) => {
		try {
			mkdirSync(dirname(file), { recursive: true })
		} catch {}
		overlayStart()
		modal = true
		mode = 'idle'
		showCursor()
		try {
			if (process.stdin.isTTY) process.stdin.setRawMode(false)
		} catch {}
		process.stdin.pause()
		const child = spawn(opts.editor, [file], { stdio: 'inherit' })
		const done = () => {
			process.stdin.resume()
			try {
				if (process.stdin.isTTY) process.stdin.setRawMode(true)
			} catch {}
			modal = false
			flush()
		}
		child.on('exit', done)
		child.on('error', (e) => {
			emit(`WARN editor ${opts.editor} failed: ${(e as Error).message}`)
			done()
		})
	}

	const activateMenu = (i: number) => {
		const it = menuItems[i]
		if (it.file === null) {
			pickFiles = opts.controlFiles()
			sel = 0
			mode = 'pick'
			drawPick()
			return
		}
		openEditor(it.file())
	}

	const commitInput = () => {
		const label = inputText.trim()
		if (!label) return closeOverlay()
		let content = ''
		try {
			content = readFileSync(inputFile, 'utf8')
		} catch {}
		const tmp = `${inputFile}.tmp`
		writeFileSync(tmp, appendLabel(content, label))
		renameSync(tmp, inputFile)
		emit(`menu: added label ${label} to ${basename(inputFile)}`)
		openEditor(inputFile)
	}

	const teardown = () => {
		if (tornDown) return
		tornDown = true
		overlayStart()
		try {
			if (process.stdin.isTTY) process.stdin.setRawMode(false)
		} catch {}
		showCursor()
		flush()
	}

	const handleKey = (k: string) => {
		if (k === 'C-c') {
			teardown()
			process.exit(130)
		}
		if (mode === 'idle') {
			if (k === 'm') openMenu()
			return
		}
		if (mode === 'menu') {
			if (k === 'Up') sel = (sel - 1 + menuItems.length) % menuItems.length
			else if (k === 'Down') sel = (sel + 1) % menuItems.length
			else if (k === 'Enter') return activateMenu(sel)
			else if (k === 'Esc') return closeOverlay()
			else {
				const i = menuItems.findIndex((it) => it.key === k)
				if (i >= 0) return activateMenu(i)
				return
			}
			drawMenu()
			return
		}
		if (mode === 'pick') {
			if (k === 'Esc') return closeOverlay()
			if (!pickFiles.length) return
			if (k === 'Up') sel = (sel - 1 + pickFiles.length) % pickFiles.length
			else if (k === 'Down') sel = (sel + 1) % pickFiles.length
			else if (k === 'Enter') {
				inputFile = pickFiles[sel]
				inputText = ''
				mode = 'input'
				drawInput()
				return
			} else return
			drawPick()
			return
		}
		if (mode === 'input') {
			if (k === 'Esc') return closeOverlay()
			if (k === 'Enter') return commitInput()
			if (k === 'Backspace') inputText = inputText.slice(0, -1)
			else if (!NAMED.has(k) && (k.codePointAt(0) ?? 0) >= 0x20) inputText += k
			else return
			drawInput()
		}
	}

	try {
		if (process.stdin.isTTY) process.stdin.setRawMode(true)
	} catch {}
	process.stdin.resume()
	process.stdin.on('data', (chunk: Buffer) => {
		for (const k of decodeKeys(chunk)) handleKey(k)
	})

	return { emit, teardown }
}
