#!/usr/bin/env tsx
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fire } from '@jgjp/fire'
import { $, sleep, YAML } from 'zx'

const HERE = dirname(fileURLToPath(import.meta.url))
// The controller merges every `*.herald` file in the control dir (default: the repo
// dir) into one logical control — each file is an independent slice of sessions and
// is rewritten in place. `HERALD_DIR` overrides the dir; `HERALD_FILE` forces
// single-file mode (one explicit file, mainly for tests/one-offs).
const CONTROL_DIR = process.env.HERALD_DIR ? resolve(process.env.HERALD_DIR) : HERE
const SINGLE_FILE = process.env.HERALD_FILE ? resolve(process.env.HERALD_FILE) : null
const CONTROL_EXT = '.herald'
// Optional YAML file of `label: /path/to/repo` aliases, so a header in a `.herald`
// file can be a short label instead of a full path.
const ALIASES_FILE = process.env.HERALD_ALIASES ? resolve(process.env.HERALD_ALIASES) : join(HERE, 'herald-aliases.yaml')
const STATE = join(HERE, 'state')
const RT_PATH = join(STATE, 'controller.json')
const LOCK = join(STATE, 'supervisor.lock')
// Where a bare session name (not a path or alias) resolves: `<DEV_DIR>/<name>`.
// `HERALD_DEV_DIR` overrides it; defaults to `~/_dev`.
const DEV_DIR = process.env.HERALD_DEV_DIR ? resolve(process.env.HERALD_DEV_DIR) : join(homedir(), '_dev')
// The command typed into a fresh claude pane to launch the agent. `HERALD_AGENT_CMD`
// overrides it (e.g. a wrapper script or a different agent CLI).
const AGENT_CMD = process.env.HERALD_AGENT_CMD || 'claude'
// Instruction appended to every herald-launched claude: end each turn with a one-line `-> `
// summary, which the note pass mirrors into the `.herald` file below the finished prompt.
// Skipped when HERALD_AGENT_CMD is a non-claude wrapper (the flag wouldn't exist).
const NOTE_PROMPT =
	'When you finish responding to a prompt in this session, end your final message with a single line beginning with -> that gives a concise one-line summary of what you did.'
const LAUNCH_CMD = /(^|[\s/])claude(\s|$)/.test(AGENT_CMD) ? `${AGENT_CMD} --append-system-prompt '${NOTE_PROMPT}'` : AGENT_CMD
// macOS only: the terminal app to bring to the foreground on a `show`/`!`, so a reveal
// surfaces the window even under another app. Opt-in via `HERALD_TERM_APP` (e.g. `WezTerm`,
// `iTerm`, `Terminal`); unset ⇒ no app foregrounding (the tmux client still switches).
const TERM_APP = process.env.HERALD_TERM_APP
// Labels the controller never manages (a blacklist). Empty by default.
const RESERVED = new Set<string>([])
const TICK_MS = 1000
// Grace period for a freshly launched claude to boot before we send its first prompt.
const READY_MS = Number(process.env.HERALD_READY_MS) || 6000
const DRY = process.argv.includes('--dry-run')

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`)

const expandHome = (p: string): string =>
	p.startsWith('~') ? join(homedir(), p.slice(p[1] === '/' ? 2 : 1)) : p

// An alias value is either a bare path, or an object with the path plus optional worktree
// setup: `worktree/cmd` (shell commands run in a freshly created worktree) and
// `worktree/copy` (files/dirs copied in from the base repo, e.g. gitignored `.env`).
export interface AliasEntry {
	dir: string
	'worktree/cmd'?: string[]
	'worktree/copy'?: string[]
}
export type Aliases = Record<string, string | AliasEntry>
const aliasDir = (e: string | AliasEntry): string => (typeof e === 'string' ? e : e.dir)
// The worktree setup for an alias entry (undefined for a bare-path alias, a path header, or a
// bare name — only the object form carries it).
export const aliasWorktree = (e: string | AliasEntry | undefined): { cmd?: string[]; copy?: string[] } | undefined =>
	e && typeof e === 'object' ? { cmd: e['worktree/cmd'], copy: e['worktree/copy'] } : undefined

// Resolve a session header to a tmux label and working dir. Precedence:
//   1. an exact alias key → label = the alias, dir = its mapped path;
//   2. a path (bare `/`, `~/…`, or anything with `/`) → that dir, label = basename;
//   3. a bare name → dir `~/_dev/<name>`, label = name.
function resolveTarget(header: string, aliases: Aliases = {}): { label: string; dir: string } {
	if (aliases[header]) return { label: header, dir: resolve(expandHome(aliasDir(aliases[header]))) }
	if (header.startsWith('/') || header.startsWith('~') || header.includes('/')) {
		const dir = resolve(expandHome(header))
		return { label: basename(dir), dir }
	}
	return { label: header, dir: join(DEV_DIR, header) }
}

// Load the label→(path | {dir, worktree/*}) alias map, tolerating a missing/empty/malformed
// file. A string value is a bare path; an object must carry a string `dir` (plus optional
// string-array `worktree/cmd` and `worktree/copy`); anything else is dropped.
function loadAliases(): Aliases {
	try {
		const parsed = YAML.parse(readFileSync(ALIASES_FILE, 'utf8'))
		if (!parsed || typeof parsed !== 'object') return {}
		const out: Aliases = {}
		const strs = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined)
		for (const [k, v] of Object.entries(parsed)) {
			if (typeof v === 'string') out[k] = v
			else if (v && typeof v === 'object' && typeof (v as AliasEntry).dir === 'string') {
				out[k] = { dir: (v as AliasEntry).dir, 'worktree/cmd': strs((v as AliasEntry)['worktree/cmd']), 'worktree/copy': strs((v as AliasEntry)['worktree/copy']) }
			}
		}
		return out
	} catch {
		return {}
	}
}

// Optional YAML file of `name: |<multiline block>` macros. A `@name` line in a `.herald`
// file is one queue item that expands IN MEMORY to that block's steps (see macroSteps).
const MACROS_FILE = process.env.HERALD_MACROS ? resolve(process.env.HERALD_MACROS) : join(HERE, 'herald-macros.yaml')
export type Macros = Record<string, string>

// Load the `@name`→block macro map, tolerating a missing/empty/malformed file.
function loadMacros(): Macros {
	try {
		const parsed = YAML.parse(readFileSync(MACROS_FILE, 'utf8'))
		if (!parsed || typeof parsed !== 'object') return {}
		const out: Macros = {}
		for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v
		return out
	} catch {
		return {}
	}
}

// One runnable line of a macro's body, args already filled: a claude prompt, or (with a `$`
// sigil) a shell command. `#` comment lines are dropped when building these.
export interface MacroStep {
	text: string
	isCmd: boolean
}
// A `@<name> [args…]` line (any indent) is a macro call: one queue item whose body expands
// IN MEMORY to a sequence of steps run one at a time, while the file keeps the `@name` line
// and gets a single overall marker. `{0}`,`{1}`,… are the positional args (0-based;
// quote-aware so `"two words"` is one arg), `{*}` is all of them space-joined, a missing one
// is blank. Braces avoid clashing with herald's own `$N`/`:N` lane sigils. A name char must
// follow the `@`, so a body line like `@@@…` never matches.
const MACRO_RE = /^([ \t]*)@([\w-]+)(?:[ \t]+(.*\S))?[ \t]*$/
const macroArgs = (s: string): string[] => (s.match(/"[^"]*"|\S+/g) ?? []).map((a) => (a.startsWith('"') && a.endsWith('"') ? a.slice(1, -1) : a))
const fillArgs = (text: string, args: string[]): string => text.replace(/\{\*\}/g, args.join(' ')).replace(/\{(\d+)\}/g, (_, d) => args[+d] ?? '')
// Expand a macro body into steps, in RUN order: fill args, drop blank and `#` comment lines,
// classify each remaining line as a `$`command or a prompt, and reverse so they run
// bottom-to-top like every other herald queue (the body's last line runs first). A step's
// own lane sigil is ignored — the steps run in the macro item's own lane.
export function macroSteps(body: string, args: string[]): MacroStep[] {
	return body
		.replace(/\n+$/, '')
		.split('\n')
		.map((b) => fillArgs(b, args).trim())
		.filter((b) => b !== '' && !BARRIER_RE.test(b))
		.map((b) => (CMD_RE.test(b) ? { text: b.replace(CMD_RE, ''), isCmd: true } : { text: b.replace(PROMPT_RE, ''), isCmd: false }))
		.reverse()
}

// ---------------------------------------------------------------- parse model

type Kind = 'EXECUTING' | 'DONE' | 'ATTENTION'
const MARKER: Record<Kind, string> = {
	EXECUTING: '[EXECUTING]',
	DONE: '[DONE]',
	ATTENTION: '[NEEDS ATTENTION]',
}
interface Prompt {
	text: string
	// Position in this item's own file (what buildOps rewrites). Distinct from `order`
	// so a label merged across files still writes each marker back to the right file.
	lineIdx: number
	// The last line this item spans: its own line, or the last of the deeper-indented
	// continuation lines that form its multiline body. The status marker is inserted after
	// this (below the body), not right under the prompt line.
	bodyEndIdx: number
	// The item's place in the drain order. For a single-file session this equals
	// `lineIdx`; when a label is merged across files, mergeSessions renumbers it so every
	// file's rows form one bottom-to-top queue. The queue logic orders by this, never by
	// `lineIdx`.
	order: number
	indent: string
	marker: { kind: Kind; lineIdx: number } | null
	desiredKind: Kind | null
	// A `-> <summary>` line already present below this prompt (a one-liner mirrored from the
	// claude turn that finished it). Inert; kept so buildOps never re-adds it.
	note?: { text: string; lineIdx: number } | null
	// A summary to write below this prompt this tick (set by the note pass when the prompt
	// completes). buildOps inserts it just below the marker/body when there's no `note` yet.
	desiredNote?: string | null
	// A `$command` line: runs once in the session's shell window, then is marked
	// [DONE] like a finished prompt. It never enters the claude prompt queue.
	isCmd: boolean
	// An indented `#` line: a human-action barrier. It never runs or gets a marker;
	// when the drain reaches it the queue halts there (in its lane) until the line is
	// removed. It reads as a comment (comment-scoped, ignored as a task). A column-0
	// `#` is a plain comment instead — skipped in parse, never a barrier.
	isBarrier: boolean
	// A `@name` macro call: one queue item whose `steps` (the expanded, arg-filled body)
	// run in sequence in this lane. The runtime's `macroStep` cursor tracks which is
	// current; the item carries a single overall marker (the file keeps the `@name` line).
	isMacro?: boolean
	steps?: MacroStep[]
	// The 1-based lane/pane this item belongs to. `:`/`$` are lane 1 (today's single
	// queue); `:2`/`::`, `$2`/`$$` are lane 2, and so on. Within a lane items serialize
	// bottom-to-top (claude window for prompts, shell for `$`); different lanes run
	// concurrently, each in its own claude<N>/shell<N> window.
	pane: number
	// A bare `show` line: a queue item that, when the drain reaches it (the item
	// below is done), switches the attached tmux client to this session. It fires
	// instantly and never gets a marker; `fired` is set that tick so buildOps
	// deletes the line — the request is consumed, not left as clutter.
	isShow: boolean
	fired: boolean
	// A `!` appended to this item — either to its status marker (`[NEEDS ATTENTION]!`)
	// or directly to its own line (`: do the thing !`, `$ run me !`) — is a one-shot
	// "reveal this item's window now" request, like `!` on a header. It fires once
	// (`showNowFired`) and buildOps strips the `!`, consuming the request.
	showNow?: boolean
	showNowFired?: boolean
	// The `!` is on this item's own line (not its marker), so consuming it rewrites
	// that line to `strippedLine` (the line without the trailing `!`).
	showNowInline?: boolean
	strippedLine?: string
}
interface Session {
	label: string
	dir: string
	// Set when this session is a git worktree of another repo (an indented, non-sigil line
	// under a header): the repo `dir` was worktree'd from. Its `dir` (under
	// `<repo>/../<repo>-worktrees/<name>`) is created on demand — `git worktree add --detach` — the
	// first tick the worktree has work, then spawned like any session.
	worktreeBase?: string
	// Worktree setup from the base repo's alias entry (`worktree/cmd`, `worktree/copy`): shell
	// commands to run in a freshly created worktree and files/dirs to copy in from the base.
	// Set on a repo header from its alias and inherited by its worktree children.
	worktreeCmd?: string[]
	worktreeCopy?: string[]
	headerIdx: number
	lastChildIdx: number
	prompts: Prompt[]
	sessionMarker: { text: string; lineIdx: number } | null
	desiredSession: string | null
	// The header text with any trailing `!` stripped (what to rewrite the line to
	// once a "show now" request is consumed).
	header: string
	// The header line's leading whitespace: '' for a column-0 repo header, the tab run
	// for an indented worktree label. buildOps prepends it when rewriting the line so a
	// consumed worktree `!` keeps its indentation.
	indent?: string
	// A `!` suffix on the header ("show now"): switch the tmux client to this session
	// immediately, regardless of the queue. `showNowFired` is set the tick we act on
	// it, so buildOps strips the `!` — a one-shot request.
	showNow: boolean
	showNowFired: boolean
	// Set only on a merged logical session (a label that appears in >1 file): the
	// per-file sessions it combines, primary (first file) first. planQueue drives the
	// merged session; buildOps still runs on each part, and the tick syncs session-level
	// markers (desiredSession / showNow) back to the primary part. Undefined otherwise.
	parts?: Session[]
}

// A prompt line starts with `prompt:` or the shorthand `:`. A run of colons or a
// trailing number selects the lane/pane: `:`→1, `::`/`:2`→2, `:::`/`:3`→3, …
const PROMPT_RE = /^(?:prompt:|(:+)(\d*))\s*/i
// A command line starts with `$` (runs in the shell window); `$$`/`$2`→lane 2, etc.
const CMD_RE = /^(\$+)(\d*)\s*/
// An indented `#` line is a barrier (halts the drain); `##`/`#2` halt lane 2 only, etc.
const BARRIER_RE = /^(#+)(\d*)\s*/
// A `|` line continues the prompt above it as a multiline body (YAML block-scalar style):
// each body line is prefixed so it's unambiguous — never mistaken for a worktree — and its
// own indentation is preserved. The `|` and one optional following space are stripped; the
// rest (incl. any further leading spaces) is the literal text. A bare `|` is a blank line.
const CONT_RE = /^\|[ ]?/
// A `-> ` line is a one-line summary herald mirrored below a finished prompt (see the note
// pass): inert (never runs, no marker), attached to the prompt above it. Recognised here so a
// non-sigil indented line isn't misread as a worktree. The `->` and one optional space strip.
const NOTE_RE = /^->[ ]?/
// A sigil run of length `run` (e.g. `::` → 2) or an explicit `digits` suffix (which
// wins) picks the 1-based lane. `prompt:`/plain sigils fall through to lane 1.
const paneFromSigil = (run: string | undefined, digits: string | undefined): number => (digits ? Math.max(1, parseInt(digits, 10) || 1) : run ? run.length : 1)
const isAttention = (x: string | null): boolean => !!x && /NEEDS ATTENTION/i.test(x)
const clearAttention = (s: Session) => {
	if (isAttention(s.desiredSession)) s.desiredSession = null
}

export function parse(content: string, aliases: Aliases = {}, macros: Macros = {}): { lines: string[]; sessions: Session[] } {
	const lines = content.split('\n')
	// The whole file is the sessions region; keep your backlog/footer in other
	// files. Blank lines are skipped, so nothing else is preserved verbatim.
	const sessions: Session[] = []
	let cur: Session | null = null
	// The prompt/command a deeper-indented line would continue. Set right after a `:`/`$`
	// line, cleared by anything else (header, marker, barrier, blank-separated item).
	let lastPrompt: Prompt | null = null
	// The enclosing repo/worktree stack (by indent). Queue items attach to the deepest one
	// they sit under; a non-sigil line opens a new worktree container. Reset per header.
	let containers: { indent: number; session: Session }[] = []
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		if (line.trim() === '') continue
		const tabs = line.match(/^\t*/)?.[0] ?? ''
		if (tabs.length === 0) {
			lastPrompt = null
			// A column-0 `#` is a plain comment (it sits between sessions, so there is no
			// queue to halt): ignored and preserved verbatim, like a blank line. It also
			// closes the current session block, so an indented line beneath it (e.g. a
			// deeper `#` note) isn't captured as that session's barrier/worktree/prompt.
			if (line.trim().startsWith('#')) {
				cur = null
				containers = []
				continue
			}
			const raw = line.trim()
			// A trailing `!` on the header means "show this session immediately".
			const showNow = raw.endsWith('!')
			const header = showNow ? raw.slice(0, -1).trimEnd() : raw
			const { label, dir } = resolveTarget(header, aliases)
			const wtCfg = aliasWorktree(aliases[header])
			cur = {
				label,
				dir,
				worktreeCmd: wtCfg?.cmd,
				worktreeCopy: wtCfg?.copy,
				headerIdx: i,
				lastChildIdx: i,
				prompts: [],
				sessionMarker: null,
				desiredSession: null,
				header,
				indent: '',
				showNow,
				showNowFired: false,
			}
			sessions.push(cur)
			containers = [{ indent: 0, session: cur }]
			continue
		}
		if (!cur) continue
		cur.lastChildIdx = i
		const t = line.trim()
		// A `|` line continues the prompt above it — a multiline body (e.g. a pasted error),
		// YAML block-scalar style. The `|` prefix makes each body line explicit, so it's never
		// confused with a worktree; the text after `| ` (indentation preserved) folds in and the
		// whole thing is sent as one multiline prompt. A run of `|` lines chains; anything else
		// ends the body.
		if (lastPrompt && CONT_RE.test(t)) {
			lastPrompt.text += `\n${t.replace(CONT_RE, '')}`
			lastPrompt.bodyEndIdx = i
			continue
		}
		lastPrompt = null
		// Route this line to its container — the deepest repo/worktree it sits under. A
		// deeper indent nests; a shallower/equal one pops back out to an ancestor.
		const d = tabs.length
		while (containers.length > 1 && containers[containers.length - 1].indent >= d) containers.pop()
		const target = containers[containers.length - 1].session
		// Track the deepest container's last child too, so a worktree's session marker (e.g.
		// [NO DIR …]) is inserted below the worktree's own block, not the repo's.
		target.lastChildIdx = i
		const macroMatch = t.match(MACRO_RE)
		if (macroMatch && macros[macroMatch[2]] !== undefined) {
			// A `@name [args]` call: one item whose body expands in memory to `steps`. The
			// file keeps this line; buildOps writes a single overall marker below it.
			target.prompts.push({
				text: t,
				lineIdx: i,
				bodyEndIdx: i,
				order: i,
				indent: tabs,
				marker: null,
				desiredKind: null,
				isCmd: false,
				isBarrier: false,
				pane: 1,
				isShow: false,
				fired: false,
				isMacro: true,
				steps: macroSteps(macros[macroMatch[2]], macroMatch[3] ? macroArgs(macroMatch[3]) : []),
			})
		} else if (PROMPT_RE.test(t) || CMD_RE.test(t)) {
			// A space-separated trailing `!` on a prompt or `$command` line means "reveal
			// this item's window now" (the shell for a command, the claude pane
			// otherwise), just like `!` on its marker. The space keeps ordinary end
			// punctuation (`: ship it!`) as text; only `: ship it !` is a reveal. It's
			// stripped from the line once consumed.
			const isCmd = CMD_RE.test(t)
			const re = isCmd ? CMD_RE : PROMPT_RE
			const m = t.match(re)!
			const pane = paneFromSigil(m[1], m[2])
			const bang = /\s!$/.test(t)
			const body = bang ? t.slice(0, -1).trimEnd() : t
			const item: Prompt = {
				text: body.replace(re, ''),
				lineIdx: i,
				bodyEndIdx: i,
				order: i,
				indent: tabs,
				marker: null,
				desiredKind: null,
				isCmd,
				isBarrier: false,
				pane,
				isShow: false,
				fired: false,
				showNow: bang || undefined,
				showNowInline: bang || undefined,
				strippedLine: bang ? tabs + body : undefined,
			}
			target.prompts.push(item)
			// Only a `:`/`$` item takes a multiline body; markers/barriers/shows do not.
			lastPrompt = item
		} else if (BARRIER_RE.test(t)) {
			// An indented `#` line is a human-action barrier that halts its lane's drain.
			const m = t.match(BARRIER_RE)!
			target.prompts.push({
				text: t.replace(BARRIER_RE, ''),
				lineIdx: i,
				bodyEndIdx: i,
				order: i,
				indent: tabs,
				marker: null,
				desiredKind: null,
				isCmd: false,
				isBarrier: true,
				pane: paneFromSigil(m[1], m[2]),
				isShow: false,
				fired: false,
			})
		} else if (/^show$/i.test(t) || t === '!') {
			// A bare `!` line is shorthand for `show`.
			target.prompts.push({
				text: '',
				lineIdx: i,
				bodyEndIdx: i,
				order: i,
				indent: tabs,
				marker: null,
				desiredKind: null,
				isCmd: false,
				isBarrier: false,
				pane: 1,
				isShow: true,
				fired: false,
			})
		} else if (/^\[.*\]!?$/.test(t)) {
			// A trailing `!` on a marker means "reveal this item's window now".
			const bang = t.endsWith('!')
			const body = bang ? t.slice(0, -1).trimEnd() : t
			const kind: Kind | null = /executing/i.test(body)
				? 'EXECUTING'
				: /attention/i.test(body)
					? 'ATTENTION'
					: /done/i.test(body)
						? 'DONE'
						: null
			// A status marker attaches to the nearest preceding prompt (in this container)
			// without a marker; anything unrecognised (e.g. [NO DIR …]) is a session marker.
			const owner = kind ? [...target.prompts].reverse().find((p) => !p.marker && !p.isBarrier && !p.isShow) : undefined
			if (kind && owner) {
				owner.marker = { kind, lineIdx: i }
				owner.desiredKind = kind
				if (bang) owner.showNow = true
			} else {
				target.sessionMarker = { text: body, lineIdx: i }
				target.desiredSession = body
			}
		} else if (NOTE_RE.test(t)) {
			// A `-> <summary>` line herald wrote below a finished prompt. Inert (no marker, never
			// runs); attach it to the nearest preceding prompt so buildOps won't re-add it. It's
			// caught here, before the worktree case, so the non-sigil line isn't read as a worktree.
			const owner = [...target.prompts].reverse().find((p) => !p.isBarrier && !p.isShow)
			if (owner) owner.note = { text: t.replace(NOTE_RE, ''), lineIdx: i }
		} else {
			// A non-sigil indented line names a git worktree of its container's repo. It's a
			// child session whose dir (<repo>/../<repo>-worktrees/<name>) is created on demand — only
			// once it has queued work below it; an empty one is just an inert note. A trailing
			// `!` means "show this worktree now", like on a repo header; it's stripped from the
			// name (so the tmux label and dir stay clean) and consumed once acted on.
			const showNow = t.endsWith('!')
			const name = showNow ? t.slice(0, -1).trimEnd() : t
			// The tmux label prefixes the container's label onto the worktree name (`app-4-feat`),
			// so the worktree's session sorts next to its repo's `__app-4` in `tmux ls` and two
			// same-named worktrees under different repos never collide. `-` keeps it safe as both
			// a tmux session name (no `.`/`:`) and a state filename (no `/`). The on-disk name and
			// dir leaf stay bare (`feat`) — only the runtime identity carries the prefix.
			const wt: Session = {
				label: `${target.label}-${name}`,
				dir: join(dirname(target.dir), `${basename(target.dir)}-worktrees`, name),
				worktreeBase: target.dir,
				worktreeCmd: target.worktreeCmd,
				worktreeCopy: target.worktreeCopy,
				headerIdx: i,
				lastChildIdx: i,
				prompts: [],
				sessionMarker: null,
				desiredSession: null,
				header: name,
				indent: line.slice(0, line.length - line.trimStart().length),
				showNow,
				showNowFired: false,
			}
			sessions.push(wt)
			containers.push({ indent: d, session: wt })
		}
	}
	return { lines, sessions }
}

// ------------------------------------------------- lossless in-place rewrite

type Op = { pos: number; type: 'replace' | 'delete' | 'insert'; text?: string }

export function buildOps(sessions: Session[]): Op[] {
	const ops: Op[] = []
	for (const s of sessions) {
		for (const p of s.prompts) {
			// A fired `show` item is consumed by deleting its line; it has no marker.
			if (p.isShow) {
				if (p.fired) ops.push({ pos: p.lineIdx, type: 'delete' })
				continue
			}
			// A fired inline `!` sits on the item's own line, which the marker logic
			// below never rewrites, so strip it here unconditionally.
			if (p.showNowFired && p.showNowInline && p.strippedLine !== undefined) ops.push({ pos: p.lineIdx, type: 'replace', text: p.strippedLine })
			// Mirror a one-line summary below the prompt, once. Anchored at the marker line so it
			// lands just below [DONE] (or the body, if the marker was never written); a same-tick
			// marker replace/delete stays above it, since applyOps orders an insert after ops at
			// the same position. Skipped once the `-> ` line exists (idempotent).
			if (p.desiredNote != null && !p.note) ops.push({ pos: p.marker ? p.marker.lineIdx : p.bodyEndIdx, type: 'insert', text: `${p.indent}\t-> ${p.desiredNote}` })
			const cur = p.marker?.kind ?? null
			if (cur === p.desiredKind) {
				// A fired marker `!` ("reveal now") is consumed by stripping the `!`.
				if (p.showNowFired && !p.showNowInline && p.marker) ops.push({ pos: p.marker.lineIdx, type: 'replace', text: `${p.indent}\t${MARKER[cur!]}` })
				continue
			}
			if (p.marker) {
				if (p.desiredKind === null) ops.push({ pos: p.marker.lineIdx, type: 'delete' })
				else ops.push({ pos: p.marker.lineIdx, type: 'replace', text: `${p.indent}\t${MARKER[p.desiredKind]}` })
			} else if (p.desiredKind !== null) {
				ops.push({ pos: p.bodyEndIdx, type: 'insert', text: `${p.indent}\t${MARKER[p.desiredKind]}` })
			}
		}
		// A fired "show now" (`!` on a repo header or worktree label) is consumed by
		// stripping the `!`; the leading indent (empty for a repo header) is preserved.
		if (s.showNow && s.showNowFired) ops.push({ pos: s.headerIdx, type: 'replace', text: `${s.indent ?? ''}${s.header}` })
		const cur = s.sessionMarker?.text ?? null
		if (cur === s.desiredSession) continue
		if (s.sessionMarker) {
			if (s.desiredSession === null) ops.push({ pos: s.sessionMarker.lineIdx, type: 'delete' })
			else ops.push({ pos: s.sessionMarker.lineIdx, type: 'replace', text: `${s.indent ?? ''}\t${s.desiredSession}` })
		} else if (s.desiredSession !== null) {
			ops.push({ pos: s.lastChildIdx, type: 'insert', text: `${s.indent ?? ''}\t${s.desiredSession}` })
		}
	}
	return ops
}

export function applyOps(lines: string[], ops: Op[]): string[] {
	const out = [...lines]
	const key = (o: Op) => o.pos + (o.type === 'insert' ? 0.5 : 0)
	for (const op of [...ops].sort((a, b) => key(b) - key(a))) {
		if (op.type === 'replace') out[op.pos] = op.text!
		else if (op.type === 'delete') out.splice(op.pos, 1)
		else out.splice(op.pos + 1, 0, op.text!)
	}
	return out
}

// ---------------------------------------------------- capture-to-file placement

// A manually-typed item captured from a live pane: a claude prompt (isCmd false) or a shell
// command (isCmd true), with herald's own sends already filtered out.
export interface CaptureItem {
	text: string
	isCmd: boolean
}
// Place a batch of manually-typed items into lane `n` as its newest rows — a faithful log of
// what just ran in the pane. The block is inserted just above the lane's frontier (its single
// marker), and that one marker is handed to the block's newest item: [EXECUTING] if that's a
// live claude prompt (the reconcile loop then tracks it to [DONE] like any prompt), else
// [DONE] for a finished command. The previous frontier and the older rows in the block are
// left unmarked — they now sit below the divider, i.e. already run. A multiline prompt is
// written with `|` continuation lines. Returns the insert line index (place the block before
// it), the block's lines, the prior frontier to clear, and whether the new marker is
// [EXECUTING]. Null when there's nothing to place. Pure so it's unit-testable.
export function planCapture(s: Session, n: number, items: CaptureItem[]): { at: number; lines: string[]; clear: Prompt | null; executing: boolean } | null {
	if (!items.length) return null
	const laneItems = s.prompts.filter((p) => p.pane === n)
	const marked = laneItems.filter((p) => p.desiredKind !== null)
	const frontier = marked.length ? marked.reduce((a, b) => (b.order < a.order ? b : a)) : null
	const indent = frontier?.indent ?? laneItems[0]?.indent ?? `${s.indent ?? ''}\t`
	const sig = n > 1 ? String(n) : ''
	const render = (it: CaptureItem): string[] => {
		if (it.isCmd) return [`${indent}$${sig} ${it.text}`]
		const [first, ...more] = it.text.split('\n')
		return [`${indent}:${sig} ${first}`, ...more.map((r) => `${indent}|${r === '' ? '' : ` ${r}`}`)]
	}
	const prompts = items.filter((it) => !it.isCmd)
	// A finished command captured while a live prompt still holds the lane's [EXECUTING] marker
	// (its claude turn is running in the other pane): log the command(s) as already-run rows just
	// below that prompt, without stealing its marker — the shell and claude panes run at once, so
	// the prompt must stay the tracked frontier.
	if (!prompts.length && frontier?.desiredKind === 'EXECUTING') {
		const at = (frontier.marker?.lineIdx ?? frontier.bodyEndIdx) + 1
		return { at, lines: [...items].reverse().flatMap(render), clear: null, executing: false }
	}
	// Otherwise the block's newest item becomes the frontier and takes the lane's one marker:
	// [EXECUTING] for a live prompt (preferred, so a claude turn is tracked), else [DONE] for a
	// finished command. It's inserted just above the prior frontier (between it and the pending
	// rows), or at the bottom of the block when nothing has run yet. The prior frontier and the
	// older rows in the block are left unmarked — they now sit below the divider (already run).
	const at = frontier ? frontier.lineIdx : s.lastChildIdx + 1
	const head = prompts.length ? prompts[prompts.length - 1] : items[items.length - 1]
	const rest = items.filter((it) => it !== head).reverse()
	const executing = !head.isCmd
	const lines = [...render(head), `${indent}\t${executing ? MARKER.EXECUTING : MARKER.DONE}`, ...rest.flatMap(render)]
	return { at, lines, clear: frontier, executing }
}

// Merge the per-file session lists (in file order) into one logical session per label.
// tmux labels are global, so a label that appears in several files (or twice in one) is
// combined into ONE entry whose queue is every occurrence's rows concatenated in file
// order — `order` renumbers them into a single bottom-to-top drain. The prompt objects
// are shared, so planQueue's marker mutations flow back to each file via buildOps (which
// still runs per file, each writing only its own rows). Session-level fields come from
// the first (primary) part; `parts` lets the tick sync session markers back to it.
export function mergeSessions(perFile: Session[][]): { sessions: Session[]; labels: Set<string> } {
	const labels = new Set<string>()
	const groups = new Map<string, Session[]>()
	for (const group of perFile) {
		for (const s of group) {
			if (RESERVED.has(s.label)) continue
			if (!groups.has(s.label)) {
				groups.set(s.label, [])
				labels.add(s.label)
			}
			groups.get(s.label)!.push(s)
		}
	}
	const sessions: Session[] = []
	for (const parts of groups.values()) {
		if (parts.length === 1) {
			sessions.push(parts[0])
			continue
		}
		const merged: Session = { ...parts[0], prompts: parts.flatMap((s) => s.prompts), parts }
		merged.prompts.forEach((p, i) => (p.order = i)) // one cross-file drain sequence
		for (const sec of parts.slice(1)) sec.desiredSession = null // drop any stale [DUPLICATE]
		sessions.push(merged)
	}
	return { sessions, labels }
}

// --------------------------------------------------------------- runtime state

// Per-lane queue state. Each lane (pane) is an independent serial queue, so its
// timers/counters are tracked separately; planQueue reads/writes exactly these fields.
interface LaneRt {
	sentAt: number
	// When the in-flight shell command was dispatched; its done-file must be
	// newer than this to count as finished.
	cmdSentAt: number
	prevPromptCount: number
	// Cursor into the active macro item's steps (which one is running). Only one item is
	// active per lane, so a single cursor suffices; persisted so a macro resumes mid-run.
	macroStep?: number
	// A lane whose claude pane was just created boots before it can take prompts
	// (n>1 only; lane 1's claude boots with the session, gated by RtEntry.starting).
	starting: boolean
	startedAt: number
	// The last few prompts/commands this lane sent, kept so the capture pass can tell
	// herald's own sends (which re-fire the same UserPromptSubmit/post-command hooks) from
	// input a human typed straight into the pane. Each is matched-and-dropped once.
	pendingSent?: string[]
	pendingSentCmd?: string[]
}
// The subset planQueue itself touches — lets tests pass a plain object.
type QueueRt = Pick<LaneRt, 'sentAt' | 'cmdSentAt' | 'prevPromptCount' | 'macroStep'>
interface RtEntry {
	starting: boolean
	startedAt: number
	lanes: Record<number, LaneRt>
	// Set only for a worktree session: the worktree's dir and its base repo, stamped every
	// tick it's alive. Kept so that when its line is later deleted — and the session is gone
	// from the model — the kill loop still knows what to `git worktree remove`, cleaning the
	// worktree up alongside its tmux session.
	worktreeDir?: string
	worktreeBase?: string
}
type Rt = Record<string, RtEntry>

const loadRt = (): Rt => {
	try {
		return JSON.parse(readFileSync(RT_PATH, 'utf8'))
	} catch {
		return {}
	}
}
const saveRt = (rt: Rt) => {
	if (!DRY) writeFileSync(RT_PATH, JSON.stringify(rt, null, 2))
}

interface StateEvent {
	event: string
	mtimeMs: number
}
// Done-files are per lane. Lane 1 keeps the bare `<label>.json`/`<label>.cmd` names
// (back-compat, incl. tmux-resurrect restores that predate HERALD_PANE); lane n>1 uses
// `<label>.<n>.json`/`<label>.<n>.cmd`, matching the `HERALD_PANE` suffix the hooks add.
const paneSuffix = (n: number) => (n > 1 ? `.${n}` : '')
const statePath = (label: string, n: number) => join(STATE, `${label}${paneSuffix(n)}.json`)
function readState(label: string, n: number): StateEvent | null {
	const p = statePath(label, n)
	try {
		const event = JSON.parse(readFileSync(p, 'utf8')).event as string
		return { event, mtimeMs: statSync(p).mtimeMs }
	} catch {
		return null
	}
}
// The `-> ` summary from the claude turn that just finished: follow the transcript path in
// the lane's last hook payload, take the newest assistant message's text, and return its last
// `-> …` line (the launch instruction asks claude to end each turn with one). Null when the
// transcript is unreadable or has no such line — the note pass then writes nothing.
function readAssistantNote(label: string, n: number): string | null {
	let tpath: unknown
	try {
		tpath = JSON.parse(readFileSync(statePath(label, n), 'utf8')).raw?.transcript_path
	} catch {
		return null
	}
	if (typeof tpath !== 'string') return null
	let content: string
	try {
		content = readFileSync(tpath, 'utf8')
	} catch {
		return null
	}
	let text = ''
	for (const line of content.split('\n')) {
		if (line.trim() === '') continue
		try {
			const o = JSON.parse(line)
			if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
				const parts = o.message.content.filter((c: { type?: string }) => c.type === 'text').map((c: { text?: string }) => c.text ?? '')
				if (parts.length) text = parts.join('\n') // keep only the newest assistant message
			}
		} catch {}
	}
	const noteLine = text
		.split('\n')
		.map((l) => l.trim())
		.reverse()
		.find((l) => NOTE_RE.test(l))
	return noteLine ? noteLine.replace(NOTE_RE, '').trim() || null : null
}
const rmState = (label: string, n: number) => {
	try {
		unlinkSync(statePath(label, n))
	} catch {}
}
// A finished `$command` writes its exit status to state/<label>[.n].cmd; the
// controller polls this file's mtime to know the command has actually exited.
const cmdDonePath = (label: string, n: number) => join(STATE, `${label}${paneSuffix(n)}.cmd`)
const readCmdDone = (label: string, n: number): number | null => {
	try {
		return statSync(cmdDonePath(label, n)).mtimeMs
	} catch {
		return null
	}
}
const rmCmdDone = (label: string, n: number) => {
	try {
		unlinkSync(cmdDonePath(label, n))
	} catch {}
}
// Remove every lane's state files for a label (session teardown), including numbered
// panes and the capture logs, so a later reuse of the label doesn't read stale input.
const rmAllDoneFiles = (label: string) => {
	const re = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.\\d+)?\\.(json|cmd|in|incmd)$`)
	for (const f of readdirSync(STATE)) {
		if (re.test(f)) {
			try {
				unlinkSync(join(STATE, f))
			} catch {}
		}
	}
}
const safeMtime = (p: string): number => {
	try {
		return statSync(p).mtimeMs
	} catch {
		return -1
	}
}

// -------------------------------------------------------- capturing pane input

// Manually-typed input mirrored back into the `.herald` file. A live pane's hooks append
// what the user types: the claude UserPromptSubmit hook writes each submitted prompt's raw
// payload (one JSON object per line) to `<label>[.n].in`, and each shell's post-command
// hook writes the command line to `<label>[.n].incmd`. Per lane, the controller drops its
// own sends (they re-fire the same hooks) and stages the rest into the file.
const inPath = (label: string, n: number) => join(STATE, `${label}${paneSuffix(n)}.in`)
const incmdPath = (label: string, n: number) => join(STATE, `${label}${paneSuffix(n)}.incmd`)
// The lanes/kinds with a pending capture log for this label (a `.in`/`.incmd` file each).
function captureFiles(label: string): { n: number; kind: 'in' | 'incmd' }[] {
	const re = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.(\\d+))?\\.(in|incmd)$`)
	const out: { n: number; kind: 'in' | 'incmd' }[] = []
	try {
		for (const f of readdirSync(STATE)) {
			const m = re.exec(f)
			if (m) out.push({ n: m[1] ? parseInt(m[1], 10) : 1, kind: m[2] as 'in' | 'incmd' })
		}
	} catch {}
	return out
}
// Read a capture log without consuming it: the parsed items, the byte length seen (so exactly
// that prefix is truncated once the tick commits, leaving any concurrent append for next
// tick), and the file's mtime (≈ the submit time, used to gate a captured prompt's Stop).
// `.in` lines are the claude hook's JSON payloads (take `.prompt`); `.incmd` lines are raw
// command lines. Null for a missing/empty log.
function readCapture(path: string, kind: 'in' | 'incmd'): { items: string[]; len: number; mtime: number } | null {
	let content: string
	try {
		content = readFileSync(path, 'utf8')
	} catch {
		return null
	}
	if (!content) return null
	const items: string[] = []
	for (const line of content.split('\n')) {
		if (line.trim() === '') continue
		if (kind === 'incmd') items.push(line)
		else
			try {
				const p = JSON.parse(line).prompt
				if (typeof p === 'string' && p !== '') items.push(p)
			} catch {}
	}
	return { items, len: Buffer.byteLength(content, 'utf8'), mtime: safeMtime(path) }
}
// Drop the consumed prefix of a capture log once the tick commits its inserts. Appends only
// grow the file, so anything past `len` (arrived mid-tick) is preserved for next tick.
function truncateCapture(path: string, len: number) {
	try {
		const buf = readFileSync(path)
		if (buf.length <= len) unlinkSync(path)
		else writeFileSync(path, buf.subarray(len))
	} catch {}
}
// Remember a prompt/command herald just dispatched into a lane, so its own hook echo isn't
// mistaken for human input. Only the last few matter (they're matched off within a tick or
// two); older entries are dropped to bound growth.
const SENT_KEEP = 10
const recordSent = (lr: LaneRt, isCmd: boolean, text: string) => {
	const key = isCmd ? 'pendingSentCmd' : 'pendingSent'
	lr[key] = [...(lr[key] ?? []), text].slice(-SENT_KEEP)
}
// Claude Code resolves a sent slash command to its canonical id — a `.scope` suffix on the
// command token (e.g. `/watch-pr-comments` → `/watch-pr-comments.shared`) — so the
// UserPromptSubmit echo doesn't string-match what we sent, and would be mirrored back into the
// file as if a human typed it (notably for a macro's `: /cmd` step). Treat a captured prompt as
// our echo when its command token is the sent token, optionally plus a `.scope` suffix, and any
// args are identical. The `.` guard keeps `/c` from swallowing a distinct `/cp`.
export const slashEcho = (captured: string, sent: string): boolean => {
	if (!captured.startsWith('/') || !sent.startsWith('/')) return false
	const ci = captured.indexOf(' ')
	const si = sent.indexOf(' ')
	const ct = ci < 0 ? captured : captured.slice(0, ci)
	const st = si < 0 ? sent : sent.slice(0, si)
	const cArgs = ci < 0 ? '' : captured.slice(ci + 1)
	const sArgs = si < 0 ? '' : sent.slice(si + 1)
	return cArgs === sArgs && (ct === st || ct.startsWith(`${st}.`))
}

// ------------------------------------------------------------------ tmux glue

const PREFIX = '__'
const T = (label: string) => `${PREFIX}${label}`
const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`

async function listTmux(): Promise<Set<string>> {
	const r = await $({ nothrow: true, quiet: true })`tmux list-sessions -F '#{session_name}'`
	const out = new Set<string>()
	for (const line of r.stdout.split('\n')) {
		const n = line.trim()
		if (n.startsWith(PREFIX)) out.add(n.slice(PREFIX.length))
	}
	return out
}

// Each lane has a claude window (prompts) and a shell window (`$command`s). We tag each
// pane with a pane-scoped user option (@herald = the role string) which — unlike pane
// titles — the running program can't clobber, and which survives focus changes, non-zero
// base-index, and controller restart. Lane 1 uses the bare roles `claude`/`shell` (the
// window names too), lane n>1 uses `claude<n>`/`shell<n>`. -s searches all windows.
type PaneKind = 'claude' | 'shell'
const paneRole = (kind: PaneKind, n: number): string => (n > 1 ? `${kind}${n}` : kind)

// Resolve a lane's pane by role: prefer the @herald tag, else the window still named for
// that role (tag lost on tmux-resurrect, or a pre-tag session). Null if absent.
async function paneFor(label: string, kind: PaneKind, n: number): Promise<string | null> {
	const role = paneRole(kind, n)
	const r = await $({
		nothrow: true,
		quiet: true,
	})`tmux list-panes -s -t ${T(label)} -F ${'#{pane_id}\t#{@herald}\t#{window_name}'}`
	let byName: string | null = null
	for (const line of r.stdout.split('\n')) {
		const [id, tag, win] = line.split('\t')
		if (!id) continue
		if (tag === role) return id
		if (win === role) byName ??= id
	}
	return byName
}

// The lane-1 claude pane, never null: falls back to the first pane / session target so
// select-window and reveals always have something to point at during a partial spawn.
async function claudePane(label: string, n = 1): Promise<string> {
	const found = await paneFor(label, 'claude', n)
	if (found) return found
	const r = await $({ nothrow: true, quiet: true })`tmux list-panes -s -t ${T(label)} -F ${'#{pane_id}'}`
	return r.stdout.split('\n')[0]?.trim() || T(label)
}
const shellPane = (label: string, n = 1) => paneFor(label, 'shell', n)

// Whether the lane's claude pane is mid-turn, read from the live TUI's spinner line:
// while a turn runs Claude Code pins a `<glyph> <Gerund>… (<elapsed> · …)` status above the
// input box (e.g. `✳ Sock-hopping… (42s · ↓ 2.7k tokens)`). We anchor on a line that STARTS
// with a lone spinner glyph whose next token ends in `…(`, which excludes both the idle
// end-of-turn summary (`✻ Baked for 6m 55s` — no ellipsis/paren) and transcript prose that
// merely quotes a spinner (an assistant `⏺ …the pane shows Channelling… (18s)` line starts
// with text, not a lone glyph). The "esc to interrupt" hint is unreliable — it's dropped on
// extended-thinking turns. true = working, false = idle, null = pane unreadable.
async function claudeBusy(label: string, n: number): Promise<boolean | null> {
	const pane = await paneFor(label, 'claude', n)
	if (pane === null) return null
	const r = await $({ nothrow: true, quiet: true })`tmux capture-pane -p -t ${pane}`
	if (r.exitCode !== 0) return null
	return /^\s*[^\w\s]\s+\S*…\s*\(/m.test(r.stdout)
}

// The pane *only* if it still carries its @herald tag. A tmux-resurrect restore brings a
// session back with fresh panes that ran `exec fish` under the session env alone: they
// lost the per-window HERALD_SHELL=1/HERALD_PANE that make the completion hook fire, and
// lost the @herald tag. Such a pane is found by paneFor()'s name fallback but returns null
// here, which is what flags it for repair.
async function taggedPane(label: string, kind: PaneKind, n: number): Promise<string | null> {
	const role = paneRole(kind, n)
	const r = await $({
		nothrow: true,
		quiet: true,
	})`tmux list-panes -s -t ${T(label)} -F ${'#{pane_id}\t#{@herald}'}`
	for (const line of r.stdout.split('\n')) {
		const [id, tag] = line.split('\t')
		if (id && tag === role) return id
	}
	return null
}

async function typeInto(pane: string, text: string, vimInsert = false) {
	const tm = $({ nothrow: true, quiet: true })
	// Claude runs with vim keybindings: drop to normal mode then re-enter insert so
	// the text lands as input, not as normal-mode commands. The gap after Escape
	// keeps the terminal from folding Esc+i into a single Alt-i meta key.
	if (vimInsert) {
		await tm`tmux send-keys -t ${pane} Escape`
		await sleep(80)
		await tm`tmux send-keys -t ${pane} i`
		await sleep(80)
	}
	if (text.includes('\n')) {
		// A multiline prompt (a `:` line plus its deeper-indented body) can't go through
		// send-keys — the first newline would submit it. Bracketed paste (`-p`) delivers the
		// whole block as one paste, so Claude inserts the newlines as input; then Enter sends.
		await tm`tmux set-buffer -b herald -- ${text}`
		await tm`tmux paste-buffer -p -d -b herald -t ${pane}`
	} else {
		await tm`tmux send-keys -t ${pane} -l -- ${text}`
	}
	await sleep(120)
	await tm`tmux send-keys -t ${pane} Enter`
}

// `vimInsert` prep only makes sense for a running claude (prompts, /clear); the
// launch line below is typed into the shell before claude starts.
async function sendLine(label: string, text: string, vimInsert = false, n = 1) {
	log(`${DRY ? '[dry] ' : ''}send ${T(label)}${n > 1 ? `:${n}` : ''}: ${JSON.stringify(text)}`)
	if (DRY) return
	await typeInto(await claudePane(label, n), text, vimInsert)
}

// Run a `$command` line in lane `n`'s shell window. The per-shell hook in that window
// writes the command's exit status to its done-file *after* it exits, so the controller
// can tell when the command has actually finished (not just sent).
async function sendCmd(label: string, text: string, n = 1) {
	log(`${DRY ? '[dry] ' : ''}cmd ${T(label)}${n > 1 ? `:${n}` : ''}: ${JSON.stringify(text)}`)
	if (DRY) return
	const pane = await shellPane(label, n)
	if (!pane) {
		log(`no shell pane ${n} for ${T(label)}, skipping command`)
		return
	}
	// The command's exit status is written to its done-file by the per-shell hook
	// in the shell window (see herald-{fish,bash,zsh}.*), so we type it verbatim.
	await typeInto(pane, text)
}

// Create lane `n`'s pane of `kind` as a new window, wired for completion reporting:
// HERALD_LABEL/HERALD_STATE (so a pane recreated on an env-less session still reports),
// HERALD_SHELL to mark a shell as the command-runner, and HERALD_PANE=n (n>1) so the hook
// suffixes its done-file. A claude pane also launches `claude` (the caller waits out the
// boot grace before dispatching to it). Returns the new pane id.
async function ensurePaneWindow(label: string, dir: string, kind: PaneKind, n: number): Promise<string> {
	const tm = $({ nothrow: true, quiet: true })
	const role = paneRole(kind, n)
	const env = ['-e', `HERALD_LABEL=${label}`, '-e', `HERALD_STATE=${STATE}`]
	if (kind === 'shell') env.push('-e', 'HERALD_SHELL=1')
	if (n > 1) env.push('-e', `HERALD_PANE=${n}`)
	const created = (await tm`tmux new-window -P -F ${'#{pane_id}'} -t ${T(label)} -n ${role} -c ${dir} ${env}`).stdout.trim()
	await tm`tmux set-option -p -t ${created} @herald ${role}`
	if (kind === 'claude') {
		await sleep(300)
		await typeInto(created, LAUNCH_CMD)
	}
	return created
}
// Lane 1's shell window (the original free shell); kept as a thin alias for the callers
// (doSpawn / repairShell) that only ever touch lane 1.
const makeShellWindow = (label: string, dir: string) => ensurePaneWindow(label, dir, 'shell', 1)

// The @herald roles present on a session's panes (e.g. {claude, shell}). A complete
// session has both; anything missing means a tmux step during spawn silently failed.
async function taggedRoles(label: string): Promise<Set<string>> {
	const r = await $({ nothrow: true, quiet: true })`tmux list-panes -s -t ${T(label)} -F ${'#{@herald}'}`
	return new Set(r.stdout.split('\n').map((x) => x.trim()).filter(Boolean))
}

async function doSpawn(label: string, dir: string) {
	log(`spawning ${T(label)} in ${dir}`)
	if (DRY) return
	const tm = $({ nothrow: true, quiet: true })
	// HERALD_LABEL/HERALD_STATE seed the session so its initial (claude) window inherits them
	// for the Stop/Notification + prompt-capture hook; HERALD_SHELL marks only the shell window,
	// where the per-shell hook writes command done-files (see herald-{fish,bash,zsh}.*).
	await tm`tmux new-session -d -s ${T(label)} -n claude -c ${dir} -e ${`HERALD_LABEL=${label}`} -e ${`HERALD_STATE=${STATE}`}`
	// Tag the claude pane, then open a second window as a free shell for the user.
	await tm`tmux set-option -p -t ${T(label)} @herald claude`
	await makeShellWindow(label, dir)
	await sleep(300)
	await sendLine(label, LAUNCH_CMD)
	// The claude and shell panes have now inherited the herald identity at launch (the shell
	// window sets its own via new-window -e), so strip it back out of the *session* env. A
	// window the user opens later — e.g. an ad-hoc `claude` for a handoff — must NOT inherit
	// HERALD_LABEL, or its hook would report to this lane: clobbering the real claude's status
	// file and mirroring its prompts into the control file as if they were this lane's.
	await tm`tmux set-environment -t ${T(label)} -u HERALD_LABEL`
	await tm`tmux set-environment -t ${T(label)} -u HERALD_STATE`
	// Leave the claude window focused so an attach shows it first.
	await tm`tmux select-window -t ${await claudePane(label)}`
	// The tmux steps above run with nothrow; a partial spawn leaves a half-formed
	// session that blocks command dispatch. Warn loudly (the readiness gate repairs it).
	const roles = await taggedRoles(label)
	if (!roles.has('claude') || !roles.has('shell')) log(`WARN incomplete spawn of ${T(label)} (tagged: ${[...roles].join(',') || 'none'})`)
}

// Create a detached-HEAD git worktree of `base` at `dir` (its parent dirs made first), then
// run the base repo's worktree setup — copy files/dirs in from `base` (`worktree/copy`, e.g.
// a gitignored `.env`), then run its commands in the worktree (`worktree/cmd`, e.g. install) —
// and spawn the session in it. Runs once, the first tick a worktree session has work.
async function addWorktreeAndSpawn(label: string, base: string, dir: string, cfg: { cmd?: string[]; copy?: string[] } = {}) {
	log(`worktree add ${dir} (from ${base})`)
	if (DRY) return
	const tm = $({ nothrow: true, quiet: true })
	await tm`mkdir -p ${dirname(dir)}`
	const r = await tm`git -C ${base} worktree add --detach ${dir}`
	if (r.exitCode !== 0) {
		log(`WARN worktree add failed for ${T(label)}: ${r.stderr.trim()}`)
		return
	}
	// Copy each path (relative to the base repo) into the new worktree — files/dirs git
	// doesn't track (`.env`, build caches) that setup needs. Missing sources warn and skip.
	for (const rel of cfg.copy ?? []) {
		const src = join(base, rel)
		if (!existsSync(src)) {
			log(`WARN worktree ${T(label)}: copy source missing, skipping: ${rel}`)
			continue
		}
		log(`worktree ${T(label)}: copy ${rel}`)
		try {
			cpSync(src, join(dir, rel), { recursive: true })
		} catch (e) {
			log(`WARN worktree ${T(label)}: copy failed for ${rel}: ${(e as Error).message}`)
		}
	}
	// Run each setup command in the worktree. Prefer the user's login shell (`$SHELL -lc`) so
	// PATH and env managers (asdf/nvm/direnv) apply the way they do in a real pane; fall back
	// to `sh -c` if `$SHELL` is unset.
	const sh = $({ cwd: dir, nothrow: true, quiet: true })
	for (const cmd of cfg.cmd ?? []) {
		log(`worktree ${T(label)}: run ${JSON.stringify(cmd)}`)
		const rr = process.env.SHELL ? await sh`${process.env.SHELL} -lc ${cmd}` : await sh`sh -c ${cmd}`
		if (rr.exitCode !== 0) log(`WARN worktree ${T(label)}: cmd failed (exit ${rr.exitCode}): ${cmd}`)
	}
	await doSpawn(label, dir)
}

// A labeled base that isn't a git repo can't be worktree'd, so instead point the same
// `<base>-worktrees/<name>` path straight at the base with a symlink: the session runs in a
// dir that *is* the base, so its commands modify the original files (no isolation — worktree
// setup copy/cmd is skipped, there being no separate tree to seed). Torn down like a real
// worktree, except removeWorktree just unlinks the symlink.
async function linkDirAndSpawn(label: string, base: string, dir: string) {
	log(`symlink ${dir} -> ${base}`)
	if (DRY) return
	await $({ nothrow: true, quiet: true })`mkdir -p ${dirname(dir)}`
	try {
		symlinkSync(base, dir)
	} catch (e) {
		log(`WARN symlink failed for ${T(label)}: ${(e as Error).message}`)
		return
	}
	await doSpawn(label, dir)
}

// Delete the git worktree behind a torn-down session (its line was deleted from the control
// file), so worktrees are cleaned up alongside their tmux session rather than piling up on
// disk. Like the tmux kill it's unconditional: `--force` deletes even a dirty worktree
// (uncommitted or untracked changes are discarded), matching "removing the line tears it all
// down". Commit or move anything you want to keep before deleting the line.
async function removeWorktree(label: string, base: string, dir: string) {
	const link = lstatSync(dir, { throwIfNoEntry: false })
	if (!link) return
	if (DRY) return
	// A non-git base is symlinked, not worktree'd (see linkDirAndSpawn); just drop the link —
	// git worktree remove would fail, and the base's files must be left untouched.
	if (link.isSymbolicLink()) {
		log(`symlink remove ${dir}`)
		try {
			unlinkSync(dir)
		} catch (e) {
			log(`WARN symlink remove failed for ${T(label)} (left on disk): ${(e as Error).message}`)
			return
		}
	} else {
		log(`worktree remove ${dir} (from ${base})`)
		const r = await $({ nothrow: true, quiet: true })`git -C ${base} worktree remove --force ${dir}`
		if (r.exitCode !== 0) {
			log(`WARN worktree remove failed for ${T(label)} (left on disk): ${r.stderr.trim()}`)
			return
		}
	}
	// If that was the repo's last worktree, remove the now-empty `<repo>-worktrees` folder so
	// it doesn't linger. Best-effort: skip (don't throw) if it's gone or not actually empty.
	const parent = dirname(dir)
	try {
		if (existsSync(parent) && readdirSync(parent).length === 0) {
			rmdirSync(parent)
			log(`removed empty worktrees dir ${parent}`)
		}
	} catch {}
}

// Recreate lane `n`'s shell window so command completion is reported again. Two cases:
// a partial/absent pane, or a tmux-resurrect restore that brought the shell back stripped
// of its HERALD_SHELL/HERALD_PANE env and @herald tag (see taggedPane). In the restore
// case a stale, untagged shell pane exists — kill its window first so we don't leave a
// duplicate — then create a fresh, tagged one. Leaves the lane-1 claude window focused.
async function repairShell(label: string, dir: string, n = 1) {
	if (DRY) return
	const tm = $({ nothrow: true, quiet: true })
	const stale = await shellPane(label, n)
	log(`repairing ${T(label)} shell${n > 1 ? n : ''}: ${stale ? 'recreating restored window (restoring HERALD_SHELL)' : 'recreating missing window'}`)
	if (stale) await tm`tmux kill-window -t ${stale}`
	await ensurePaneWindow(label, dir, 'shell', n)
	await tm`tmux select-window -t ${await claudePane(label)}`
}

async function doKill(label: string, switchTo: string | null) {
	log(`killing ${T(label)}`)
	if (DRY) return
	const tm = $({ nothrow: true, quiet: true })
	// If a client is currently viewing this session, move it to a surviving
	// controller session first — otherwise killing drops the client onto an
	// unrelated session or detaches it entirely.
	if (switchTo) {
		const r = await tm`tmux list-clients -F ${'#{client_name}\t#{client_session}'}`
		for (const line of r.stdout.split('\n')) {
			const [client, session] = line.split('\t')
			if (client && session === T(label)) await tm`tmux switch-client -c ${client} -t ${T(switchTo)}`
		}
	}
	await tm`tmux kill-session -t ${T(label)}`
}

// Bring this session on screen by switching the first client that's currently
// viewing a controller-managed (`__*`) session — i.e. the terminal you use to watch
// herald sessions (e.g. WezTerm). Clients parked on your own non-`__` sessions are
// left alone. Run outside tmux there is no "current" client, so we target it by name.
async function showSession(label: string, window?: Window) {
	log(`showing ${T(label)}${window ? ` (${paneRole(window.kind, window.n)})` : ''}`)
	if (DRY) return
	const tm = $({ nothrow: true, quiet: true })
	// Bring the configured terminal (the one watching these sessions) to the foreground, so a
	// `show`/`!` actually surfaces it even when another app is focused. macOS + opt-in only.
	if (process.platform === 'darwin' && TERM_APP) await tm`osascript -e ${`tell application "${TERM_APP}" to activate`}`
	// Reveal the window the caller asked for (e.g. the shell for a `$command` show, or a
	// numbered lane's pane), so switching the client lands on it rather than the session's
	// last-active window.
	if (window) {
		const pane = await paneFor(label, window.kind, window.n)
		if (pane) await tm`tmux select-window -t ${pane}`
	}
	const r = await tm`tmux list-clients -F ${'#{client_name}\t#{client_session}'}`
	for (const line of r.stdout.split('\n')) {
		const [client, session] = line.split('\t')
		if (client && session?.startsWith(PREFIX)) {
			await tm`tmux switch-client -c ${client} -t ${T(label)}`
			return
		}
	}
}

const atomicWrite = (path: string, content: string) => {
	if (DRY) {
		log(`[dry] ${basename(path)} would be rewritten`)
		return
	}
	const tmp = `${path}.tmp`
	writeFileSync(tmp, content)
	renameSync(tmp, path)
}

// Every `*.herald` file in the control dir, sorted for a stable merge order. In
// single-file mode (HERALD_FILE) it's just that one file, if it exists.
function controlFiles(): string[] {
	if (SINGLE_FILE) return existsSync(SINGLE_FILE) ? [SINGLE_FILE] : []
	let names: string[]
	try {
		names = readdirSync(CONTROL_DIR)
	} catch {
		return []
	}
	return names
		.filter((n) => n.endsWith(CONTROL_EXT))
		.sort()
		.map((n) => join(CONTROL_DIR, n))
		.filter((p) => {
			try {
				return statSync(p).isFile()
			} catch {
				return false
			}
		})
}

// -------------------------------------------------------------- reconcile tick

// Prompts, `$command` lines, and `show` lines share ONE queue that drains
// bottom-to-top, one item at a time in file order: an item runs only once the item
// below it (its predecessor) has finished. A prompt runs in the claude pane (done
// on the hook's Stop event); a command runs in the shell window (done when its
// done-file is written); a `show` switches the tmux client and completes instantly,
// consuming its own line. Exactly one item ever carries a marker — the "frontier":
// items above it (smaller lineIdx) are pending, items below it have already run.

export type DispatchType = 'prompt' | 'cmd' | 'clear' | 'show'
// A concrete pane to reveal: kind (claude/shell) + 1-based lane. `!` on a `:2`/`$2`
// line reveals `claude2`/`shell2`; a header `!`/`show` reveals the frontier item's pane.
export interface Window {
	kind: PaneKind
	n: number
}
const windowOf = (p: Prompt): Window => ({ kind: p.isCmd ? 'shell' : 'claude', n: p.pane })
export interface Dispatch {
	type: DispatchType
	text?: string
	// For a `show`: the window the last task before it used, so the reveal lands on
	// that window (the shell for a `$command`, the claude pane for a prompt).
	window?: Window
}
export interface PlanIO {
	now: number
	state: { event: string; mtimeMs: number } | null
	cmdDoneMtime: number | null
	// Live busy state of the lane's claude pane (its active-turn "esc to interrupt" hint):
	// true = working, false = idle at the prompt, undefined = unknown/unread (tests, or a
	// `$`-only lane). Authoritative over stale hook events — a session that resumes on its
	// own (background task / loop / task-notification) fires no hook, so without this the
	// prior turn's Stop latches it to [DONE] while it's actually still running.
	paneBusy?: boolean
}

// Nearest pending item above `idx` in drain order (the next to run, drain being
// bottom-to-top). Ordering is by `order`, not `lineIdx`, so a merged label's rows drain
// as one cross-file queue.
const nearestAbove = (s: Session, idx: number): Prompt | null => {
	const cands = s.prompts.filter((p) => p.order < idx && p.desiredKind === null)
	return cands.length ? cands.reduce((a, b) => (b.order > a.order ? b : a)) : null
}

// The bottom-to-top frontier: the top-most already-run item, or the queue bottom on
// a fresh queue. Shared by planQueue's fresh-dispatch branch and the spawn gate.
const frontierIdx = (s: Session): number => {
	const done = s.prompts.filter((p) => p.desiredKind === 'DONE')
	return done.length ? Math.min(...done.map((p) => p.order)) : Number.POSITIVE_INFINITY
}

// Whether a session has a pending item the next tick would dispatch. A bare header
// (no prompts/commands), a fully drained one, or one blocked on a `#` barrier has nothing
// to input, so we don't spawn a tmux session for it — we only spawn once there's work.
export const hasPendingInput = (s: Session): boolean => {
	if (s.prompts.some((p) => p.desiredKind === 'EXECUTING' || p.desiredKind === 'ATTENTION')) return true
	const next = nearestAbove(s, frontierIdx(s))
	return next !== null && !next.isBarrier
}

// The live sessions to tear down this tick: every `__` tmux session no longer backed by a
// model label (and not reserved). Each carries the worktree to reap alongside it — read
// from rt, the only surviving record of a removed worktree's dir/base — or null for a plain
// repo session. Pure so the reconcile decision can be unit-tested apart from the tmux/git I/O.
export interface ReapTarget {
	label: string
	worktree: { base: string; dir: string } | null
}
export function reapTargets(live: Iterable<string>, modelLabels: Set<string>, reserved: Set<string>, rt: Record<string, { worktreeDir?: string; worktreeBase?: string }>): ReapTarget[] {
	const out: ReapTarget[] = []
	for (const label of live) {
		if (modelLabels.has(label) || reserved.has(label)) continue
		const e = rt[label]
		out.push({ label, worktree: e?.worktreeDir && e?.worktreeBase ? { base: e.worktreeBase, dir: e.worktreeDir } : null })
	}
	return out
}

// The window used by the last real task before a `show` (the nearest prompt/command
// below it in file order, since the queue drains bottom-to-top). Defaults to the
// claude pane when nothing ran before it.
const lastTaskWindow = (s: Session, showOrder: number): Window => {
	const below = s.prompts
		.filter((p) => p.order > showOrder && !p.isShow && !p.isBarrier)
		.sort((a, b) => a.order - b.order)[0]
	return below ? windowOf(below) : { kind: 'claude', n: 1 }
}

// The window of the session's frontier item — whatever is currently [EXECUTING] (or
// [NEEDS ATTENTION]), else the most recently [DONE] one (the top-most, since the queue
// drains bottom-to-top). Undefined when nothing has run yet. Points a header `!` at
// the right window.
export const frontierWindow = (s: Session): Window | undefined => {
	const active = s.prompts.find((p) => p.desiredKind === 'EXECUTING' || p.desiredKind === 'ATTENTION')
	const done = s.prompts.filter((p) => p.desiredKind === 'DONE').sort((a, b) => a.order - b.order)[0]
	const item = active ?? done
	return item ? windowOf(item) : undefined
}

// The distinct lanes (pane numbers) present in a session, ascending. Each is planned
// independently and runs concurrently with the others.
export const lanesOf = (s: Session): number[] => [...new Set(s.prompts.map((p) => p.pane))].sort((a, b) => a - b)
// A lane's own view: only its items. planQueue on this mutates the shared Prompt objects
// but confines drain/frontier/keepOnly to the lane, so each lane keeps its own marker.
const laneView = (s: Session, n: number): Session => ({ ...s, prompts: s.prompts.filter((p) => p.pane === n) })
// A macro item needs a claude pane if any step is a prompt, a shell pane if any is a `$`.
const macroHasClaude = (p: Prompt) => !!p.isMacro && p.steps!.some((st) => !st.isCmd)
const macroHasShell = (p: Prompt) => !!p.isMacro && p.steps!.some((st) => st.isCmd)
// Whether an item feeds the claude pane: a plain prompt, or a macro with a prompt step.
const isClaudeItem = (p: Prompt) => (p.isMacro ? macroHasClaude(p) : !p.isCmd && !p.isBarrier && !p.isShow)
const laneHasClaude = (s: Session, n: number) => s.prompts.some((p) => p.pane === n && isClaudeItem(p))
const laneHasShell = (s: Session, n: number) => s.prompts.some((p) => p.pane === n && (p.isMacro ? macroHasShell(p) : p.isCmd))
const lanePromptCount = (s: Session, n: number) => s.prompts.filter((p) => p.pane === n && isClaudeItem(p)).length

// Only the frontier item keeps a marker: strip every other [EXECUTING]/[DONE].
const keepOnly = (s: Session, keep: Prompt | null) => {
	for (const p of s.prompts) {
		if (p === keep) continue
		if (p.desiredKind === 'EXECUTING' || p.desiredKind === 'DONE') p.desiredKind = null
	}
}

// Decide the next transition for one (spawned, ready) session. Mutates the items'
// desiredKind and the runtime timers; returns the lines to send this tick. Pure
// w.r.t. I/O so it can be unit-tested by feeding synthetic events.
export function planQueue(s: Session, rt: QueueRt, io: PlanIO): Dispatch[] {
	const out: Dispatch[] = []
	const promptCount = s.prompts.filter((p) => isClaudeItem(p)).length
	const hasBarrier = s.prompts.some((p) => p.isBarrier)

	// Send one macro step: a `$` step to the shell, else a prompt to claude (own timer each).
	const emitStep = (step: MacroStep) => {
		if (step.isCmd) {
			rt.cmdSentAt = io.now
			out.push({ type: 'cmd', text: step.text })
		} else {
			rt.sentAt = io.now
			out.push({ type: 'prompt', text: step.text })
		}
	}
	const dispatch = (item: Prompt) => {
		item.desiredKind = 'EXECUTING'
		if (item.isMacro) {
			rt.macroStep = 0
			if (item.steps!.length === 0) item.desiredKind = 'DONE' // nothing runnable (all comments)
			else emitStep(item.steps![0])
		} else if (item.isCmd) {
			rt.cmdSentAt = io.now
			out.push({ type: 'cmd', text: item.text })
		} else {
			rt.sentAt = io.now
			out.push({ type: 'prompt', text: item.text })
		}
		keepOnly(s, item)
	}
	// Walk up the queue from `cursor` (bottom-to-top): fire and consume any `show`
	// items instantly (they switch the tmux client, then their line is deleted), until we
	// reach a real item to dispatch, a `#` barrier (halt), or the top. `hold` (a
	// just-finished item) keeps the frontier marker if nothing dispatches.
	const drainUp = (cursor: number, hold: Prompt | null) => {
		for (;;) {
			const next = nearestAbove(s, cursor)
			if (next?.isShow) {
				out.push({ type: 'show', window: lastTaskWindow(s, next.order) })
				next.fired = true
				cursor = next.order
				continue
			}
			if (next && !next.isBarrier) dispatch(next)
			else if (hold) keepOnly(s, hold) // drained or barrier ahead: hold the frontier
			return
		}
	}

	const active = s.prompts.find((p) => p.desiredKind === 'EXECUTING' || p.desiredKind === 'ATTENTION')
	// The top-most already-run item (the frontier), if any — resurrected below when the
	// pane is busy again but nothing is marked active.
	const doneFrontier = s.prompts.filter((p) => p.desiredKind === 'DONE').sort((a, b) => a.order - b.order)[0]
	if (active) {
		if (active.isMacro) {
			// A macro runs its steps in sequence, holding [EXECUTING] across them; only the
			// last step's completion advances the item to [DONE]. `rt.macroStep` (persisted
			// per lane) is the cursor, so this resumes correctly across ticks and restarts.
			const step = active.steps![rt.macroStep ?? 0]
			const advance = () => {
				const next = (rt.macroStep ?? 0) + 1
				if (next < active.steps!.length) {
					rt.macroStep = next
					active.desiredKind = 'EXECUTING'
					emitStep(active.steps![next])
				} else {
					rt.macroStep = 0
					active.desiredKind = 'DONE'
					drainUp(active.order, active)
				}
			}
			if (!step) advance()
			else if (step.isCmd) {
				if (io.cmdDoneMtime !== null && io.cmdDoneMtime > (rt.cmdSentAt ?? 0)) advance()
			} else if (step.text.trim() === '/clear') advance()
			else if (io.paneBusy === true) active.desiredKind = 'EXECUTING'
			else if (io.state && io.state.event === 'Stop' && io.state.mtimeMs > rt.sentAt) advance()
			else if (io.state && io.state.event === 'Notification' && io.state.mtimeMs > rt.sentAt) active.desiredKind = 'ATTENTION'
			else if (io.state && io.state.event === 'UserPromptSubmit' && io.state.mtimeMs > rt.sentAt) active.desiredKind = 'EXECUTING'
		} else if (active.isCmd) {
			if (io.cmdDoneMtime !== null && io.cmdDoneMtime > (rt.cmdSentAt ?? 0)) {
				active.desiredKind = 'DONE'
				drainUp(active.order, active)
			}
		} else if (active.text.trim() === '/clear') {
			// `/clear` clears the conversation without invoking the model, so it never
			// fires a Stop hook — an explicit `: /clear` queue item would hang forever at
			// [EXECUTING] waiting for one. It's complete the moment it's been sent (a tick
			// ago, since dispatch happens below), so mark it done and keep draining.
			active.desiredKind = 'DONE'
			drainUp(active.order, active)
		} else if (io.paneBusy === true) {
			// The pane is actively working — authoritative over stale hook events. Hold at
			// [EXECUTING]: a resumed turn's earlier Stop must not latch us to [DONE], and a
			// stale Notification must not flip us to [NEEDS ATTENTION] while Claude runs.
			active.desiredKind = 'EXECUTING'
		} else if (io.state && io.state.event === 'Stop' && io.state.mtimeMs > rt.sentAt) {
			active.desiredKind = 'DONE'
			drainUp(active.order, active)
		} else if (io.state && io.state.event === 'Notification' && io.state.mtimeMs > rt.sentAt) {
			// Claude is blocked waiting for input mid-task: flag this prompt.
			active.desiredKind = 'ATTENTION'
		} else if (io.state && io.state.event === 'UserPromptSubmit' && io.state.mtimeMs > rt.sentAt) {
			// A prompt was submitted into the pane — the user answered a blocking
			// question — so Claude is working again: clear [NEEDS ATTENTION] back to
			// [EXECUTING]. (A no-op while already executing.)
			active.desiredKind = 'EXECUTING'
		}
	} else if (io.paneBusy === true && doneFrontier) {
		// Nothing is marked active, yet the pane is working again: the frontier item went
		// [DONE] on its Stop, then Claude resumed on its own (a background task / loop /
		// task-notification — none fire a hook). Re-reflect it as running, and dispatch
		// nothing into a busy pane. It settles back to [DONE] once the pane goes idle.
		doneFrontier.desiredKind = 'EXECUTING'
		keepOnly(s, doneFrontier)
	} else if (io.paneBusy === true) {
		// Busy pane but nothing has run yet (e.g. a manual turn): don't feed it a prompt.
	} else if (rt.prevPromptCount >= 1 && promptCount === 0 && !hasBarrier) {
		// Every prompt was deleted: reset the claude conversation.
		out.push({ type: 'clear' })
	} else {
		// Nothing running: dispatch the next pending item above the frontier (the
		// top-most already-run item), or the bottom-most item on a fresh queue.
		drainUp(frontierIdx(s), null)
	}

	// A `#` barrier holds the whole queue, including a pending /clear: keep the prompt
	// count frozen so the clear still fires once the barrier is removed.
	if (!(hasBarrier && promptCount === 0)) rt.prevPromptCount = promptCount
	return out
}

interface Control {
	path: string
	content: string
	lines: string[]
	sessions: Session[]
	mtime: number
}

async function tick(rt: Rt) {
	const live = await listTmux()
	const aliases = loadAliases()
	const macros = loadMacros()
	// Read + parse every `.herald` file. Each file's sessions carry line indices into
	// that file's own `lines`, so markers are written back to the file they came from.
	const files = controlFiles()
	// No control files at all means "not configured yet", not "kill everything" — do
	// nothing rather than tearing down every live session over a missing/renamed file.
	// (An empty `.herald` file is the explicit way to drain all sessions.)
	if (files.length === 0) return
	const controls: Control[] = files.map((path) => {
		const mtime = safeMtime(path)
		// Macros expand IN MEMORY inside parse (the `@name` line stays in the file); only the
		// single overall marker is ever written back.
		const content = readFileSync(path, 'utf8')
		const { lines, sessions } = parse(content, aliases, macros)
		return { path, content, lines, sessions, mtime }
	})
	// Merge into one global session list; the first file (alphabetical) to claim a
	// tmux label wins, later duplicates are skipped so only one driver owns each session.
	const { sessions, labels: modelLabels } = mergeSessions(controls.map((c) => c.sessions))
	const actions: (() => Promise<void>)[] = []

	// ---- capture pass: mirror manually-typed prompts/commands back into the files ----
	// Read each live session's per-lane capture logs, drop herald's own sends, and stage the
	// rest as the newest rows in the owning file. The inserts merge into the per-file rewrite
	// below; the affected lanes skip dispatch this tick (their new [EXECUTING]/[DONE] row lands
	// on the next parse). `commit` — advancing the send pools and consuming the logs — runs only
	// once the tick has actually written (never on a mid-tick defer), so nothing is lost.
	const captureOps = new Map<string, Op[]>()
	const capturedLanes = new Set<string>()
	const commit: (() => void)[] = []
	// The control file that owns a row: the one whose parsed sessions hold the frontier prompt
	// (markers are written back to the file a row came from), or — with nothing yet run — the
	// one holding the session's primary part.
	const ownerOf = (frontier: Prompt | null, base: Session): Control | null => {
		if (frontier) {
			for (const c of controls) for (const cs of c.sessions) if (cs.prompts.includes(frontier)) return c
			return null
		}
		for (const c of controls) if (c.sessions.includes(base)) return c
		return null
	}
	// Split a lane's raw captured lines into the ones herald sent (matched-and-removed from the
	// send pool, once each) and the ones a human typed.
	const splitEcho = (raw: string[], pool: string[]): { manual: string[]; matched: string[] } => {
		const copy = [...pool]
		const manual: string[] = []
		const matched: string[] = []
		for (const t of raw) {
			// Exact first, then a slash-command whose canonical `.scope` echo we sent short.
			let i = copy.indexOf(t)
			if (i < 0) i = copy.findIndex((q) => slashEcho(t, q))
			if (i >= 0) (matched.push(copy[i]), copy.splice(i, 1)) // record the sent text, so the pool drops it
			else manual.push(t)
		}
		return { manual, matched }
	}
	if (!DRY)
		for (const s of sessions) {
			if (RESERVED.has(s.label) || !live.has(s.label)) continue
			const label = s.label
			const capFiles = captureFiles(label)
			if (!capFiles.length) continue
			rt[label] ??= { starting: true, startedAt: 0, lanes: {} }
			rt[label].lanes ??= {}
			// Group each lane's prompt (`.in`) and command (`.incmd`) logs together.
			const byLane = new Map<number, { prompts?: ReturnType<typeof readCapture>; cmds?: ReturnType<typeof readCapture> }>()
			for (const { n, kind } of capFiles) {
				const cap = readCapture(kind === 'in' ? inPath(label, n) : incmdPath(label, n), kind)
				if (!cap) continue
				const slot = byLane.get(n) ?? {}
				if (kind === 'in') slot.prompts = cap
				else slot.cmds = cap
				byLane.set(n, slot)
			}
			for (const [n, slot] of byLane) {
				const lr = (rt[label].lanes[n] ??= { sentAt: 0, cmdSentAt: 0, prevPromptCount: 0, starting: false, startedAt: 0 })
				const p = splitEcho(slot.prompts?.items ?? [], lr.pendingSent ?? [])
				const c = splitEcho(slot.cmds?.items ?? [], lr.pendingSentCmd ?? [])
				const items: CaptureItem[] = [...p.manual.map((t) => ({ text: t, isCmd: false })), ...c.manual.map((t) => ({ text: t, isCmd: true }))]
				let liveSentAt: number | null = null
				if (items.length) {
					const plan = planCapture(s, n, items)
					const owner = plan && ownerOf(plan.clear, s.parts?.[0] ?? s)
					if (!plan || !owner) continue // can't place yet — leave logs and pools for next tick
					if (plan.clear) plan.clear.desiredKind = null
					const list = captureOps.get(owner.path) ?? []
					list.push({ pos: plan.at - 1, type: 'insert', text: plan.lines.join('\n') })
					captureOps.set(owner.path, list)
					capturedLanes.add(`${label}:${n}`)
					if (plan.executing) liveSentAt = slot.prompts?.mtime ?? Date.now()
				}
				commit.push(() => {
					const drop = (key: 'pendingSent' | 'pendingSentCmd', matched: string[]) => {
						const pool = [...(lr[key] ?? [])]
						for (const t of matched) {
							const i = pool.indexOf(t)
							if (i >= 0) pool.splice(i, 1)
						}
						lr[key] = pool
					}
					drop('pendingSent', p.matched)
					drop('pendingSentCmd', c.matched)
					if (liveSentAt !== null) lr.sentAt = liveSentAt
					if (slot.prompts) truncateCapture(inPath(label, n), slot.prompts.len)
					if (slot.cmds) truncateCapture(incmdPath(label, n), slot.cmds.len)
				})
			}
		}

	for (const s of sessions) {
		const label = s.label
		if (RESERVED.has(label)) continue
		const dir = s.dir
		if (!existsSync(dir)) {
			// A worktree session's dir doesn't exist until we create it — and only once it has
			// work (like any spawn). A git base is worktree'd; a non-git base is symlinked so the
			// session works directly on its files (see linkDirAndSpawn).
			if (s.worktreeBase) {
				if (!hasPendingInput(s) && !s.showNow) continue
				const base = s.worktreeBase
				if (!existsSync(base)) {
					// Nothing to worktree or link to. Log once, then leave the marker (re-stamping the
					// same text, once parsed back into desiredSession, is a no-op).
					const marker = `[NO DIR ${base}]`
					if (s.desiredSession !== marker) log(`worktree ${T(label)}: base ${base} does not exist, marking`)
					s.desiredSession = marker
					continue
				}
				s.desiredSession = null // clear any stale marker before creating
				rt[label] = { starting: true, startedAt: Date.now(), lanes: {}, worktreeDir: dir, worktreeBase: base }
				if (existsSync(join(base, '.git'))) {
					const cfg = { cmd: s.worktreeCmd, copy: s.worktreeCopy }
					actions.push(() => addWorktreeAndSpawn(label, base, dir, cfg))
				} else actions.push(() => linkDirAndSpawn(label, base, dir))
				continue
			}
			s.desiredSession = `[NO DIR ${dir}]`
			continue
		}
		if (!live.has(label)) {
			// Only spawn once there's something to feed the session; a bare header
			// (or a fully drained one) gets no tmux session until work appears. A
			// pending `show`, or a `!` "show now" header, also counts — you can't
			// switch to a session that isn't there yet — so it spawns first.
			if (!hasPendingInput(s) && !s.showNow) continue
			rt[label] = { starting: true, startedAt: Date.now(), lanes: {} }
			actions.push(() => doSpawn(label, dir))
			continue
		}
		// A `!` "show now" header switches the client immediately (even mid-boot — the
		// tmux session exists), independent of the queue; consumed by stripping the `!`.
		if (s.showNow) {
			actions.push(() => showSession(label, frontierWindow(s)))
			s.showNowFired = true
		}
		// A `!` appended to an item's marker or its own line reveals that item's pane —
		// the shell for a `$command`, the claude pane otherwise, in the item's lane.
		for (const p of s.prompts) {
			if (!p.showNow || p.showNowFired) continue
			const window = windowOf(p)
			actions.push(() => showSession(label, window))
			p.showNowFired = true
		}
		// Every session we see live for the first time is un-ready until it clears the
		// grace below. A fresh spawn set this above (with a boot deadline); a reconnect
		// or pre-existing session gets startedAt 0 so the boot grace is already satisfied.
		// This gates lane 1's claude (it boots with the session); lanes >1 gate their own.
		rt[label] ??= { starting: true, startedAt: 0, lanes: {} }
		const re = rt[label]
		re.lanes ??= {} // migrate a flat entry persisted before per-lane rt existed
		// Keep a live worktree's dir/base current so the kill loop can clean it up once its
		// line is deleted (by then it's gone from the model, so rt is the only record).
		if (s.worktreeBase) {
			re.worktreeDir = dir
			re.worktreeBase = s.worktreeBase
		}
		if (re.starting && Date.now() - re.startedAt < READY_MS) continue // let claude boot
		re.starting = false
		if (s.desiredSession && /NO DIR/i.test(s.desiredSession)) s.desiredSession = null
		// Attention is a per-prompt marker now; strip any legacy session-level one.
		clearAttention(s)

		// Plan each lane independently: filtered view + its own done-files + its own rt.
		// Different lanes advance concurrently, one active item each.
		for (const n of lanesOf(s)) {
			re.lanes[n] ??= { sentAt: 0, cmdSentAt: 0, prevPromptCount: lanePromptCount(s, n), macroStep: 0, starting: false, startedAt: 0 }
			const lr = re.lanes[n]
			// This lane just captured manually-typed input into the file (staged above). Don't
			// also dispatch this tick — the new row is already running in the pane; it's tracked
			// from the next parse. Dispatching now would fire the pending queue into a busy pane.
			if (capturedLanes.has(`${label}:${n}`)) continue
			// Ensure the panes this lane needs exist and can report completion, else create
			// them and wait (skipped in --dry-run, where panes aren't real).
			if (!DRY) {
				// A `:N` lane needs its claude<N> window (n>1; claude1 came with the session).
				if (n > 1 && laneHasClaude(s, n) && (await paneFor(label, 'claude', n)) === null) {
					lr.starting = true
					lr.startedAt = Date.now()
					actions.push(() => ensurePaneWindow(label, dir, 'claude', n).then(() => {}))
					continue
				}
				if (lr.starting && Date.now() - lr.startedAt < READY_MS) continue // let claude<N> boot
				lr.starting = false
				// A `$N` lane isn't ready until it has a *tagged* shell<N> pane — the pane
				// whose per-shell hook reports completion. Missing ⇒ partial spawn; untagged ⇒
				// tmux-resurrect stripped HERALD_SHELL/HERALD_PANE (commands would hang at
				// [EXECUTING]). Either way recreate it (self-heal) before dispatching.
				if (laneHasShell(s, n) && (await taggedPane(label, 'shell', n)) === null) {
					actions.push(() => repairShell(label, dir, n))
					continue
				}
			}
			// Capture what an in-flight command's completion would look like *before*
			// planQueue mutates markers/timers, so we can clear its done-file afterwards.
			const cmdSentAtBefore = lr.cmdSentAt
			const hadActiveCmd = s.prompts.some((p) => p.pane === n && p.isCmd && p.desiredKind === 'EXECUTING')
			const cmdDoneMtime = readCmdDone(label, n)
			// Poll the claude pane's live busy state (lanes with prompts only; `$`-only lanes
			// have no claude pane). null (unreadable) ⇒ undefined so the planner falls back to
			// pure hook-driven behavior rather than acting on a bad read.
			const paneBusy = !DRY && laneHasClaude(s, n) ? ((await claudeBusy(label, n)) ?? undefined) : undefined
			const state = readState(label, n)
			// A finished `:` prompt (fresh Stop, pane idle) gets a one-line `-> ` summary mirrored
			// below it. Capture it now — before planQueue advances the queue and dispatches any next
			// prompt at tick's end — so the transcript still reflects the turn that just ended. Same
			// freshness/paneBusy gate planQueue uses to latch [DONE]; the `!p.note` guard makes it
			// fire once (a lingering stale Stop is ignored after the line lands). Plain prompts only.
			if (!DRY && state?.event === 'Stop' && state.mtimeMs > lr.sentAt && paneBusy !== true) {
				const done = s.prompts.find(
					(p) => p.pane === n && p.desiredKind === 'EXECUTING' && !p.isCmd && !p.isMacro && !p.isBarrier && !p.isShow && !p.note && p.text.trim() !== '/clear',
				)
				if (done) {
					const summary = readAssistantNote(label, n)
					if (summary) done.desiredNote = summary
				}
			}
			const dispatches = planQueue(laneView(s, n), lr, { now: Date.now(), state, cmdDoneMtime, paneBusy })
			if (hadActiveCmd && cmdDoneMtime !== null && cmdDoneMtime > cmdSentAtBefore) rmCmdDone(label, n)
			for (const d of dispatches) {
				// Record what we send so the capture pass can tell it from human input (our sends
				// re-fire the same UserPromptSubmit/post-command hooks). Recorded as the action
				// actually runs, so a deferred (unsent) dispatch leaves no phantom echo.
				if (d.type === 'prompt') actions.push(() => (recordSent(lr, false, d.text!), sendLine(label, d.text!, true, n)))
				else if (d.type === 'cmd') actions.push(() => (recordSent(lr, true, d.text!), sendCmd(label, d.text!, n)))
				else if (d.type === 'clear') actions.push(() => (recordSent(lr, false, '/clear'), sendLine(label, '/clear', true, n)))
				else if (d.type === 'show') actions.push(() => showSession(label, d.window))
			}
		}
	}

	// A session that stays in the control file (and is live) is a safe place to
	// park a client before we kill the session it's watching.
	const survivor = [...live].find((label) => modelLabels.has(label) || RESERVED.has(label)) ?? null
	for (const { label, worktree } of reapTargets(live, modelLabels, RESERVED, rt)) {
		actions.push(() => doKill(label, survivor))
		// If this was a worktree, remove it from disk too (after the kill frees its cwd), so
		// worktrees are torn down alongside their session.
		if (worktree) actions.push(() => removeWorktree(label, worktree.base, worktree.dir))
		rmAllDoneFiles(label)
		delete rt[label]
	}

	// A merged session's session-level markers were computed on the merged object; write
	// them to the primary (first-file) part so buildOps — which runs on the per-file
	// parts — emits them into that file. (Prompt markers already flow via shared objects.)
	for (const s of sessions) {
		if (!s.parts) continue
		s.parts[0].desiredSession = s.desiredSession
		s.parts[0].showNowFired = s.showNowFired
	}

	// If the user edited any `.herald` file while we computed, defer: skip writes AND
	// actions so nothing (e.g. a queued prompt) fires against a stale view.
	for (const c of controls) {
		if (safeMtime(c.path) !== c.mtime) {
			log(`${basename(c.path)} changed mid-tick, deferring`)
			return
		}
	}
	// Rewrite each file in place — only the ones whose markers actually changed. Capture
	// inserts (manually-typed rows) merge with the marker ops; both index into the original
	// lines, and applyOps orders them so the inserts and any marker deletes don't collide.
	for (const c of controls) {
		const ops = [...buildOps(c.sessions), ...(captureOps.get(c.path) ?? [])]
		const newContent = applyOps(c.lines, ops).join('\n')
		if (newContent !== c.content) atomicWrite(c.path, newContent)
	}
	for (const a of actions) await a()
	// Now that the tick has committed (past the defer point and the writes), advance the
	// capture send-pools and consume the logs. On a mid-tick defer we return above, leaving
	// the logs intact so the same input is re-read next tick — nothing is lost.
	for (const fn of commit) fn()
	saveRt(rt)
}

// Two supervisors watching the same control file race on its atomic write and one
// crashes, so we refuse to start a second. We hold a PID lockfile; a stale lock
// (owner no longer alive, e.g. after a crash) is reclaimed. Released on exit/signals.
const pidAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0)
		return true
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === 'EPERM' // exists, just not ours to signal
	}
}
const acquireLock = () => {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(LOCK, String(process.pid), { flag: 'wx' })
			const release = () => {
				try {
					if (readFileSync(LOCK, 'utf8') === String(process.pid)) unlinkSync(LOCK)
				} catch {}
			}
			process.on('exit', release)
			for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => (release(), process.exit(1)))
			return
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
			const owner = Number(readFileSync(LOCK, 'utf8').trim())
			if (owner && owner !== process.pid && pidAlive(owner)) {
				log(`another herald supervisor is already running (pid ${owner}); refusing to start a second`)
				process.exit(1)
			}
			try {
				unlinkSync(LOCK) // stale lock (owner gone) — reclaim it
			} catch {}
		}
	}
	log('could not acquire supervisor lock')
	process.exit(1)
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

if (isMain)
	void fire(async () => {
		$.verbose = false
		if (!existsSync(STATE)) mkdirSync(STATE, { recursive: true })
		const rt = loadRt()
		const found = controlFiles()
		if (DRY) {
			// One-shot preview: show what a single tick would do, then exit.
			log(`herald dry-run against ${found.length ? found.map((f) => basename(f)).join(', ') : `(no ${CONTROL_EXT} files found)`}`)
			await tick(rt)
			log('dry-run complete (no changes made)')
			return
		}
		acquireLock()
		log(`herald watching ${SINGLE_FILE ?? `${CONTROL_DIR}/*${CONTROL_EXT}`} (${found.length} file(s))`)
		while (true) {
			await tick(rt)
			await sleep(TICK_MS)
		}
	})
