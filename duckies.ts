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
	watch,
	writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fire } from '@jgjp/fire'
import { $, sleep, YAML } from 'zx'
import { startDashboard } from './duckies-menu'

const HERE = dirname(fileURLToPath(import.meta.url))
// Per-machine config (aliases/macros/widgets, plus the `duckspaces` control dir) lives here by
// default. `DUCKIES_CONFIG_DIR` overrides the dir; each file also has its own env override below.
const CONFIG_DIR = process.env.DUCKIES_CONFIG_DIR ? resolve(process.env.DUCKIES_CONFIG_DIR) : join(homedir(), '.config', 'duckies')
// The controller merges every `*.dk` file in the control dir (default: `~/.config/duckies/
// duckspaces`) into one logical control — each file is an independent slice of sessions and
// is rewritten in place. `DUCKIES_DIR` overrides the dir; `DUCKIES_FILE` forces
// single-file mode (one explicit file, mainly for tests/one-offs).
export const CONTROL_DIR = process.env.DUCKIES_DIR ? resolve(process.env.DUCKIES_DIR) : join(CONFIG_DIR, 'duckspaces')
const SINGLE_FILE = process.env.DUCKIES_FILE ? resolve(process.env.DUCKIES_FILE) : null
const CONTROL_EXT = '.dk'
// Optional YAML file of `label: /path/to/repo` aliases, so a header in a `.dk`
// file can be a short label instead of a full path.
const ALIASES_FILE = process.env.DUCKIES_ALIASES ? resolve(process.env.DUCKIES_ALIASES) : join(CONFIG_DIR, 'aliases.yaml')
const STATE = join(HERE, 'state')
const RT_PATH = join(STATE, 'controller.json')
const LOCK = join(STATE, 'supervisor.lock')
// Self-restart sentinel: when this file appears, the loop consumes it and exits with RESTART_EXIT.
// `nr start` runs under duckies-run.ts, which relaunches on that code — so `tsx` re-reads the
// (edited) source and the supervisor comes back on new code, in the same terminal, without a manual
// restart. `nr restart` writes the sentinel (see duckies-restart.ts); nothing new is ever spawned.
const RESTART_FILE = join(STATE, 'restart')
const RESTART_EXIT = 97
// Where a bare session name (not a path or alias) resolves: `<DEV_DIR>/<name>`.
// `DUCKIES_DEV_DIR` overrides it; defaults to `~/_dev`.
const DEV_DIR = process.env.DUCKIES_DEV_DIR ? resolve(process.env.DUCKIES_DEV_DIR) : join(homedir(), '_dev')
// The command typed into a fresh claude pane to launch the agent. `DUCKIES_AGENT_CMD`
// overrides it (e.g. a wrapper script or a different agent CLI).
const AGENT_CMD = process.env.DUCKIES_AGENT_CMD || 'claude'
// Instruction folded into every duckies-launched claude's system prompt: end each turn with a
// one-line `-> ` summary, which the note pass mirrors into the `.dk` file below the
// finished prompt. Delivered via a system-prompt *file* (see launchCmd), not `--append-system-
// prompt`, because that flag can't coexist with the `--append-system-prompt-file` a wrapping
// `claude` may already pass — and repeated `-file` flags are last-wins, not merged.
const NOTE_PROMPT =
	'When you finish responding to a prompt in this session, end your final message with a single line beginning with -> that states the actual useful outcome of the turn — the concrete result, or, when you were asked a question, the answer itself (NOT a description of what you did). Keep it terse (roughly 3-12 words) and plain text (no backticks, code, or long paths — a bare filename is fine). Good: "-> yes, all 3 CI checks are green"; "-> added /healthz + a passing test"; "-> the leak is in cacheWarm(), not the router". Bad (meta, omits the answer): "-> answered the question"; "-> investigated the issue".'
// A base system-prompt file to fold in, so a `--append-system-prompt-file` already on the
// launch (e.g. a personal prompt added by a shell `claude` wrapper) isn't lost to last-wins:
// duckies's file must be a superset. Defaults to the common fish-wrapper path; override or set
// empty to fold in nothing. Rebuilt each launch, so edits to it apply on the next spawn.
const BASE_SYSTEM_PROMPT_FILE = process.env.DUCKIES_SYSTEM_PROMPT_FILE ?? join(homedir(), '.config', 'fish', 'claude-system-prompt')
const SYSTEM_PROMPT_FILE = join(STATE, 'system-prompt')
const AGENT_IS_CLAUDE = /(^|[\s/])claude(\s|$)/.test(AGENT_CMD)
// (Re)build the combined system-prompt file (base + note instruction) and return its path.
// Shared by the interactive launch line and the headless DUCKIES agent so both fold in the
// user's base prompt and the `-> ` summary instruction.
function buildSystemPromptFile(): string {
	let base = ''
	if (BASE_SYSTEM_PROMPT_FILE) {
		try {
			base = `${readFileSync(BASE_SYSTEM_PROMPT_FILE, 'utf8').trimEnd()}\n\n`
		} catch {}
	}
	mkdirSync(STATE, { recursive: true })
	writeFileSync(SYSTEM_PROMPT_FILE, `${base}${NOTE_PROMPT}\n`)
	return SYSTEM_PROMPT_FILE
}
// The `--resume <id>` fragment for a (re)launch, or '' — empty for a non-claude agent, a missing
// id, or one that doesn't look like a conversation id (a UUID; the guard also keeps a stray value
// from injecting extra shell words). `claude -r <id>` reopens that conversation by id (reusing its
// id, since we don't pass --fork-session), so a tracked session is brought back rather than started
// fresh. Exported for the unit test.
export const resumeFlag = (resumeId: string | undefined, isClaude = true): string =>
	isClaude && resumeId && /^[0-9a-f-]{8,}$/i.test(resumeId) ? ` --resume ${resumeId}` : ''
// Build the combined system-prompt file (base + note instruction) and return the launch line.
// Non-claude agents (a custom DUCKIES_AGENT_CMD) launch as-is — the flag wouldn't exist. `resumeId`
// (a tracked conversation id for this lane) reopens that conversation instead of starting fresh.
function launchCmd(resumeId?: string): string {
	if (!AGENT_IS_CLAUDE) return AGENT_CMD
	return `${AGENT_CMD}${resumeFlag(resumeId)} --append-system-prompt-file '${buildSystemPromptFile()}'`
}
// DUCKIES directives: a `DUCKIES: <prompt>` line in a control file asks a background claude — run in
// the agent dir (its CLAUDE.md explains the `.dk` format), with the control dir added so it can
// edit the files — to act on the `.dk` file(s) themselves (e.g. "remove every idle lane here").
// Unlike a normal prompt it never joins the queue; it runs in its own visible tmux window inside a
// dedicated `__duckies-agent` session (revealable with `!DUCKIES:`). After it finishes the directive
// its window is KEPT ALIVE as a live conversation you can keep prompting; it's only torn down once
// idle (no hook activity) for `DUCKIES_AGENT_IDLE_MS` — a fresh prompt in the window resets that.
// `DUCKIES_AGENT_DIR` overrides the cwd/CLAUDE.md dir; `DUCKIES_AGENT_PERMISSION_MODE` the permission
// mode (default bypassPermissions — the run can't answer prompts); `DUCKIES_AGENT_MODEL` an optional model.
const AGENT_DIR = process.env.DUCKIES_AGENT_DIR ? resolve(process.env.DUCKIES_AGENT_DIR) : join(HERE, 'agent')
const DUCKIES_AGENT_PERM = process.env.DUCKIES_AGENT_PERMISSION_MODE || 'bypassPermissions'
const DUCKIES_AGENT_MODEL = process.env.DUCKIES_AGENT_MODEL || ''
// How long a DUCKIES agent window may sit idle (no Stop/prompt hook activity) before it's torn down.
const DUCKIES_AGENT_IDLE_MS = Number(process.env.DUCKIES_AGENT_IDLE_MS) || 60 * 60 * 1000
// The dedicated tmux session (`__duckies-agent`) that holds one window per in-flight DUCKIES agent.
// Reserved (below) so duckies's reaper never kills it; it disappears on its own once its last agent
// window is torn down. Kept out of `~/_dev` name-resolution — it's never a real `.dk` session.
const AGENT_SESSION_LABEL = 'duckies-agent'
// macOS only: the terminal app to bring to the foreground on a `show`/`!`, so a reveal
// surfaces the window even under another app. Opt-in via `DUCKIES_TERM_APP` (e.g. `WezTerm`,
// `iTerm`, `Terminal`); unset ⇒ no app foregrounding (the tmux client still switches).
const TERM_APP = process.env.DUCKIES_TERM_APP || process.env.HERALD_TERM_APP
// Jev-driven [NEEDS ATTENTION]: when a claude turn ends cleanly, duckies normally latches [DONE].
// With this on, the turn's final assistant message is first judged by TypeSafe's Jev model — if it
// reads as "waiting on the human" (a question, follow-ups pending a go-ahead, a blocked/needs-a-
// decision ending) the lane is flagged [NEEDS ATTENTION] and held instead of draining on. Enabled
// only when `TYPESAFE_API_KEY` is set (the SDK reads it) and not explicitly disabled; a missing key,
// an error, or a timeout falls back to plain [DONE] so a Jev outage never stalls the queue.
// `DUCKIES_JEV_THRESHOLD` is the yes-probability cutoff (higher ⇒ fewer flags); `DUCKIES_JEV_TIMEOUT_MS`
// bounds the call; `DUCKIES_JEV_MODEL` optionally pins a Jev model.
const JEV_ATTENTION = !!process.env.TYPESAFE_API_KEY && process.env.DUCKIES_JEV_ATTENTION !== '0'
const JEV_THRESHOLD = Number(process.env.DUCKIES_JEV_THRESHOLD) || 0.6
const JEV_TIMEOUT_MS = Number(process.env.DUCKIES_JEV_TIMEOUT_MS) || 6000
const JEV_MODEL = process.env.DUCKIES_JEV_MODEL || ''
// Labels the controller never manages (a blacklist). Empty by default.
const RESERVED = new Set<string>([AGENT_SESSION_LABEL])
const TICK_MS = 1000
// How long to coalesce a burst of filesystem events from one save before waking the poll
// loop early. Small enough that a `!` reveal reaches wezterm near-instantly, large enough to
// fold an editor's write+rename into a single tick. `DUCKIES_WATCH_MS=0` disables the watcher
// (falling back to pure TICK_MS polling).
const WATCH_MS = process.env.DUCKIES_WATCH_MS !== undefined ? Number(process.env.DUCKIES_WATCH_MS) : 40
// Grace period for a freshly launched claude to boot before we send its first prompt.
const READY_MS = Number(process.env.DUCKIES_READY_MS) || 6000
const DRY = process.argv.includes('--dry-run')

// Set once the interactive dashboard is started (real run in a TTY). Until then — and in dry-run or
// when disabled/non-TTY — `log` falls back to a plain timestamped console line.
let dash: ReturnType<typeof startDashboard> | null = null
const log = (m: string) => (dash ? dash.emit(m) : console.log(`${new Date().toISOString()} ${m}`))

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
export function loadAliases(): Aliases {
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

// Optional YAML file of `name: |<multiline block>` macros. A `@name` line in a `.dk`
// file is one queue item that expands IN MEMORY to that block's steps (see macroSteps).
const MACROS_FILE = process.env.DUCKIES_MACROS ? resolve(process.env.DUCKIES_MACROS) : join(CONFIG_DIR, 'macros.yaml')
export type Macros = Record<string, string>

// Load the `@name`→block macro map, tolerating a missing/empty/malformed file.
export function loadMacros(): Macros {
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

// Optional YAML file of `name: |<multiline block>` templates. A `>name args` line in a `.dk`
// file is a TEMPLATE call: unlike a macro (`@name`, which expands in memory to steps run
// silently while the file keeps the one `@name` line), a template is a paste — the call line is
// physically replaced in the file by the body (arg-filled, re-indented under the call site), so
// the injected prompts/commands become ordinary visible rows the drain runs like any other.
const TEMPLATES_FILE = process.env.DUCKIES_TEMPLATES ? resolve(process.env.DUCKIES_TEMPLATES) : join(CONFIG_DIR, 'templates.yaml')
export type Templates = Record<string, string>

// Load the `<name>`→body template map, tolerating a missing/empty/malformed file (same shape as
// macros).
export function loadTemplates(): Templates {
	try {
		const parsed = YAML.parse(readFileSync(TEMPLATES_FILE, 'utf8'))
		if (!parsed || typeof parsed !== 'object') return {}
		const out: Templates = {}
		for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v
		return out
	} catch {
		return {}
	}
}

// Optional YAML file of widgets: `name: { interval: <ms>, commands: [<shell cmd>, …] }`. An
// `&name` line in a `.dk` file is a status display — duckies runs its commands and mirrors
// their combined stdout back into the file as `| `-prefixed lines indented below the `&name` line.
// A single `&` runs once; `&&` reruns every `interval` ms (live). Unlike a macro, a widget never
// drains: it isn't a queue item.
const WIDGETS_FILE = process.env.DUCKIES_WIDGETS ? resolve(process.env.DUCKIES_WIDGETS) : join(CONFIG_DIR, 'widgets.yaml')
export interface Widget {
	interval: number
	commands: string[]
}
export type Widgets = Record<string, Widget>
const WIDGET_MIN_INTERVAL = 1000 // the tick floor — a shorter interval can only refresh per tick
// Load the `&name`→widget map, tolerating a missing/empty/malformed file. A valid entry is an
// object with a non-empty string-array `commands`; `interval` defaults to 10s and is floored at
// the tick cadence (a widget can't refresh faster than duckies ticks).
export function loadWidgets(): Widgets {
	try {
		const parsed = YAML.parse(readFileSync(WIDGETS_FILE, 'utf8'))
		if (!parsed || typeof parsed !== 'object') return {}
		const out: Widgets = {}
		for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
			if (!v || typeof v !== 'object') continue
			const cmds = (v as { commands?: unknown }).commands
			if (!Array.isArray(cmds) || !cmds.every((c) => typeof c === 'string') || cmds.length === 0) continue
			const raw = (v as { interval?: unknown }).interval
			const interval = Math.max(WIDGET_MIN_INTERVAL, typeof raw === 'number' && raw > 0 ? raw : 10000)
			out[k] = { interval, commands: cmds as string[] }
		}
		return out
	} catch {
		return {}
	}
}
// A `@<name> [args…]` line (any indent) is a macro call: one queue item whose body expands
// IN MEMORY to a sequence of steps run one at a time, while the file keeps the `@name` line
// and gets a single overall marker. `{0}`,`{1}`,… are the positional args (0-based;
// quote-aware so `"two words"` is one arg), `{*}` is all of them space-joined, a missing one
// is blank. Braces avoid clashing with duckies's own `$N`/`:N` lane sigils. A name char must
// follow the `@`, so a body line like `@@@…` never matches.
const MACRO_RE = /^([ \t]*)@([\w-]+)(?:[ \t]+(.*\S))?[ \t]*$/
// A `&<name> [args…]` line (any indent) is a widget call — same shape as a macro call, but it
// resolves against the widget map and produces live output instead of queue steps. A single `&`
// runs the widget once (a one-shot capture); `&&` reruns it on the widget's interval (live). The
// name char must follow the sigil run; the rest is args and/or an inline-output suffix (see parse).
const WIDGET_RE = /^(&+)([\w-]+)(.*)$/
const macroArgs = (s: string): string[] => (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((a) => (/^"[^]*"$|^'[^]*'$/.test(a) ? a.slice(1, -1) : a))
const fillArgs = (text: string, args: string[]): string => text.replace(/\{\*\}/g, args.join(' ')).replace(/\{(\d+)\}/g, (_, d) => args[+d] ?? '')
// A `>name [args…]` line (any indent) is a TEMPLATE call — same `>`-sigil shape as a macro's `@`,
// but it resolves against the template map and is a text paste, not a queue item. A name char must
// follow the `>`, so a prompt body or a `->` note never matches. `{0}`/`{1}`/`{*}` fill args
// exactly like a macro.
const TEMPLATE_RE = /^([ \t]*)>([\w-]+)(?:[ \t]+(.*\S))?[ \t]*$/
// Re-indent a template body to the `.dk` tab convention. Authors write the body with ordinary YAML
// indentation — usually spaces — but `.dk` nests with ONE TAB per level, so a space-indented body
// pasted verbatim wouldn't conform. Detect the body's own indent unit (its smallest positive
// leading-space run; a tab-indented body counts one tab per level directly) and re-express each
// line's depth as that many tabs, then prefix the call site's own indent so the whole block lands
// under it. Blank lines stay blank (no stray indent).
export function reindentBody(body: string, callIndent: string): string[] {
	const lines = body.split('\n')
	const leads = lines.filter((l) => l.trim() !== '').map((l) => l.match(/^[ \t]*/)![0])
	const usesTabs = leads.some((s) => s.includes('\t'))
	const unit = usesTabs ? 1 : Math.min(Infinity, ...leads.map((s) => s.length).filter((n) => n > 0))
	return lines.map((l) => {
		if (l.trim() === '') return ''
		const lead = l.match(/^[ \t]*/)![0]
		const depth = usesTabs ? (lead.match(/\t/g) ?? []).length : unit === Infinity ? 0 : Math.floor(lead.length / unit)
		return callIndent + '\t'.repeat(depth) + l.slice(lead.length)
	})
}
// Expand every `>name args` call in a `.dk` file's raw text: replace each call line with the named
// template's body, arg-filled and re-indented (see reindentBody) so the pasted rows nest with tabs
// under the call site. An unknown name is left untouched (a typo stays visible). Returns the input
// unchanged when there's nothing to expand, so the tick can cheaply detect "no injection this pass".
export function expandTemplates(content: string, templates: Templates): string {
	const lines = content.split('\n')
	const out: string[] = []
	let changed = false
	for (const line of lines) {
		const m = line.match(TEMPLATE_RE)
		if (m && templates[m[2]] !== undefined) {
			changed = true
			const body = fillArgs(templates[m[2]], m[3] ? macroArgs(m[3]) : []).replace(/\n+$/, '')
			out.push(...reindentBody(body, m[1]))
		} else out.push(line)
	}
	return changed ? out.join('\n') : content
}

// Expand a macro body into steps, in RUN order: fill args, drop blank and `#` comment lines,
// classify each remaining line as a `$`command or a prompt, and reverse so they run
// bottom-to-top like every other duckies queue (the body's last line runs first). A step's
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

type Kind = 'EXECUTING' | 'DONE' | 'ATTENTION' | 'ERROR' | 'WAITING'
const MARKER: Record<Kind, string> = {
	EXECUTING: '[EXECUTING]',
	DONE: '[DONE]',
	ATTENTION: '[NEEDS ATTENTION]',
	ERROR: '[ERROR]',
	WAITING: '[WAITING]',
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
	// when the drain reaches it the queue halts there until the line is removed. It reads
	// as a comment (comment-scoped, ignored as a task). A column-0 `#` is a plain comment
	// instead — skipped in parse, never a barrier.
	isBarrier: boolean
	// A plain `#` barrier halts *every* lane (its `:2`/`:3` prompts are blocked by a comment
	// below them too), so a bare `#` gates the whole session. A numbered `#N` (`##`/`#2`, …)
	// is scoped to lane N only, letting the other lanes drain past it.
	barrierGlobal?: boolean
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
	// A bare `%` line: a queue item that, once everything below it in its lane has run,
	// deletes every prompt/command below it in that lane — and itself — collapsing the lane's
	// completed run. It fires whether or not the drain reaches it: a `%` added under an
	// already-finished run (the frontier now above it) still fires, since planQueue checks it
	// independently of the climbing drain. `%`/`%1` scope to lane 1, `%%`/`%2` to lane 2, etc.
	// Like `show` it never gets a marker; `fired` is set the tick it acts and buildOps does the
	// deletion. A leading `%` is chosen because it never starts a prompt/command/comment.
	isClear?: boolean
	// A leading `!` on this item — on its own line (`!: do the thing`, `!$ run me`) or on its
	// status marker line (`![NEEDS ATTENTION]`) — is a one-shot "reveal this item's window now"
	// request, like a leading `!` on a header. It fires once (`showNowFired`) and buildOps strips
	// the `!`, consuming the request.
	showNow?: boolean
	showNowFired?: boolean
	// The `!` is on this item's own line (not its marker), so consuming it rewrites
	// that line to `strippedLine` (the line without the `!`). For a `!` on a `|`
	// multiline body line, `strippedLineIdx` points at that body line instead of the
	// prompt's own `lineIdx`.
	showNowInline?: boolean
	strippedLine?: string
	strippedLineIdx?: number
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
	// The header text (what to rewrite the line to once a "show now" request is consumed).
	header: string
	// The header line's leading whitespace: '' for a column-0 repo header, the tab run
	// for an indented worktree label. buildOps prepends it when rewriting the line so a
	// consumed worktree `!` keeps its indentation.
	indent?: string
	// A leading `!` on the header ("show now"): switch the tmux client to this session
	// immediately, regardless of the queue. `showNowFired` is set the tick we act on
	// it, so buildOps strips the `!` — a one-shot request.
	showNow: boolean
	showNowFired: boolean
	// A leading `?` on the header or worktree label ("sleep"): tear the session's tmux down but
	// keep its tracked conversation ids (rt[label].conv), and don't respawn while it's set.
	// Removing the `?` wakes it — the normal spawn path --resumes the kept conversations. The `?`
	// stays in the file (buildOps never rewrites the header), so it's a persistent, user-toggled flag.
	sleep?: boolean
	// Set only on a merged logical session (a label that appears in >1 file): the
	// per-file sessions it combines, primary (first file) first. planQueue drives the
	// merged session; buildOps still runs on each part, and the tick syncs session-level
	// markers (desiredSession / showNow) back to the primary part. Undefined otherwise.
	parts?: Session[]
	// The `&name` widget calls in this session's block. Kept separate from `prompts` so the
	// drain never touches them — a widget is a live display, not a queue item.
	widgets: WidgetItem[]
	// The `DUCKIES:` directives in this session's block. Kept separate from `prompts` for the same
	// reason — they run a background agent on the files, never enter the queue or a tmux pane.
	duckies: DuckiesItem[]
}

// A parsed `&name [args]` line plus its current output. Single-line output renders inline on the
// widget line as `&name[ args]: <output>` (`inline` true); multi-line output renders as a `| `
// block one indent below, spanning `outputStartIdx..outputEndIdx` (`hasOutput` true). `call` is
// the indent-less `&name[ args]` text (with its sigil run, no inline suffix), so a rewrite
// preserves the once/live sigil, name and args. The tick reruns a live (`&&`) widget's commands
// every `interval` ms; a one-shot (`&`) widget runs a single time and is never rerun after.
// `bang` records a leading `!` (`!&pr`): a one-shot "refresh now" that forces a single run this
// tick regardless of the gate. It's consumed by the rewrite — `call` is clean, so the `!` is gone.
export interface WidgetItem {
	name: string
	args: string[]
	call: string
	once: boolean
	bang: boolean
	// The `&name` matched no entry in the widget map. Only set for a `!&name` refresh-now on
	// an unknown name — the tick reports `no widget "name"` inline instead of running anything.
	// (An unknown `&name` *without* a `!` falls through to worktree parsing, never reaching here.)
	unknown: boolean
	inline: boolean
	lineIdx: number
	indent: string
	outputStartIdx: number
	outputEndIdx: number
	hasOutput: boolean
}

// A parsed `DUCKIES: <directive>` line. Not a queue item and not a live display — a one-shot
// request for a background headless claude to edit the `.dk` file(s). `directive` is the text
// after `DUCKIES:`; `label`/`dir` name the session block it sits under (passed to the agent as
// context so "here"/"this" resolve). `note` is an existing `-> ` summary directly below it: its
// presence means the directive already ran (delete the note to re-run). `desiredNote` is the
// summary to write below it this tick, once the agent finishes.
export interface DuckiesItem {
	directive: string
	lineIdx: number
	indent: string
	label: string
	dir: string
	note: { text: string; lineIdx: number } | null
	desiredNote?: string | null
	// An `[EXECUTING]` marker directly below the directive while its background agent runs — the
	// duckies-pass analogue of a prompt's frontier marker. `marker` is one parsed from the file;
	// `desiredKind` is what this tick wants there (EXECUTING while running, null once the `-> ` note
	// lands). Only EXECUTING is ever placed: a finished directive is marked by its `-> ` note, not a
	// `[DONE]`. buildDuckiesOps reconciles the two.
	marker?: { kind: Kind; lineIdx: number } | null
	desiredKind?: Kind | null
	// A leading `!` (`!DUCKIES: …`): reveal the agent's tmux window once it exists. Fires once
	// (`showNowFired`), then buildOps rewrites the line to `strippedLine` (without the `!`).
	showNow?: boolean
	showNowFired?: boolean
	strippedLine?: string
}

// A prompt line starts with `prompt:` or the shorthand `:`. A run of colons or a
// trailing number selects the lane/pane: `:`→1, `::`/`:2`→2, `:::`/`:3`→3, …
const PROMPT_RE = /^(?:prompt:|(:+)(\d*))\s*/i
// A command line starts with `$` (runs in the shell window); `$$`/`$2`→lane 2, etc.
const CMD_RE = /^(\$+)(\d*)\s*/
// An indented `#` line is a barrier (halts the drain). A plain `#` is global — it halts
// every lane; `##`/`#2` halt lane 2 only, `###`/`#3` lane 3, etc.
const BARRIER_RE = /^(#+)(\d*)\s*/
// A bare `%` line clears its lane's completed run below it when the drain reaches it. `%`/`%1`
// scope to lane 1, `%%`/`%2` to lane 2, etc. Nothing may follow the sigil — it's just the mark.
const CLEAR_RE = /^(%+)(\d*)$/
// A `|` line continues the prompt above it as a multiline body (YAML block-scalar style):
// each body line is prefixed so it's unambiguous — never mistaken for a worktree — and its
// own indentation is preserved. The `|` and one optional following space are stripped; the
// rest (incl. any further leading spaces) is the literal text. A bare `|` is a blank line.
const CONT_RE = /^\|[ ]?/
// A `-> ` line is a one-line summary duckies mirrored below a finished prompt (see the note
// pass): inert (never runs, no marker), attached to the prompt above it. Recognised here so a
// non-sigil indented line isn't misread as a worktree. The `->` and one optional space strip.
const NOTE_RE = /^->[ ]?/
// A `DUCKIES: <directive>` line (any indent, including column 0) is a meta-directive: duckies runs a
// background claude to act on the `.dk` file(s) themselves. Case-sensitive `DUCKIES:` so it never
// clashes with prose in a prompt body. It never enters the queue — an indented one is collected on
// its session (like widgets), a column-0 one in the file's top-level `duckies` list; either way its
// completion is recorded by a `-> ` note written below it.
const DUCKIES_RE = /^DUCKIES:[ \t]*/
// A sigil run of length `run` (e.g. `::` → 2) or an explicit `digits` suffix (which
// wins) picks the 1-based lane. `prompt:`/plain sigils fall through to lane 1.
const paneFromSigil = (run: string | undefined, digits: string | undefined): number => (digits ? Math.max(1, parseInt(digits, 10) || 1) : run ? run.length : 1)
const isAttention = (x: string | null): boolean => !!x && /NEEDS ATTENTION/i.test(x)
const clearAttention = (s: Session) => {
	if (isAttention(s.desiredSession)) s.desiredSession = null
}

export function parse(content: string, aliases: Aliases = {}, macros: Macros = {}, widgets: Widgets = {}): { lines: string[]; sessions: Session[]; duckies: DuckiesItem[] } {
	const lines = content.split('\n')
	// The whole file is the sessions region; keep your backlog/footer in other
	// files. Blank lines are skipped, so nothing else is preserved verbatim.
	const sessions: Session[] = []
	// Top-level (column-0) `DUCKIES:` directives — not attached to any session. Collected here so a
	// directive can sit anywhere in the file, not only indented under a repo/worktree.
	const duckies: DuckiesItem[] = []
	let cur: Session | null = null
	// The prompt/command a deeper-indented line would continue. Set right after a `:`/`$`
	// line, cleared by anything else (header, marker, barrier, blank-separated item).
	let lastPrompt: Prompt | null = null
	// The widget a deeper `| ` line would extend as output. Set right after an `&name` line,
	// cleared by anything that isn't one of its output lines (mirrors lastPrompt).
	let lastWidget: WidgetItem | null = null
	// The top-level `DUCKIES:` directive a following indented `-> ` note attaches to (it has no
	// session container). Set right after a column-0 DUCKIES line, cleared by the next column-0 line.
	let lastTopDuckies: DuckiesItem | null = null
	// The enclosing repo/worktree stack (by indent). Queue items attach to the deepest one
	// they sit under; a non-sigil line opens a new worktree container. Reset per header.
	let containers: { indent: number; session: Session }[] = []
	for (let i = 0; i < lines.length; i++) {
		let line = lines[i]
		if (line.trim() === '') continue
		const tabs = line.match(/^\t*/)?.[0] ?? ''
		// A leading `!` on any line reveals that item's tmux pane (the shell for a `$command`, the
		// claude pane otherwise) once, then is stripped. A bare `!` line stays shorthand for
		// `show`, so only strip when content follows the `!`. Stripping it here lets every branch
		// below parse the clean line and merely take its "show now" flag from `leadingBang`.
		const afterTabs = line.slice(tabs.length)
		const leadingBang = /^!\s*\S/.test(afterTabs)
		if (leadingBang) line = tabs + afterTabs.replace(/^!\s*/, '')
		if (tabs.length === 0) {
			lastPrompt = null
			lastWidget = null
			lastTopDuckies = null
			// A column-0 `#` is a plain comment (it sits between sessions, so there is no
			// queue to halt): ignored and preserved verbatim, like a blank line. It also
			// closes the current session block, so an indented line beneath it (e.g. a
			// deeper `#` note) isn't captured as that session's barrier/worktree/prompt.
			if (line.trim().startsWith('#')) {
				cur = null
				containers = []
				continue
			}
			// A column-0 `DUCKIES:` directive: a top-level meta-command (not under any session). Caught
			// before the header / `<repo>:<worktree>` colon logic so the `:` in `DUCKIES:` isn't read as
			// a worktree split. Like a comment it ends the current session block; its `-> ` note (an
			// indented line right below) attaches via lastTopDuckies in the `!cur` branch.
			if (DUCKIES_RE.test(line.trim())) {
				const t0 = line.trim()
				const item: DuckiesItem = {
					directive: t0.replace(DUCKIES_RE, '').trim(),
					lineIdx: i,
					indent: tabs,
					label: '', // resolved to the control-file basename in the duckies pass
					dir: '',
					note: null,
					showNow: leadingBang || undefined,
					strippedLine: leadingBang ? tabs + t0 : undefined,
				}
				duckies.push(item)
				lastTopDuckies = item
				cur = null
				containers = []
				continue
			}
			const raw = line.trim()
			// A leading `!` on the header means "show this session immediately".
			const showNow = leadingBang
			// A leading `?` means "sleep": keep this session torn down (conversations preserved).
			// Stripped for label/dir resolution; it stays in the file as the user's toggle.
			const sleep = raw.startsWith('?')
			let header = sleep ? raw.slice(1).trimStart() : raw
			// Concatenated worktree syntax: `<repo>:<worktree>` at column 0 is exactly a bare
			// `<worktree>` line indented under a `<repo>` header — the same worktree session, without
			// having to nest. Split on the first `:` (unless the whole header is itself a known alias,
			// so a colon in an alias key still wins); the left resolves like any repo header, the right
			// names the worktree. The base repo gets no session of its own — an inert bare header never
			// spawns anyway — so it's just the worktree here, indent-0, its label/dir/base identical to
			// the nested form (`<repo>-<name>`, `<repo>-worktrees/<name>`) so state files line up.
			const colon = header.indexOf(':')
			if (colon > 0 && !aliases[header]) {
				const repoPart = header.slice(0, colon).trim()
				const name = header.slice(colon + 1).trim()
				if (repoPart && name) {
					const { label: baseLabel, dir: baseDir } = resolveTarget(repoPart, aliases)
					const wtCfg = aliasWorktree(aliases[repoPart])
					cur = {
						label: `${baseLabel}-${name}`,
						dir: join(dirname(baseDir), `${basename(baseDir)}-worktrees`, name),
						worktreeBase: baseDir,
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
						sleep,
						widgets: [],
						duckies: [],
					}
					sessions.push(cur)
					containers = [{ indent: 0, session: cur }]
					continue
				}
			}
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
				sleep,
				widgets: [],
				duckies: [],
			}
			sessions.push(cur)
			containers = [{ indent: 0, session: cur }]
			continue
		}
		if (!cur) {
			// Outside any session, the only indented lines we capture sit directly under a top-level
			// `DUCKIES:` directive: its `-> ` done-note, or its live `[EXECUTING]` marker. Everything
			// else is ignored.
			if (lastTopDuckies && NOTE_RE.test(line.trim())) lastTopDuckies.note = { text: line.trim().replace(NOTE_RE, ''), lineIdx: i }
			else if (lastTopDuckies && /^\[executing\]$/i.test(line.trim())) {
				lastTopDuckies.marker = { kind: 'EXECUTING', lineIdx: i }
				lastTopDuckies.desiredKind = 'EXECUTING'
			}
			continue
		}
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
			// A leading `!` on a `|` body line ("`!|`") reveals the parent prompt's window now,
			// like a `!` on the prompt line itself. The `!` was stripped above, so we record the
			// show-now request and point the strip-back at this body line (not the prompt line).
			if (leadingBang) {
				lastPrompt.showNow = true
				lastPrompt.showNowInline = true
				lastPrompt.strippedLine = tabs + t
				lastPrompt.strippedLineIdx = i
			}
			continue
		}
		// A `| ` line below an `&name` widget is one line of its live output block (duckies
		// writes it there; a human normally wouldn't). It's inert — never a queue item — and
		// its range is tracked so the tick can rewrite it with fresh output. A non-`|` line ends
		// the block. This is checked before the container routing below so output that happens to
		// look like a prompt/worktree (`> …`, `feat`) is never misparsed as queue content.
		if (lastWidget && CONT_RE.test(t)) {
			if (!lastWidget.hasOutput) {
				lastWidget.outputStartIdx = i
				lastWidget.hasOutput = true
			}
			lastWidget.outputEndIdx = i
			containers[containers.length - 1].session.lastChildIdx = i
			continue
		}
		lastPrompt = null
		lastWidget = null
		// Route this line to its container — the deepest repo/worktree it sits under. A
		// deeper indent nests; a shallower/equal one pops back out to an ancestor.
		const d = tabs.length
		while (containers.length > 1 && containers[containers.length - 1].indent >= d) containers.pop()
		const target = containers[containers.length - 1].session
		// Track the deepest container's last child too, so a worktree's session marker (e.g.
		// [NO DIR …]) is inserted below the worktree's own block, not the repo's.
		target.lastChildIdx = i
		const widgetMatch = t.match(WIDGET_RE)
		// A known `&name` is always a widget. An unknown one is normally left to fall through to
		// worktree parsing (so a typo stays visible as an inert line) — EXCEPT when it carries a
		// leading `!`: an explicit "refresh now" on a name that matches nothing. We keep that as a
		// widget so the tick can report `no widget "name"` inline, rather than revealing the tmux
		// (which is what the worktree branch's `showNow` would otherwise do).
		const knownWidget = widgetMatch !== null && widgets[widgetMatch[2]] !== undefined
		if (widgetMatch && (knownWidget || leadingBang)) {
			// A `&name [args]` call: a live display, not a queue item. A single `&` captures the output
			// once; `&&` reruns on the widget's interval. The tick rewrites the output — inline as
			// `&name: …` for a single line, or a `| ` block below for several. Split an optional
			// inline-output suffix (` : <output>`) off the rest here: the `: ` delimiter can't clash
			// with the name and rarely with an arg, and whatever follows is duckies's own output.
			const sigil = widgetMatch[1]
			const rest = widgetMatch[3]
			const ci = rest.indexOf(': ')
			const callArgs = ci >= 0 ? rest.slice(0, ci) : rest
			const argsStr = callArgs.trim()
			const item: WidgetItem = {
				name: widgetMatch[2],
				args: argsStr ? macroArgs(argsStr) : [],
				call: `${sigil}${widgetMatch[2]}${callArgs}`.trimEnd(),
				once: sigil.length === 1,
				bang: leadingBang,
				unknown: !knownWidget,
				inline: ci >= 0,
				lineIdx: i,
				indent: tabs,
				outputStartIdx: i,
				outputEndIdx: i,
				hasOutput: false,
			}
			target.widgets.push(item)
			lastWidget = item
			continue
		}
		const macroMatch = t.match(MACRO_RE)
		if (macroMatch && macros[macroMatch[2]] !== undefined) {
			// A `@name [args]` call: one item whose body expands in memory to `steps`. The
			// file keeps this line; buildOps writes a single overall marker below it. A leading
			// `!` (stripped above) reveals the macro's claude pane now, like on a plain prompt.
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
				showNow: leadingBang || undefined,
				showNowInline: leadingBang || undefined,
				strippedLine: leadingBang ? tabs + t : undefined,
			})
		} else if (DUCKIES_RE.test(t)) {
			// A `DUCKIES: <directive>` line: a one-shot request for a background agent to edit the
			// `.dk` file(s). Collected on the session (not the queue); its `-> ` note (attached
			// in the NOTE_RE branch below) marks it done. A leading `!` (stripped above) reveals the
			// agent's window once it's up, like a `!` on a prompt; the `!` is consumed once revealed.
			target.duckies.push({
				directive: t.replace(DUCKIES_RE, '').trim(),
				lineIdx: i,
				indent: tabs,
				label: target.label,
				dir: target.dir,
				note: null,
				showNow: leadingBang || undefined,
				strippedLine: leadingBang ? tabs + t : undefined,
			})
		} else if (PROMPT_RE.test(t) || CMD_RE.test(t)) {
			// A leading `!` (stripped above) reveals this item's window now — the shell for a
			// `$command`, the claude pane otherwise — like a leading `!` on its marker. It's
			// stripped from the line once consumed.
			const isCmd = CMD_RE.test(t)
			const re = isCmd ? CMD_RE : PROMPT_RE
			const m = t.match(re)!
			const pane = paneFromSigil(m[1], m[2])
			const bang = leadingBang
			const body = t
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
				// A plain single `#` (no repeats, no digits) is a global barrier; `##`/`#N` scope
				// to a lane. paneFromSigil maps a plain `#` to lane 1, so global vs. lane-1 is read
				// off the raw sigil here rather than the pane.
				barrierGlobal: m[1].length === 1 && !m[2],
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
		} else if (CLEAR_RE.test(t)) {
			// A bare `%` line: clear this lane's completed prompts/commands below it once the
			// drain reaches it. `%`/`%1`→lane 1, `%%`/`%2`→lane 2, … (like the other sigils).
			const m = t.match(CLEAR_RE)!
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
				pane: paneFromSigil(m[1], m[2]),
				isShow: false,
				isClear: true,
				fired: false,
			})
		} else if (/^\[.*\]$/.test(t)) {
			// A leading `!` on a marker means "reveal this item's window now".
			const bang = leadingBang
			const body = t
			const kind: Kind | null = /executing/i.test(body)
				? 'EXECUTING'
				: /attention/i.test(body)
					? 'ATTENTION'
					: /error/i.test(body)
						? 'ERROR'
						: /waiting/i.test(body)
							? 'WAITING'
							: /done/i.test(body)
								? 'DONE'
								: null
			// A status marker attaches to the nearest preceding prompt (in this container)
			// without a marker; anything unrecognised (e.g. [NO DIR …]) is a session marker. A
			// `DUCKIES:` directive can also own an `[EXECUTING]` marker — if one sits nearer than any
			// unmarked prompt, it wins (same nearest-item rule the `-> ` note pass uses).
			const owner = kind ? [...target.prompts].reverse().find((p) => !p.marker && !p.isBarrier && !p.isShow) : undefined
			const duckiesOwner = kind ? [...target.duckies].reverse().find((h) => !h.marker) : undefined
			if (kind && duckiesOwner && (!owner || duckiesOwner.lineIdx > owner.lineIdx)) {
				duckiesOwner.marker = { kind, lineIdx: i }
				duckiesOwner.desiredKind = kind
			} else if (kind && owner) {
				owner.marker = { kind, lineIdx: i }
				owner.desiredKind = kind
				if (bang) owner.showNow = true
			} else {
				target.sessionMarker = { text: body, lineIdx: i }
				target.desiredSession = body
			}
		} else if (NOTE_RE.test(t)) {
			// A `-> <summary>` line duckies wrote below a finished prompt or `DUCKIES:` directive.
			// Inert (no marker, never runs); attach it to the nearest preceding item so buildOps
			// won't re-add it. Caught here, before the worktree case, so the non-sigil line isn't
			// read as a worktree. A `DUCKIES:` directive above wins when it's nearer than any prompt.
			const promptOwner = [...target.prompts].reverse().find((p) => !p.isBarrier && !p.isShow)
			const duckiesOwner = target.duckies[target.duckies.length - 1]
			const note = { text: t.replace(NOTE_RE, ''), lineIdx: i }
			if (duckiesOwner && (!promptOwner || duckiesOwner.lineIdx > promptOwner.lineIdx)) duckiesOwner.note = note
			else if (promptOwner) promptOwner.note = note
		} else {
			// A non-sigil indented line names a git worktree of its container's repo. It's a
			// child session whose dir (<repo>/../<repo>-worktrees/<name>) is created on demand — only
			// once it has queued work below it; an empty one is just an inert note. A leading `!`
			// means "show this worktree now", like on a repo header; it's stripped once acted on.
			const showNow = leadingBang
			// A leading `?` sleeps this worktree (tmux torn down, conversations kept); stripped from
			// the name for label/dir resolution but left in the file as the user's toggle. Sleep also
			// cascades from the enclosing container (`target`) — a `?repo` sleeps the worktrees nested
			// under *this* occurrence — but because that's the specific parsed parent object, a second
			// unprefixed block for the same repo doesn't drag its own worktrees to sleep.
			const sleep = t.startsWith('?')
			const name = sleep ? t.slice(1).trimStart() : t
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
				sleep: sleep || !!target.sleep,
				widgets: [],
				duckies: [],
			}
			sessions.push(wt)
			containers.push({ indent: d, session: wt })
		}
	}
	return { lines, sessions, duckies }
}

// ------------------------------------------------- lossless in-place rewrite

type Op = { pos: number; type: 'replace' | 'delete' | 'insert'; text?: string }

// Rewrite ops for a set of `DUCKIES:` directives (session-attached or top-level): mirror a finished
// directive's `-> ` summary just below its line, once (the note then marks it done — parse won't
// re-run it; idempotent via the `!item.note` guard), and consume a fired `!DUCKIES:` reveal by
// rewriting the line without its `!`.
export function buildDuckiesOps(items: DuckiesItem[]): Op[] {
	const ops: Op[] = []
	for (const item of items) {
		if (item.showNowFired && item.strippedLine !== undefined) ops.push({ pos: item.lineIdx, type: 'replace', text: item.strippedLine })
		if (item.desiredNote != null && !item.note) ops.push({ pos: item.lineIdx, type: 'insert', text: `${item.indent}\t-> ${item.desiredNote}` })
		// Reconcile the `[EXECUTING]` marker: write it just below the directive while the agent
		// runs, drop it once the run ends (the `-> ` note, inserted above, takes its place).
		const cur = item.marker?.kind ?? null
		const want = item.desiredKind ?? null
		if (cur !== want) {
			if (item.marker) ops.push(want === null ? { pos: item.marker.lineIdx, type: 'delete' } : { pos: item.marker.lineIdx, type: 'replace', text: `${item.indent}\t${MARKER[want]}` })
			else if (want !== null) ops.push({ pos: item.lineIdx, type: 'insert', text: `${item.indent}\t${MARKER[want]}` })
		}
	}
	return ops
}

// `skip` names sessions whose header is being removed wholesale this tick (see
// vacatedSessions) — their marker/note ops are pointless, so we don't emit them.
export function buildOps(sessions: Session[], skip?: Set<Session>): Op[] {
	const ops: Op[] = []
	for (const s of sessions) {
		if (skip?.has(s)) continue
		// A fired `%N` "clear below" marker deletes itself plus every lane-N prompt/command below
		// it (with its marker/note/body lines), collapsing that lane's completed run. Collect the
		// doomed line indices first so the marker pass below skips those items and never re-adds
		// their markers. Other lanes, barriers, `show`s and `#` comments below the `%` are kept.
		const clearedLines = new Set<number>()
		const clearedItems = new Set<Prompt>()
		for (const c of s.prompts) {
			if (!c.isClear || !c.fired) continue
			clearedItems.add(c)
			clearedLines.add(c.lineIdx)
			for (const p of s.prompts) {
				if (p.pane !== c.pane || p.lineIdx <= c.lineIdx || p.isClear || p.isBarrier || p.isShow) continue
				clearedItems.add(p)
				for (let ln = p.lineIdx; ln <= p.bodyEndIdx; ln++) clearedLines.add(ln)
				if (p.marker) clearedLines.add(p.marker.lineIdx)
				if (p.note) clearedLines.add(p.note.lineIdx)
			}
		}
		for (const ln of clearedLines) ops.push({ pos: ln, type: 'delete' })
		for (const p of s.prompts) {
			// An unfired `%` is inert (no marker); a fired one — and the items it clears — are
			// handled by the deletion pass above, so skip them here.
			if (p.isClear || clearedItems.has(p)) continue
			// A fired `show` item is consumed by deleting its line; it has no marker.
			if (p.isShow) {
				if (p.fired) ops.push({ pos: p.lineIdx, type: 'delete' })
				continue
			}
			// A fired inline `!` sits on the item's own line, which the marker logic
			// below never rewrites, so strip it here unconditionally.
			if (p.showNowFired && p.showNowInline && p.strippedLine !== undefined) ops.push({ pos: p.strippedLineIdx ?? p.lineIdx, type: 'replace', text: p.strippedLine })
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
		ops.push(...buildDuckiesOps(s.duckies))
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

// Render a widget's captured output into the `| `-prefixed lines that sit one indent below its
// `&name` line: each output line becomes `<indent>\t| <text>` (an empty line is a bare
// `<indent>\t|`), so arbitrary content — even lines that look like sigils — round-trips as inert.
// Empty output produces no lines at all.
export function widgetOutputLines(item: WidgetItem, output: string): string[] {
	if (output === '') return []
	return output.split('\n').map((l) => (l === '' ? `${item.indent}\t|` : `${item.indent}\t| ${l}`))
}

// Ops to bring each widget's rendered output in line with fresh output. `outputs` maps a widget
// to its new raw output; a widget absent from the map (not due to rerun this tick) is left alone.
// Single-line output renders inline on the widget line (`&name: …`); anything else renders as a
// `| ` block below and the line reverts to a bare `&name`. Reconciles both the widget line and the
// block, and emits nothing when the display is already what it should be (so an unchanged widget
// never rewrites the file). Pure, so it's unit-testable.
export function buildWidgetOps(sessions: Session[], lines: string[], outputs: Map<WidgetItem, string>): Op[] {
	const ops: Op[] = []
	for (const s of sessions) {
		for (const w of s.widgets) {
			if (!outputs.has(w)) continue
			const raw = outputs.get(w)!
			const outLines = raw === '' ? [] : raw.split('\n')
			const inline = outLines.length === 1
			const desiredLine = `${w.indent}${w.call}${inline ? `: ${outLines[0]}` : ''}`
			const desiredBlock = inline ? [] : outLines.map((l) => (l === '' ? `${w.indent}\t|` : `${w.indent}\t| ${l}`))
			if (lines[w.lineIdx] !== desiredLine) ops.push({ pos: w.lineIdx, type: 'replace', text: desiredLine })
			const current = w.hasOutput ? lines.slice(w.outputStartIdx, w.outputEndIdx + 1) : []
			if (!(current.length === desiredBlock.length && current.every((l, idx) => l === desiredBlock[idx]))) {
				if (w.hasOutput) for (let ln = w.outputStartIdx; ln <= w.outputEndIdx; ln++) ops.push({ pos: ln, type: 'delete' })
				if (desiredBlock.length) ops.push({ pos: w.lineIdx, type: 'insert', text: desiredBlock.join('\n') })
			}
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

// Sessions whose label line should be removed because the label no longer holds anything: no
// prompts/commands of its own and every child worktree likewise vacated. A finished worktree is
// removed, and if that leaves its repo empty the repo goes too (the cascade runs in one tick,
// while the worktree is still live). Guarded on liveness — a session is only removed if it, or
// something in its subtree, is a live tmux session — so a freshly-typed header you haven't queued
// work under yet, or a deliberately-empty note, is left alone. Returns the top-most removable
// sessions (delete their whole block, headerIdx..lastChildIdx) and the full removed set (buildOps
// skips these, since their markers are about to vanish). Pure, so it's unit-testable.
export function vacatedSessions(sessions: Session[], liveLabels: Set<string>, attached: Set<string> = new Set()): { tops: Session[]; all: Set<Session> } {
	const ordered = [...sessions].sort((a, b) => a.headerIdx - b.headerIdx)
	const depth = (s: Session) => (s.indent ?? '').length
	const parent = new Map<Session, Session | null>()
	const children = new Map<Session, Session[]>()
	const stack: Session[] = []
	for (const s of ordered) {
		children.set(s, [])
		while (stack.length && depth(stack[stack.length - 1]) >= depth(s)) stack.pop()
		const p = stack.length ? stack[stack.length - 1] : null
		parent.set(s, p)
		if (p) children.get(p)!.push(s)
		stack.push(s)
	}
	const removed = new Set<Session>()
	const liveSub = new Map<Session, boolean>()
	// Bottom-up (deepest headerIdx first) so a child's verdict is known before its parent's.
	for (const s of [...ordered].reverse()) {
		const kids = children.get(s)!
		liveSub.set(s, liveLabels.has(s.label) || kids.some((k) => liveSub.get(k)!))
		// A widget or an unfinished `DUCKIES:` directive makes a session "occupied" the same way a
		// prompt does — a live display or a still-running directive must not be reaped from under its
		// line. A directive that already has its `-> ` note is done, so it no longer holds the session.
		// A session a tmux client is currently viewing is never reaped out from under you — so a just
		// -created empty session persists while you're in it (it's cleaned up once you switch away).
		if (s.prompts.length === 0 && s.widgets.length === 0 && s.duckies.every((h) => h.note) && kids.every((k) => removed.has(k)) && liveSub.get(s)! && !attached.has(s.label)) removed.add(s)
	}
	const tops = ordered.filter((s) => removed.has(s) && !(parent.get(s) && removed.has(parent.get(s)!)))
	return { tops, all: removed }
}

// Delete ops for the vacated blocks (headerIdx..lastChildIdx each). When a block sat between two
// blank lines, one of them is dropped too, so removing the label doesn't leave a double blank
// where a single separator belongs. A Set dedups the shared blank between two adjacent removals.
export function vacateOps(tops: Session[], lines: string[]): Op[] {
	const del = new Set<number>()
	for (const s of tops) {
		for (let ln = s.headerIdx; ln <= s.lastChildIdx; ln++) del.add(ln)
		const above = s.headerIdx - 1
		const below = s.lastChildIdx + 1
		if (above >= 0 && lines[above]?.trim() === '' && lines[below]?.trim() === '') del.add(below)
	}
	return [...del].map((pos) => ({ pos, type: 'delete' as const }))
}

// ---------------------------------------------------- capture-to-file placement

// A manually-typed item captured from a live pane: a claude prompt (isCmd false) or a shell
// command (isCmd true), with duckies's own sends already filtered out.
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
	// A finished command captured while a live prompt still holds the lane's [EXECUTING]/[WAITING]
	// marker (its claude turn is running — or backgrounded and about to resume — in the other
	// pane): log the command(s) as already-run rows just below that prompt, without stealing its
	// marker — the shell and claude panes run at once, so the prompt must stay the tracked frontier.
	if (!prompts.length && (frontier?.desiredKind === 'EXECUTING' || frontier?.desiredKind === 'WAITING')) {
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

// Shell commands typed while a lane's frontier is [NEEDS ATTENTION] are dropped, not captured:
// the pane is paused waiting on the user, so a poke-around command isn't queue history, and
// capturing it would steal the lane's one marker — flipping [NEEDS ATTENTION] to [DONE] and
// hiding that the prompt still needs the user. Prompts still pass through (answering the prompt
// legitimately resolves the attention). No-op when the frontier isn't [NEEDS ATTENTION].
export function dropDuringAttention(s: Session, n: number, items: CaptureItem[]): CaptureItem[] {
	const marked = s.prompts.filter((p) => p.pane === n && p.desiredKind !== null)
	const frontier = marked.length ? marked.reduce((a, b) => (b.order < a.order ? b : a)) : null
	return frontier?.desiredKind === 'ATTENTION' ? items.filter((it) => !it.isCmd) : items
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
	// duckies's own sends (which re-fire the same UserPromptSubmit/post-command hooks) from
	// input a human typed straight into the pane. Each is matched-and-dropped once.
	pendingSent?: string[]
	pendingSentCmd?: string[]
	// Jev attention latch (JEV_ATTENTION only), keyed on the turn's Stop mtime so it's computed
	// once per turn and reused on the lingering-Stop ticks that follow. `attnAt` is that Stop's
	// mtime; `attention` its verdict. A newer Stop (a new turn) is a different mtime, so the
	// judgment is re-run rather than the stale verdict re-applied.
	attnAt?: number
	attention?: boolean
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
	// Per-lane conversation id (lane n → claude `session_id`), captured from each hook payload so a
	// respawn of a not-live session can `--resume` it instead of starting fresh. Survives restarts
	// via controller.json and the spawn-reset below (which resets the lanes' timers but keeps this),
	// so a prompt added after a system restart reopens the prior conversation. Following a `/resume`
	// is automatic: the next hook carries the new id and overwrites the entry.
	conv?: Record<number, string>
	// Set while the session is slept (`?`). Lets wake respawn it even when its queue is fully
	// drained (no pending work would otherwise spawn nothing); cleared by the spawn-reset on wake.
	parked?: boolean
	// Per-widget refresh gate, keyed `name#occurrence` within this label: when it last ran, so a
	// widget only reruns once its `interval` has elapsed (survives restarts via controller.json).
	widgets?: Record<string, { lastRun: number }>
	// In-flight DUCKIES directives, keyed by directive hash + occurrence within this label. `startedAt`
	// is when the agent window was created (times out a stuck run); `sentAt` is when the directive was
	// typed in (0 until then — gates the boot grace, and its Stop must be newer to count as finished).
	// Persisted so a run is tracked across restarts.
	duckies?: Record<string, { startedAt: number; sentAt: number }>
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
	// The hook's `notification_type` when event === 'Notification'. `idle_prompt` (Claude's
	// "waiting for your input" nudge fired after ~60s idle) is benign — it arrives *after* the
	// turn's Stop, so it must not be mistaken for a mid-task block. Absent for non-Notification.
	notify?: string
	// The conversation id (`raw.session_id`) this hook fired for — tracked per lane so a later
	// respawn can `--resume` it. Follows a `/resume` in the pane automatically: the next hook
	// carries the new id. Absent if the payload has none.
	sessionId?: string
	mtimeMs: number
}
// Done-files are per lane. Lane 1 keeps the bare `<label>.json`/`<label>.cmd` names
// (back-compat, incl. tmux-resurrect restores that predate DUCKIES_PANE); lane n>1 uses
// `<label>.<n>.json`/`<label>.<n>.cmd`, matching the `DUCKIES_PANE` suffix the hooks add.
const paneSuffix = (n: number) => (n > 1 ? `.${n}` : '')
const statePath = (label: string, n: number) => join(STATE, `${label}${paneSuffix(n)}.json`)
// Read + parse a Stop/Notification hook state file at `p` (the newest event for that pane).
function readStateFile(p: string): StateEvent | null {
	try {
		const parsed = JSON.parse(readFileSync(p, 'utf8'))
		return { event: parsed.event as string, notify: parsed.raw?.notification_type as string | undefined, sessionId: parsed.raw?.session_id as string | undefined, mtimeMs: statSync(p).mtimeMs }
	} catch {
		return null
	}
}
const readState = (label: string, n: number): StateEvent | null => readStateFile(statePath(label, n))
// The conversation id to `--resume` for lane `n` of `label`: the tracked one (rt.conv), else the
// `session_id` the hook last wrote to the lane's state file. The fallback recovers resume for a
// session whose id was never tracked in rt — one that last ran under a build predating conv
// tracking, or whose rt entry was dropped — since the hook records session_id regardless. Undefined
// when neither is known (then the (re)launch starts a fresh conversation).
const resumeIdFor = (rt: Rt, label: string, n: number): string | undefined => rt[label]?.conv?.[n] ?? readState(label, n)?.sessionId ?? undefined
// The newest assistant message's full text from the transcript the hook payload at `path` points
// to (follow `raw.transcript_path`, take the last `assistant` entry, join its text parts). Null when
// the payload/transcript is unreadable or has no assistant message. The source for both the `-> `
// summary and the Jev attention judgment.
function assistantTextFromState(path: string): string | null {
	let tpath: unknown
	try {
		tpath = JSON.parse(readFileSync(path, 'utf8')).raw?.transcript_path
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
	let text: string | null = null
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
	return text
}
// The `-> ` summary from the claude turn that just finished: the last `-> …` line of the newest
// assistant message (the launch instruction asks claude to end each turn with one). Null when the
// transcript is unreadable or has no such line — the note pass then writes nothing.
function noteFromState(path: string): string | null {
	const text = assistantTextFromState(path)
	return text === null ? null : extractNote(text)
}
const readAssistantText = (label: string, n: number): string | null => assistantTextFromState(statePath(label, n))
// A lazily-built TypeSafe client (constructed only when JEV_ATTENTION fires, so a missing
// `TYPESAFE_API_KEY` never throws at startup).
let jevClient: import('@typesafe-ai/sdk').TypeSafeClient | null = null
// Ask Jev for the probability that `text` — the final assistant message of a finished turn — leaves
// the human with something to do (a question, follow-ups awaiting a go-ahead, a blocked/needs-a-
// decision ending). Returns the 0–1 probability, or null when disabled/empty or on any failure (no
// key, network, timeout, bad shape) — the caller then falls back to a plain [DONE]. Never throws.
async function jevAttentionProb(text: string): Promise<number | null> {
	if (!JEV_ATTENTION || !text.trim()) return null
	try {
		const { TypeSafeClient, noul } = await import('@typesafe-ai/sdk')
		jevClient ??= new TypeSafeClient(JEV_MODEL ? { defaultModel: JEV_MODEL } : {})
		const res = await jevClient.systemOne(
			{
				state: { finalMessage: text },
				questions: {
					needsAttention: noul(
						"This is the final message an autonomous coding agent (Claude) posted at the end of its turn. Judge whether it leaves the human operator with something to do or decide before the work is resolved — e.g. it asks the user a question, proposes follow-up actions and awaits a go-ahead, reports being blocked, or requests a decision, approval, or credential.",
						{
							true: 'The agent is waiting on the user: it poses a question, offers follow-ups pending approval, or is blocked needing a human decision or action before it can continue.',
							false: 'The agent reports the task finished with nothing outstanding for the user; any next steps are things it will handle itself or are purely informational.',
						},
					),
				},
			},
			{ timeout: JEV_TIMEOUT_MS },
		)
		return res.answers.needsAttention.noul ?? null
	} catch (e) {
		log(`WARN jev attention check failed: ${(e as Error).message}`)
		return null
	}
}
// The last `-> …` line in a blob of text, its `->` prefix stripped, or null if there is none.
// Shared by the transcript reader and the DUCKIES agent's captured stdout.
function extractNote(text: string): string | null {
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
// The exit status the per-shell hook wrote into the done-file (its whole contents). Non-zero
// means the `$command` failed — the planner marks it [ERROR] and halts the lane. Null when the
// file is missing or unparseable.
const readCmdExit = (label: string, n: number): number | null => {
	try {
		const code = parseInt(readFileSync(cmdDonePath(label, n), 'utf8').trim(), 10)
		return Number.isNaN(code) ? null : code
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
// panes, the capture logs, and any in-flight DUCKIES agent files, so a later reuse of the
// label doesn't read stale input.
const rmAllDoneFiles = (label: string) => {
	const l = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const re = new RegExp(`^${l}(?:(?:\\.\\d+)?\\.(json|cmd|in|incmd)|\\.dk\\..*)$`)
	for (const f of readdirSync(STATE)) {
		if (re.test(f)) {
			try {
				unlinkSync(join(STATE, f))
			} catch {}
		}
	}
}
// A short, stable key for a DUCKIES directive: a hash of its text plus its occurrence within the
// label, so line-number shifts don't change it and two identical directives don't collide. Keys the
// agent window's `@duckies` tag, its Stop-hook state file, and its in-flight rt record.
const duckiesHash = (s: string): string => {
	let h = 5381
	for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
	return h.toString(36)
}
// The DUCKIES agent's per-run state file, written by the agent `claude`'s Stop hook: its
// `DUCKIES_PANE` is set to `duckies.<key>`, so the hook lands its payload (event + transcript path)
// here. `<label>.dk.<key>.json` never collides with a lane's numeric-suffixed state file.
const duckiesFile = (label: string, key: string, ext: string) => join(STATE, `${label}.dk.${key}.${ext}`)
const rmDuckiesFiles = (label: string, key: string) => {
	const prefix = `${label}.dk.${key}.`
	for (const f of readdirSync(STATE)) if (f.startsWith(prefix)) {
		try {
			unlinkSync(join(STATE, f))
		} catch {}
	}
}
// The prompt fed to a DUCKIES agent: the directive plus where it came from, so "here"/"this" resolve.
const duckiesPrompt = (item: DuckiesItem, filePath: string): string =>
	[
		item.directive,
		'',
		'---',
		'This directive comes from a duckies control file. Location:',
		`  file: ${filePath}`,
		`  line: ${item.lineIdx + 1}   (the "DUCKIES:" line)`,
		`  session block: ${item.label}${item.dir ? `   (repo dir: ${item.dir})` : ''}`,
		'',
		'Words like "here", "this", "this worktree", "this lane" refer to that location in that file.',
		'Read the file to understand the surrounding session / worktree / lane structure, then make the',
		'requested edits to the .dk file(s). Keep the "DUCKIES:" line itself intact — do not delete or',
		'rewrite it — and do not add the "-> " summary line yourself (duckies writes that from your reply).',
		'End your reply with a "-> " one-line summary as usual. See CLAUDE.md for the .dk format.',
	].join('\n')
// Remove just one lane's state files (single-lane teardown), so its numbered done/capture
// logs don't linger — or get re-read — after the lane's panes are gone.
const rmLaneFiles = (label: string, n: number) => {
	for (const ext of ['json', 'cmd', 'in', 'incmd']) {
		try {
			unlinkSync(join(STATE, `${label}${paneSuffix(n)}.${ext}`))
		} catch {}
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

// Manually-typed input mirrored back into the `.dk` file. A live pane's hooks append
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
// A prompt the harness injects to re-invoke a session on its own — notably the
// `<task-notification>` block fired when a background task/loop completes. It fires the
// UserPromptSubmit hook like a real prompt, but no human typed it, so it must not be
// mirrored back into the `.dk` file as a captured `:` line.
export const isSyntheticPrompt = (p: string): boolean => /^\s*<task-notification>/.test(p)
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
				if (typeof p === 'string' && p !== '' && !isSyntheticPrompt(p)) items.push(p)
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
// Remember a prompt/command duckies just dispatched into a lane, so its own hook echo isn't
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

// The duckies-view window (window 0 of a top-level session): the tui in `--session` mode,
// showing this label's `.dk` blocks compiled across every control file — live, editable,
// bidirectionally synced. Launched with the same dir/alias/macro env the supervisor resolved,
// so it compiles from exactly the files duckies manages. tsx is taken from the repo's own
// node_modules so the pane needs nothing on PATH.
const TUI_PATH = join(HERE, 'tui.ts')
const TSX_BIN = join(HERE, 'node_modules', '.bin', 'tsx')
function viewCmd(label: string): string {
	// `env` so the assignments work regardless of the pane's login shell (fish has no
	// `VAR=val cmd` form); values are single-quoted for the shell that types the line.
	const env: string[] = [`DUCKIES_DIR=${q(CONTROL_DIR)}`]
	for (const k of ['DUCKIES_FILE', 'DUCKIES_ALIASES', 'DUCKIES_MACROS', 'DUCKIES_WIDGETS', 'DUCKIES_DEV_DIR'] as const) {
		if (process.env[k]) env.push(`${k}=${q(process.env[k]!)}`)
	}
	return `env ${env.join(' ')} ${q(TSX_BIN)} ${q(TUI_PATH)} --session ${q(label)}`
}

async function listTmux(): Promise<Set<string>> {
	const r = await $({ nothrow: true, quiet: true })`tmux list-sessions -F '#{session_name}'`
	const out = new Set<string>()
	for (const line of r.stdout.split('\n')) {
		const n = line.trim()
		if (n.startsWith(PREFIX)) out.add(n.slice(PREFIX.length))
	}
	return out
}

// Labels a tmux client is currently attached to (a session you're looking at). vacatedSessions never
// reaps one of these, so a freshly created empty session (a menu-added `!label` with no queue yet)
// survives while you're in it — and is cleaned up only once you switch away still-empty.
async function attachedLabels(): Promise<Set<string>> {
	const r = await $({ nothrow: true, quiet: true })`tmux list-clients -F '#{client_session}'`
	const out = new Set<string>()
	for (const line of r.stdout.split('\n')) {
		const n = line.trim()
		if (n.startsWith(PREFIX)) out.add(n.slice(PREFIX.length))
	}
	return out
}

// Each lane has a claude window (prompts) and a shell window (`$command`s). We tag each
// pane with a pane-scoped user option (@duckies = the role string) which — unlike pane
// titles — the running program can't clobber, and which survives focus changes, non-zero
// base-index, and controller restart. Lane 1 uses the bare roles `claude`/`shell` (the
// window names too), lane n>1 uses `claude<n>`/`shell<n>`. -s searches all windows.
type PaneKind = 'claude' | 'shell'
const paneRole = (kind: PaneKind, n: number): string => (n > 1 ? `${kind}${n}` : kind)

// Resolve a lane's pane by role: prefer the @duckies tag, else the window still named for
// that role (tag lost on tmux-resurrect, or a pre-tag session). Null if absent.
async function paneFor(label: string, kind: PaneKind, n: number): Promise<string | null> {
	const role = paneRole(kind, n)
	const r = await $({
		nothrow: true,
		quiet: true,
	})`tmux list-panes -s -t ${T(label)} -F ${'#{pane_id}\t#{@duckies}\t#{window_name}'}`
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

// Whether a captured claude pane is mid-turn, read from the live TUI's spinner line:
// while a turn runs Claude Code pins a `<glyph> <Gerund>… (<elapsed> · …)` status above the
// input box (e.g. `✳ Sock-hopping… (42s · ↓ 2.7k tokens)`). We anchor on a line that STARTS
// with a lone spinner glyph whose next token ends in `…(`, which excludes both the idle
// end-of-turn summary (`✻ Baked for 6m 55s` — no ellipsis/paren) and transcript prose that
// merely quotes a spinner (an assistant `⏺ …the pane shows Channelling… (18s)` line starts
// with text, not a lone glyph). The "esc to interrupt" hint is unreliable — it's dropped on
// extended-thinking turns.
export const paneWorking = (out: string): boolean => /^\s*[^\w\s]\s+\S*…\s*\(/m.test(out)
// Whether a captured claude pane has background tasks that will resume it on their own. While a
// backgrounded shell/task runs, Claude Code shows a `· <n> shells` segment in the *live* status
// footer (`⏵⏵ bypass permissions on · 2 shells · ← for agents`). When the turn has ended (pane
// idle) but that segment is present, the turn isn't finished — the background task fires a
// `<task-notification>` that resumes claude with no hook, so the lane must not be latched [DONE].
//
// The footer is the only authoritative source: it's the bottom-most rendered line, redrawn every
// frame, and its `· <n> shells` segment vanishes the instant the count hits zero. The rest of the
// pane is untrustworthy — a prior turn's `✻ Cogitated for 58s · 2 shells still running` summary
// carries the same text but is a historical log line that scrolls up and lingers, and a session
// that discusses duckies itself has conversation text quoting `· N shells`. Both would false-
// positive. So look only at the last few non-empty lines (the footer + status line), and still
// exclude the `… shells still running` summary form as a belt-and-suspenders guard.
export const paneBackgroundRunning = (out: string): boolean => {
	const lines = out.split('\n').filter((l) => l.trim() !== '')
	return lines.slice(-3).some((l) => /·\s*\d+\s+shells?\b/.test(l) && !/shells?\s+still\s+running\b/.test(l))
}
// Read a lane's claude pane once and classify it. true/false per signal, null if unreadable.
async function readClaudePane(label: string, n: number): Promise<{ busy: boolean; background: boolean } | null> {
	const pane = await paneFor(label, 'claude', n)
	if (pane === null) return null
	const r = await $({ nothrow: true, quiet: true })`tmux capture-pane -p -t ${pane}`
	if (r.exitCode !== 0) return null
	return { busy: paneWorking(r.stdout), background: paneBackgroundRunning(r.stdout) }
}
// Just the busy bit — for the reap gate, which only needs "don't kill a working pane".
async function claudeBusy(label: string, n: number): Promise<boolean | null> {
	return (await readClaudePane(label, n))?.busy ?? null
}

// The pane *only* if it still carries its @duckies tag. A tmux-resurrect restore brings a
// session back with fresh panes that ran `exec fish` under the session env alone: they
// lost the per-window DUCKIES_SHELL=1/DUCKIES_PANE that make the completion hook fire, and
// lost the @duckies tag. Such a pane is found by paneFor()'s name fallback but returns null
// here, which is what flags it for repair.
async function taggedPane(label: string, kind: PaneKind, n: number): Promise<string | null> {
	const role = paneRole(kind, n)
	const r = await $({
		nothrow: true,
		quiet: true,
	})`tmux list-panes -s -t ${T(label)} -F ${'#{pane_id}\t#{@duckies}'}`
	for (const line of r.stdout.split('\n')) {
		const [id, tag] = line.split('\t')
		if (id && tag === role) return id
	}
	return null
}

// The numbered lanes (n>1) that currently have a tmux window for this session, read from
// the @duckies tag (or the window name, if a restore stripped the tag). Lane 1 is the bare
// `claude`/`shell` session windows and never appears here — used to reap lanes whose lines
// were deleted from the file.
async function liveLanes(label: string): Promise<Set<number>> {
	const r = await $({ nothrow: true, quiet: true })`tmux list-panes -s -t ${T(label)} -F ${'#{@duckies}\t#{window_name}'}`
	const out = new Set<number>()
	for (const line of r.stdout.split('\n')) {
		const [tag, win] = line.split('\t')
		const m = /^(?:claude|shell)(\d+)$/.exec(tag || win || '')
		if (m) out.add(parseInt(m[1], 10))
	}
	return out
}
// The numbered lanes to tear down this tick: every live tmux lane (n>1) no longer backed by
// a model lane and without pending captured input (its `:n`/`$n` lines were deleted). Pure so
// the reap decision can be unit-tested apart from the tmux/state I/O.
export const lanesToReap = (live: Iterable<number>, model: number[], pendingCap: number[]): number[] => {
	const keep = new Set([...model, ...pendingCap])
	return [...live].filter((n) => n > 1 && !keep.has(n)).sort((a, b) => a - b)
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
		await tm`tmux set-buffer -b duckies -- ${text}`
		await tm`tmux paste-buffer -p -d -b duckies -t ${pane}`
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
	// Clear any prior command's done-file *before* typing this one, so its stale mtime can't be
	// read as this command's completion. Covers macro `$` steps too (a macro item is isCmd:false,
	// so the post-tick guard that removes plain-command done-files never fired for them).
	rmCmdDone(label, n)
	// The command's exit status is written to its done-file by the per-shell hook
	// in the shell window (see duckies-{fish,bash,zsh}.*), so we type it verbatim.
	await typeInto(pane, text)
}

// Strip terminal escape sequences (SGR colors, cursor moves, OSC 8 hyperlinks, etc.) and stray
// control chars from captured command output, so a widget's `| ` lines are plain, editor-safe
// text. Real content — including UTF-8 glyphs like ✓/✗ and an OSC link's visible label — survives;
// only the escapes and lone C0 controls (bar tab/newline) are removed.
export const stripAnsi = (s: string): string =>
	s
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC (hyperlinks, window titles): ESC ] … BEL|ST
		.replace(/\x1b[P^_X][^\x1b]*(?:\x1b\\)?/g, '') // DCS/PM/APC/SOS strings: ESC P|^|_|X … ST
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI (colors, cursor moves): ESC [ … final byte
		.replace(/\x1b[@-Z\\-_]/g, '') // any remaining single-char C1 escape
		.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '') // stray C0 controls / DEL (keep \t and \n)

// Run a widget's commands in `dir` (or the control dir if it doesn't exist yet), in order, and
// join their stdout into one output blob — falling back to stderr for a command that produced no
// stdout — with terminal escapes stripped so it renders as plain text. Best-effort: each command
// runs in `fish -c` (so the user's fish functions and abbreviations resolve) with a 15s cap, and a
// failing or hanging command degrades to a short `[error: …]` line rather than stalling the tick.
async function runWidget(def: Widget, args: string[], dir: string): Promise<string> {
	const cwd = existsSync(dir) ? dir : CONTROL_DIR
	const clean = (x: string) => stripAnsi(x).replace(/^\n+/, '').replace(/\s+$/, '')
	const parts: string[] = []
	for (const cmd of def.commands) {
		const filled = fillArgs(cmd, args)
		try {
			const r = await $({ cwd, nothrow: true, quiet: true, timeout: '15s' })`fish -c ${filled}`
			const out = clean(r.stdout ?? '') || clean(r.stderr ?? '')
			if (out !== '') parts.push(out)
		} catch {
			parts.push(`[error: ${filled}]`)
		}
	}
	return parts.join('\n')
}

// Create lane `n`'s pane of `kind` as a new window, wired for completion reporting:
// DUCKIES_LABEL/DUCKIES_STATE (so a pane recreated on an env-less session still reports),
// DUCKIES_SHELL to mark a shell as the command-runner, and DUCKIES_PANE=n (n>1) so the hook
// suffixes its done-file. A claude pane also launches `claude` (the caller waits out the
// boot grace before dispatching to it). Returns the new pane id.
async function ensurePaneWindow(label: string, dir: string, kind: PaneKind, n: number, resumeId?: string): Promise<string> {
	const tm = $({ nothrow: true, quiet: true })
	const role = paneRole(kind, n)
	const env = ['-e', `DUCKIES_LABEL=${label}`, '-e', `DUCKIES_STATE=${STATE}`]
	if (kind === 'shell') env.push('-e', 'DUCKIES_SHELL=1')
	if (n > 1) env.push('-e', `DUCKIES_PANE=${n}`)
	const created = (await tm`tmux new-window -P -F ${'#{pane_id}'} -t ${T(label)} -n ${role} -c ${dir} ${env}`).stdout.trim()
	await tm`tmux set-option -p -t ${created} @duckies ${role}`
	if (kind === 'claude') {
		await sleep(300)
		if (resumeId) log(`resuming ${T(label)}${n > 1 ? `:${n}` : ''} conversation ${resumeId}`)
		await typeInto(created, launchCmd(resumeId))
	}
	return created
}
// Lane 1's shell window (the original free shell); kept as a thin alias for the callers
// (doSpawn / repairShell) that only ever touch lane 1.
const makeShellWindow = (label: string, dir: string) => ensurePaneWindow(label, dir, 'shell', 1)

// The @duckies roles present on a session's panes (e.g. {claude, shell}). A complete
// session has both; anything missing means a tmux step during spawn silently failed.
async function taggedRoles(label: string): Promise<Set<string>> {
	const r = await $({ nothrow: true, quiet: true })`tmux list-panes -s -t ${T(label)} -F ${'#{@duckies}'}`
	return new Set(r.stdout.split('\n').map((x) => x.trim()).filter(Boolean))
}

async function doSpawn(label: string, dir: string, resumeId?: string) {
	log(`spawning ${T(label)} in ${dir}`)
	if (DRY) return
	const tm = $({ nothrow: true, quiet: true })
	// Every session opens with the duckies view as window 0 (so it sorts first and an attach
	// lands on it): a live, editable, cross-file-merged view of this label's `.dk` blocks. A
	// worktree label has no column-0 header of its own, so its view is compiled with the parent
	// repo header as context (see tui.ts viewParts) — the pane still just runs `--session <label>`.
	await tm`tmux new-session -d -s ${T(label)} -n duckies -c ${CONTROL_DIR}`
	const viewPane = (await tm`tmux list-panes -t ${T(label)} -F ${'#{pane_id}'}`).stdout.split('\n')[0]?.trim() || T(label)
	await tm`tmux set-option -p -t ${viewPane} @duckies view`
	await sleep(300)
	await typeInto(viewPane, viewCmd(label))
	// claude + shell as their own tagged windows; ensurePaneWindow sets DUCKIES_LABEL/STATE
	// per-window, so no session-level env is needed (and none leaks to ad-hoc windows).
	await ensurePaneWindow(label, dir, 'claude', 1, resumeId)
	await makeShellWindow(label, dir)
	// Focus the view window so attaching/revealing the session lands on it first.
	await tm`tmux select-window -t ${viewPane}`
	// The tmux steps above run with nothrow; a partial spawn leaves a half-formed
	// session that blocks command dispatch. Warn loudly (the readiness gate repairs it).
	const roles = await taggedRoles(label)
	if (!roles.has('claude') || !roles.has('shell')) log(`WARN incomplete spawn of ${T(label)} (tagged: ${[...roles].join(',') || 'none'})`)
}

// Create a detached-HEAD git worktree of `base` at `dir` (its parent dirs made first), then
// run the base repo's worktree setup — copy files/dirs in from `base` (`worktree/copy`, e.g.
// a gitignored `.env`), spawn the session in it, then type its commands (`worktree/cmd`, e.g.
// install) into the session's own tmux shell so they run in the real pane (visible, with the
// pane's full env) rather than in the supervisor process. Runs once, the first tick a worktree
// session has work; the readiness grace holds queued `$commands` off until the shell is idle,
// so any queued command lands after the setup it depends on.
async function addWorktreeAndSpawn(label: string, base: string, dir: string, cfg: { cmd?: string[]; copy?: string[] } = {}, resumeId?: string) {
	log(`worktree add ${dir} (from ${base})`)
	if (DRY) return
	// A background removal for this same base (a just-reaped worktree) may still hold the repo's
	// worktree lock; `git worktree add` would fail against it. Wait out the base's removal chain —
	// rare, only on a delete + re-add in quick succession.
	const pending = pendingWorktreeRemoval(base)
	if (pending) {
		log(`worktree add ${dir}: waiting on a background removal in ${base}`)
		await pending
	}
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
	// Spawn the session first so its shell window exists, then type each setup command into that
	// shell (via sendCmd, the same path `$command` items use). They run in the real pane — the
	// user sees them, and they get the pane's login/interactive env (PATH, asdf/nvm/direnv) — and
	// the shell reads them in order, so a queued `$command` (held off by the boot grace) follows.
	await doSpawn(label, dir, resumeId)
	const cmds = cfg.cmd ?? []
	if (cmds.length) await sleep(500) // let the fresh shell finish sourcing its rc before typing
	for (const cmd of cmds) {
		log(`worktree ${T(label)}: setup ${JSON.stringify(cmd)}`)
		await sendCmd(label, cmd, 1)
	}
}

// A labeled base that isn't a git repo can't be worktree'd, so instead point the same
// `<base>-worktrees/<name>` path straight at the base with a symlink: the session runs in a
// dir that *is* the base, so its commands modify the original files (no isolation — worktree
// setup copy/cmd is skipped, there being no separate tree to seed). Torn down like a real
// worktree, except removeWorktree just unlinks the symlink.
async function linkDirAndSpawn(label: string, base: string, dir: string, resumeId?: string) {
	log(`symlink ${dir} -> ${base}`)
	if (DRY) return
	await $({ nothrow: true, quiet: true })`mkdir -p ${dirname(dir)}`
	try {
		symlinkSync(base, dir)
	} catch (e) {
		log(`WARN symlink failed for ${T(label)}: ${(e as Error).message}`)
		return
	}
	await doSpawn(label, dir, resumeId)
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

// `git worktree remove` scans the whole tree, so it never runs inline in a tick's action pass —
// the reap schedules it here and the tick moves on. Jobs run detached from the tick, SERIALIZED
// PER BASE REPO (git locks its worktrees admin dir, so two removes in one repo — or a remove
// racing an add — would fail on the lock) but in parallel across different bases. A supervisor
// restart orphans the git child; it finishes on its own.
const worktreeRemoving = new Set<string>() // dirs with a removal queued or running (dedup guard)
const removalQueues = new Map<string, Promise<unknown>>() // base → tail of its removal chain

// Schedule `job` after anything already queued for `base`, without awaiting it. Returns the chain
// tail so tests can observe completion; the tick ignores it (fire-and-forget). Exported for tests.
export function backgroundWorktreeJob(base: string, dir: string, job: () => Promise<unknown>): Promise<unknown> {
	if (DRY) return Promise.resolve()
	if (worktreeRemoving.has(dir)) return removalQueues.get(base) ?? Promise.resolve()
	worktreeRemoving.add(dir)
	const tail = removalQueues.get(base) ?? Promise.resolve()
	const next = tail
		.then(() => job())
		.catch(() => {}) // removeWorktree already logs its failures; never wedge the base's queue
		.finally(() => worktreeRemoving.delete(dir))
	removalQueues.set(base, next)
	// Drop a fully drained chain so the map doesn't grow an entry per repo forever. Only when this
	// tail is still the latest (a newer job would have replaced it), and only after its job ran —
	// so a later job that chained off this tail keeps its ordering either way.
	void next.finally(() => {
		if (removalQueues.get(base) === next) removalQueues.delete(base)
	})
	return next
}

// The tail of a base's removal chain, if a background removal is pending for it. addWorktreeAndSpawn
// awaits this before `git worktree add` so a delete+re-add in quick succession can't race the lock.
export const pendingWorktreeRemoval = (base: string): Promise<unknown> | undefined => removalQueues.get(base)

// Recreate lane `n`'s shell window so command completion is reported again. Two cases:
// a partial/absent pane, or a tmux-resurrect restore that brought the shell back stripped
// of its DUCKIES_SHELL/DUCKIES_PANE env and @duckies tag (see taggedPane). In the restore
// case a stale, untagged shell pane exists — kill its window first so we don't leave a
// duplicate — then create a fresh, tagged one. Leaves the lane-1 claude window focused.
async function repairShell(label: string, dir: string, n = 1) {
	if (DRY) return
	const tm = $({ nothrow: true, quiet: true })
	const stale = await shellPane(label, n)
	log(`repairing ${T(label)} shell${n > 1 ? n : ''}: ${stale ? 'recreating restored window (restoring DUCKIES_SHELL)' : 'recreating missing window'}`)
	if (stale) await tm`tmux kill-window -t ${stale}`
	await ensurePaneWindow(label, dir, 'shell', n)
	await tm`tmux select-window -t ${await claudePane(label)}`
}

// Recreate lane `n`'s claude window so its Stop/Notification hook reports again — the claude
// counterpart of repairShell. A tmux-resurrect restore brings the pane back as a bare shell
// stripped of DUCKIES_LABEL/DUCKIES_PANE and the @duckies tag (see taggedPane), so the hook
// no-ops and the frontier prompt latches at [EXECUTING] forever with no Stop to advance it.
// Re-tagging can't help — the restored process never inherited the env — so we kill the
// stale window (its claude is already gone) and spawn a fresh, tagged one that relaunches
// claude. The caller gates on the pane being idle, so a still-working (merely mis-tagged)
// claude is never killed mid-turn. Leaves the new claude window focused.
async function repairClaude(label: string, dir: string, n = 1, resumeId?: string) {
	if (DRY) return
	const tm = $({ nothrow: true, quiet: true })
	const stale = await paneFor(label, 'claude', n)
	log(`repairing ${T(label)} claude${n > 1 ? n : ''}: ${stale ? 'recreating restored window (restoring DUCKIES_LABEL)' : 'recreating missing window'}`)
	if (stale) await tm`tmux kill-window -t ${stale}`
	const created = await ensurePaneWindow(label, dir, 'claude', n, resumeId)
	await tm`tmux select-window -t ${created}`
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

// Tear down one numbered lane (n>1) whose lines were deleted from the file: kill its
// `claude<n>`/`shell<n>` windows and drop its state, leaving the rest of the session alive.
// The session itself (lane 1) is only removed by deleting its header (doKill).
async function reapLane(label: string, n: number, re: RtEntry) {
	log(`reaping ${T(label)} lane ${n}`)
	if (!DRY) {
		const tm = $({ nothrow: true, quiet: true })
		for (const kind of ['claude', 'shell'] as PaneKind[]) {
			const pane = await paneFor(label, kind, n)
			if (pane) await tm`tmux kill-window -t ${pane}`
		}
	}
	rmLaneFiles(label, n)
	delete re.lanes[n]
}

// Bring this session on screen by switching the terminal you're watching to it. With
// several terminals attached (each a separate tmux client), we can't know which one your
// eyes are on, so we switch the most-recently-active client — the one you last interacted
// with. Only clients parked on a controller-managed (`__*`) session are eligible, so a
// reveal never yanks a terminal you've parked on your own unrelated (non-`__`) work.
// Run outside tmux there is no "current" client, so we target it by name.
async function showSession(label: string, window?: Window, explicitPane?: string) {
	log(`showing ${T(label)}${window ? ` (${paneRole(window.kind, window.n)})` : ''}`)
	if (DRY) return
	const tm = $({ nothrow: true, quiet: true })
	// Bring the configured terminal (the one watching these sessions) to the foreground, so a
	// `show`/`!` actually surfaces it even when another app is focused. macOS + opt-in only.
	if (process.platform === 'darwin' && TERM_APP) await tm`osascript -e ${`tell application "${TERM_APP}" to activate`}`
	// Reveal a specific window before switching the client: an explicit pane id (a DUCKIES agent
	// window), or the lane/kind the caller named (the shell for a `$command` show, a numbered lane's
	// pane), so the switch lands on it rather than the session's last-active window.
	const pane = explicitPane ?? (window ? await paneFor(label, window.kind, window.n) : null)
	if (pane) await tm`tmux select-window -t ${pane}`
	const r = await tm`tmux list-clients -F ${'#{client_name}\t#{client_session}\t#{client_activity}'}`
	const clients = r.stdout
		.split('\n')
		.map((line) => line.split('\t'))
		.filter(([client]) => client)
	// With a single attached client there's no ambiguity about which terminal is
	// watching, so switch it even if it's parked on one of your own non-`__` sessions.
	if (clients.length === 1) {
		await tm`tmux switch-client -c ${clients[0][0]} -t ${T(label)}`
		return
	}
	// Several terminals attached: switch the most-recently-active one parked on a `__*`
	// session — the terminal you last touched — so the reveal lands where you're looking.
	const watching = clients.filter(([, session]) => session?.startsWith(PREFIX)).sort(([, , a], [, , b]) => Number(b) - Number(a))
	if (watching.length) await tm`tmux switch-client -c ${watching[0][0]} -t ${T(label)}`
}

// ---------------------------------------------------------- DUCKIES agent windows
// A DUCKIES directive runs a real `claude` in its own window inside the dedicated `__duckies-agent`
// session, tagged `@duckies <key>`. Its claude reports completion through the same Stop hook as a
// lane (DUCKIES_PANE=`duckies.<key>` → state/<label>.dk.<key>.json), so we read the `-> ` summary
// from its transcript exactly like a finished prompt.

// The agent window's pane for `key`, matched by its `@duckies <key>` tag. Null if absent.
async function duckiesAgentPane(key: string): Promise<string | null> {
	const r = await $({ nothrow: true, quiet: true })`tmux list-panes -s -t ${T(AGENT_SESSION_LABEL)} -F ${'#{pane_id}\t#{@duckies}'}`
	for (const line of r.stdout.split('\n')) {
		const [id, tag] = line.split('\t')
		if (id && tag === key) return id
	}
	return null
}
// Create the agent window for `item` and launch `claude` in it: cwd = the agent dir (its CLAUDE.md),
// the control dir added so it can edit the files, and a permission mode that needs no prompts. The
// directive itself is typed in later (sendDuckiesDirective), once claude has booted. The dedicated
// `__duckies-agent` session is created on first use; the window is named for the target label.
async function spawnDuckiesAgent(item: DuckiesItem, key: string) {
	log(`duckies agent ${T(item.label)}: launch ${JSON.stringify(item.directive)}`)
	if (DRY) return
	const tm = $({ nothrow: true, quiet: true })
	const cwd = existsSync(AGENT_DIR) ? AGENT_DIR : CONTROL_DIR
	// DUCKIES_PANE=`duckies.<key>` routes the agent's Stop hook to state/<label>.dk.<key>.json.
	const env = ['-e', `DUCKIES_LABEL=${item.label}`, '-e', `DUCKIES_STATE=${STATE}`, '-e', `DUCKIES_PANE=duckies.${key}`]
	const has = (await tm`tmux has-session -t ${T(AGENT_SESSION_LABEL)}`).exitCode === 0
	const pane = has
		? (await tm`tmux new-window -P -F ${'#{pane_id}'} -t ${T(AGENT_SESSION_LABEL)} -n ${item.label} -c ${cwd} ${env}`).stdout.trim()
		: (await tm`tmux new-session -d -s ${T(AGENT_SESSION_LABEL)} -n ${item.label} -c ${cwd} ${env} -P -F ${'#{pane_id}'}`).stdout.trim()
	await tm`tmux set-option -p -t ${pane} @duckies ${key}`
	let cmd = `${AGENT_CMD} --permission-mode ${DUCKIES_AGENT_PERM} --add-dir '${CONTROL_DIR}' --append-system-prompt-file '${buildSystemPromptFile()}'`
	if (DUCKIES_AGENT_MODEL) cmd += ` --model ${DUCKIES_AGENT_MODEL}`
	await sleep(300)
	await typeInto(pane, cmd)
}
// Type the directive prompt into the (booted) agent pane, like any duckies prompt (vim-insert +
// bracketed paste for the multiline block). No-op if the window is gone.
async function sendDuckiesDirective(item: DuckiesItem, key: string, filePath: string) {
	log(`duckies agent ${T(item.label)}: prompt`)
	if (DRY) return
	const pane = await duckiesAgentPane(key)
	if (pane) await typeInto(pane, duckiesPrompt(item, filePath), true)
}
// Whether the agent's pane is mid-turn (same spinner read as a lane); false if the window is gone.
async function duckiesAgentBusy(key: string): Promise<boolean> {
	if (DRY) return false
	const pane = await duckiesAgentPane(key)
	if (!pane) return false
	const r = await $({ nothrow: true, quiet: true })`tmux capture-pane -p -t ${pane}`
	return r.exitCode === 0 && paneWorking(r.stdout)
}
// Tear down a finished/cancelled agent: kill its window (the `__duckies-agent` session dies with its
// last window) and drop its state files.
async function teardownDuckiesAgent(label: string, key: string) {
	rmDuckiesFiles(label, key)
	if (DRY) return
	const pane = await duckiesAgentPane(key)
	if (pane) await $({ nothrow: true, quiet: true })`tmux kill-window -t ${pane}`
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

// Every `*.dk` file in the control dir, sorted for a stable merge order. In
// single-file mode (DUCKIES_FILE) it's just that one file, if it exists.
export function controlFiles(): string[] {
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

// Find an already-defined session for a typed menu label, resolving it through aliases the same
// way a header line would. Scans every control file so a duplicate is caught wherever it lives.
// Returns the file + 1-based header line + resolved label, or null when the label is new.
export function locateLabel(header: string): { file: string; line: number; label: string } | null {
	const aliases = loadAliases()
	const macros = loadMacros()
	const widgets = loadWidgets()
	const { label } = resolveTarget(header.trim().replace(/^[!?]\s*/, ''), aliases)
	for (const file of controlFiles()) {
		let sessions
		try {
			sessions = parse(readFileSync(file, 'utf8'), aliases, macros, widgets).sessions
		} catch {
			continue
		}
		const s = sessions.find((x) => x.label === label)
		if (s) return { file, line: s.headerIdx + 1, label }
	}
	return null
}

// Watch the control dir (not each file — a directory watch survives atomicWrite's temp-file
// rename, which swaps the inode a per-file watch would lose) and invoke `onChange` whenever a
// `.dk` file is touched. Lets the poll loop react to a save — e.g. a `!` reveal — within
// WATCH_MS instead of up to TICK_MS. Best-effort: if the watch can't be set up, the poll still
// covers every change, just at TICK_MS granularity.
function watchControls(onChange: () => void): void {
	const dir = SINGLE_FILE ? dirname(SINGLE_FILE) : CONTROL_DIR
	const only = SINGLE_FILE ? basename(SINGLE_FILE) : null
	try {
		watch(dir, (_event, filename) => {
			if (!filename) return onChange() // some platforms omit the name; assume relevant
			const name = filename.toString()
			if (only ? name === only : name.endsWith(CONTROL_EXT)) onChange()
		})
	} catch {
		// ignore — polling still handles it
	}
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
// The window a macro item is (or was last) actioning: the pane of the step its cursor sits on
// while [EXECUTING], or its last step once [DONE] (the cursor resets to 0 on finish, so it can't
// be read back). A non-macro (or a step-less macro) just uses its own window. Lets a `!` reveal
// land on the shell when the macro's current `$` step is what ran, not always the claude pane.
const macroWindow = (p: Prompt, macroStep: number | undefined): Window => {
	if (!p.isMacro || !p.steps?.length) return windowOf(p)
	const idx = p.desiredKind === 'DONE' ? p.steps.length - 1 : Math.min(macroStep ?? 0, p.steps.length - 1)
	return { kind: p.steps[idx].isCmd ? 'shell' : 'claude', n: p.pane }
}
export interface Dispatch {
	type: DispatchType
	text?: string
	// For a `show`: the window the last task before it used, so the reveal lands on
	// that window (the shell for a `$command`, the claude pane for a prompt).
	window?: Window
}
export interface PlanIO {
	now: number
	state: { event: string; notify?: string; mtimeMs: number } | null
	cmdDoneMtime: number | null
	// Exit status of the just-finished `$command` (see readCmdExit). Non-zero ⇒ the command
	// failed: mark it [ERROR] and halt the lane instead of draining on. Null/0 ⇒ treat as success.
	cmdDoneExit?: number | null
	// Live busy state of the lane's claude pane (its active-turn "esc to interrupt" hint):
	// true = working, false = idle at the prompt, undefined = unknown/unread (tests, or a
	// `$`-only lane). Authoritative over stale hook events — a session that resumes on its
	// own (background task / loop / task-notification) fires no hook, so without this the
	// prior turn's Stop latches it to [DONE] while it's actually still running.
	paneBusy?: boolean
	// Whether the pane has backgrounded shells/tasks still running (the TUI's `· <n> shells`
	// segment). When a turn ends idle but this holds, the item is [WAITING], not [DONE]: a
	// `<task-notification>` will resume claude with no hook, so the lane stays held (no dispatch)
	// until the background work finishes. undefined = unknown/unread.
	paneBackground?: boolean
	// Jev's verdict for this turn (JEV_ATTENTION only): the finished turn's final assistant message
	// reads as "waiting on the human". A turn end then latches [NEEDS ATTENTION] (held, not drained)
	// instead of [DONE]. Computed once per turn by the caller and reused across the lingering-Stop
	// ticks; undefined/false ⇒ the ordinary [DONE].
	needsAttention?: boolean
}

// Nearest pending item above `idx` in drain order (the next to run, drain being
// bottom-to-top). Ordering is by `order`, not `lineIdx`, so a merged label's rows drain
// as one cross-file queue.
const nearestAbove = (s: Session, idx: number): Prompt | null => {
	// An errored `$command` halts the drain like a `#` barrier: nothing above it (lower order,
	// i.e. queued later) runs until the [ERROR] line is cleared. errFloor is the highest-order
	// error at or below idx; candidates must sit below it (higher order) to still be eligible.
	// `<= idx` (not `<`) so an error sitting exactly at the frontier still walls off the items
	// above it — otherwise, once the drain starts at the error line, its followers would run.
	const errFloor = Math.max(-Infinity, ...s.prompts.filter((p) => p.desiredKind === 'ERROR' && p.order <= idx).map((p) => p.order))
	const cands = s.prompts.filter((p) => p.order < idx && p.order > errFloor && p.desiredKind === null)
	return cands.length ? cands.reduce((a, b) => (b.order > a.order ? b : a)) : null
}

// The bottom-to-top frontier: the top-most already-run item, or the queue bottom on
// a fresh queue. Shared by planQueue's fresh-dispatch branch and the spawn gate. An
// [ERROR] item counts as already-run: the drain must resume from the error line (halting
// there), not fall back to the queue bottom and re-dispatch items that already completed.
const frontierIdx = (s: Session): number => {
	const done = s.prompts.filter((p) => p.desiredKind === 'DONE' || p.desiredKind === 'ERROR')
	return done.length ? Math.min(...done.map((p) => p.order)) : Number.POSITIVE_INFINITY
}

// Whether a session has a pending item the next tick would dispatch. A bare header
// (no prompts/commands), a fully drained one, or one blocked on a `#` barrier has nothing
// to input, so we don't spawn a tmux session for it — we only spawn once there's work.
export const hasPendingInput = (s: Session): boolean => {
	if (s.prompts.some((p) => p.desiredKind === 'EXECUTING' || p.desiredKind === 'ATTENTION' || p.desiredKind === 'WAITING')) return true
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
export const frontierWindow = (s: Session, lanes?: Record<number, { macroStep?: number }>): Window | undefined => {
	const active = s.prompts.find((p) => p.desiredKind === 'EXECUTING' || p.desiredKind === 'ATTENTION' || p.desiredKind === 'WAITING')
	const done = s.prompts.filter((p) => p.desiredKind === 'DONE').sort((a, b) => a.order - b.order)[0]
	const item = active ?? done
	return item ? macroWindow(item, lanes?.[item.pane]?.macroStep) : undefined
}

// The distinct lanes (pane numbers) present in a session, ascending. Each is planned
// independently and runs concurrently with the others.
export const lanesOf = (s: Session): number[] => [...new Set(s.prompts.map((p) => p.pane))].sort((a, b) => a - b)
// A lane's own view: its items plus any global (`#`) barrier, so a bare comment halts every
// lane's drain — a `:2`/`:3` prompt is blocked by a `#` below it, not just a `#2`. planQueue on
// this mutates the shared Prompt objects but confines drain/frontier/keepOnly to the lane, so
// each lane keeps its own marker.
const laneView = (s: Session, n: number): Session => ({ ...s, prompts: s.prompts.filter((p) => p.pane === n || p.barrierGlobal) })
// A macro item needs a claude pane if any step is a prompt, a shell pane if any is a `$`.
const macroHasClaude = (p: Prompt) => !!p.isMacro && p.steps!.some((st) => !st.isCmd)
const macroHasShell = (p: Prompt) => !!p.isMacro && p.steps!.some((st) => st.isCmd)
// Whether an item feeds the claude pane: a plain prompt, or a macro with a prompt step.
const isClaudeItem = (p: Prompt) => (p.isMacro ? macroHasClaude(p) : !p.isCmd && !p.isBarrier && !p.isShow && !p.isClear)
const laneHasClaude = (s: Session, n: number) => s.prompts.some((p) => p.pane === n && isClaudeItem(p))
const laneHasShell = (s: Session, n: number) => s.prompts.some((p) => p.pane === n && (p.isMacro ? macroHasShell(p) : p.isCmd))
const lanePromptCount = (s: Session, n: number) => s.prompts.filter((p) => p.pane === n && isClaudeItem(p)).length

// Only the frontier item keeps a marker: strip every other [EXECUTING]/[DONE]/[WAITING].
const keepOnly = (s: Session, keep: Prompt | null) => {
	for (const p of s.prompts) {
		if (p === keep) continue
		if (p.desiredKind === 'EXECUTING' || p.desiredKind === 'DONE' || p.desiredKind === 'WAITING') p.desiredKind = null
	}
}

// Rewind a lane's in-flight prompt so the next planQueue re-dispatches it from scratch: drop
// its [EXECUTING]/[NEEDS ATTENTION] marker and zero the macro cursor + send timers. Used when
// a de-tagged claude pane is recreated — the killed pane's conversation died with the restore,
// so the frontier turn must run again. No-op (returns false) when nothing is in flight, so a
// first-time lane spawn isn't disturbed.
const resetLaneFrontier = (s: Session, n: number, lr: QueueRt): boolean => {
	const active = s.prompts.filter((p) => p.pane === n && (p.desiredKind === 'EXECUTING' || p.desiredKind === 'ATTENTION' || p.desiredKind === 'WAITING'))
	if (!active.length) return false
	for (const p of active) p.desiredKind = null
	lr.macroStep = 0
	lr.sentAt = 0
	lr.cmdSentAt = 0
	return true
}

// Decide the next transition for one (spawned, ready) session. Mutates the items'
// desiredKind and the runtime timers; returns the lines to send this tick. Pure
// w.r.t. I/O so it can be unit-tested by feeding synthetic events.
// Claude's `idle_prompt` notification ("waiting for your input") fires ~60s after the pane
// goes idle — i.e. *after* the turn's Stop. It carries no mid-task meaning, so it's treated
// as a turn-end signal, never as [NEEDS ATTENTION].
const isIdleNudge = (st: PlanIO['state']): boolean => !!st && st.event === 'Notification' && st.notify === 'idle_prompt'
// A genuine block needing a human (permission request, a non-idle notification): flag it.
const isBlockingNotify = (st: PlanIO['state'], sentAt: number): boolean => !!st && st.event === 'Notification' && st.notify !== 'idle_prompt' && st.mtimeMs > sentAt
// The turn ended: an explicit Stop, or the post-Stop idle nudge (which stands in when Stop was
// never observed — e.g. it was overwritten in the state file by the later idle notification).
const isTurnEnd = (st: PlanIO['state'], sentAt: number): boolean => !!st && (st.event === 'Stop' || isIdleNudge(st)) && st.mtimeMs > sentAt
// Claude is actively working again: a freshly submitted prompt (the human answered a blocking
// question) OR a tool call (the human approved a permission prompt — which fires no other hook, so
// a stale `permission_prompt` Notification would otherwise linger and re-latch [NEEDS ATTENTION]
// for the rest of the turn whenever the pane's spinner is unreadable, e.g. extended-thinking).
// Either supersedes a blocking notification and clears the lane back to [EXECUTING].
const isResume = (st: PlanIO['state'], sentAt: number): boolean =>
	!!st && (st.event === 'UserPromptSubmit' || st.event === 'PreToolUse') && st.mtimeMs > sentAt

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
	// Walk up the queue from `cursor` (bottom-to-top): fire and consume any `show` or `%`
	// items instantly (a `show` switches the tmux client; a `%` marks itself fired so buildOps
	// deletes the completed run below it), until we reach a real item to dispatch, a `#` barrier
	// (halt), or the top. `hold` (a just-finished item) keeps the frontier marker if nothing
	// dispatches.
	const drainUp = (cursor: number, hold: Prompt | null) => {
		for (;;) {
			const next = nearestAbove(s, cursor)
			if (next?.isShow) {
				out.push({ type: 'show', window: lastTaskWindow(s, next.order) })
				next.fired = true
				cursor = next.order
				continue
			}
			if (next?.isClear) {
				next.fired = true // buildOps deletes it and the lane's finished items below it
				cursor = next.order
				continue
			}
			if (next && !next.isBarrier) dispatch(next)
			else if (hold) keepOnly(s, hold) // drained or barrier ahead: hold the frontier
			return
		}
	}

	const active = s.prompts.find((p) => p.desiredKind === 'EXECUTING' || p.desiredKind === 'ATTENTION' || p.desiredKind === 'WAITING')
	// The top-most already-run item (the frontier), if any — resurrected below when the
	// pane is busy (or backgrounded) again but nothing is marked active.
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
				if (io.cmdDoneMtime !== null && io.cmdDoneMtime > (rt.cmdSentAt ?? 0)) {
					if (io.cmdDoneExit) {
						// A macro's `$` step failed: mark the whole macro item [ERROR] and halt.
						rt.macroStep = 0
						active.desiredKind = 'ERROR'
						keepOnly(s, active)
					} else advance()
				}
			} else if (step.text.trim() === '/clear') advance()
			else if (io.paneBusy === true) active.desiredKind = 'EXECUTING'
			else if (isBlockingNotify(io.state, rt.sentAt)) active.desiredKind = 'ATTENTION'
			else if (io.paneBackground === true) active.desiredKind = 'WAITING'
			else if (isTurnEnd(io.state, rt.sentAt)) advance()
			else if (isResume(io.state, rt.sentAt)) active.desiredKind = 'EXECUTING'
		} else if (active.isCmd) {
			if (io.cmdDoneMtime !== null && io.cmdDoneMtime > (rt.cmdSentAt ?? 0)) {
				if (io.cmdDoneExit) {
					// Non-zero exit: mark [ERROR] and hold the lane's frontier here — don't drain
					// past it. The lane stays blocked until the [ERROR] line is cleared/fixed.
					active.desiredKind = 'ERROR'
					keepOnly(s, active)
				} else {
					active.desiredKind = 'DONE'
					drainUp(active.order, active)
				}
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
		} else if (isBlockingNotify(io.state, rt.sentAt)) {
			// Claude is blocked waiting for input mid-task (a permission request or other non-idle
			// notification): flag this prompt. Takes priority over a backgrounded task — a human
			// must act before anything can resume. The benign idle_prompt nudge is NOT this: it
			// fires after the turn's Stop, so it flows into the turn-end branch below (→ [DONE]).
			active.desiredKind = 'ATTENTION'
		} else if (io.paneBackground === true) {
			// The turn ended (pane idle) but backgrounded tasks are still running — claude will
			// resume on its own via a <task-notification> that fires no hook. Hold at [WAITING]
			// rather than latching [DONE]: don't drain, don't dispatch into a pane about to wake.
			// Settles to [DONE] once the background work clears (the Stop branch below).
			active.desiredKind = 'WAITING'
		} else if (isTurnEnd(io.state, rt.sentAt)) {
			if (io.needsAttention || (active.desiredKind === 'ATTENTION' && isIdleNudge(io.state))) {
				// The turn ended cleanly, but Jev judged its final message as leaving the human
				// something to do (a question / follow-ups awaiting a go-ahead / a blocked ending).
				// Flag it and hold the lane — like a blocking Notification — rather than draining on;
				// answering in the pane (UserPromptSubmit, below) clears it back to [EXECUTING].
				//
				// The idle-nudge guard: Jev's verdict is latched on the turn's Stop mtime, but the
				// idle_prompt nudge fires ~60s later with a newer mtime, so by then the caller's
				// `needsAttention` has gone false (the latch no longer matches). Without this, that
				// nudge would silently downgrade an already-flagged [NEEDS ATTENTION] to [DONE]. The
				// nudge is a mere turn-end fallback carrying no verdict, so it must hold the flag —
				// only a fresh Stop (re-judged) or a human answer (UserPromptSubmit) may clear it.
				active.desiredKind = 'ATTENTION'
			} else {
				active.desiredKind = 'DONE'
				drainUp(active.order, active)
			}
		} else if (isResume(io.state, rt.sentAt)) {
			// Claude is working again — the human either submitted a prompt (answered a blocking
			// question) or approved a permission prompt (a PreToolUse fired as the tool ran). Either
			// clears [NEEDS ATTENTION] back to [EXECUTING]. Approving a permission prompt fires no
			// other hook, so without the PreToolUse signal the stale `permission_prompt` Notification
			// lingers and re-latches ATTENTION whenever the spinner is unreadable (extended-thinking).
			// (A no-op while already executing.)
			active.desiredKind = 'EXECUTING'
		}
	} else if (io.paneBusy === true && doneFrontier) {
		// Nothing is marked active, yet the pane is working again: the frontier item went
		// [DONE] on its Stop, then Claude resumed on its own (a background task / loop /
		// task-notification — none fire a hook). Re-reflect it as running, and dispatch
		// nothing into a busy pane. It settles back to [DONE] once the pane goes idle.
		doneFrontier.desiredKind = 'EXECUTING'
		keepOnly(s, doneFrontier)
	} else if (io.paneBackground === true && doneFrontier) {
		// Idle pane, but backgrounded tasks are still running under a frontier we'd marked
		// [DONE] (e.g. duckies restarted while a loop slept between resumes). Reflect the
		// pending self-resume as [WAITING] and hold — don't dispatch into a pane about to wake.
		doneFrontier.desiredKind = 'WAITING'
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

	// A `%` clear normally fires when the bottom-to-top drain reaches it (handled in drainUp).
	// But if the frontier has already advanced *above* it — e.g. the `%` was added under a run
	// that already finished — the drain, which only climbs, never revisits it and it sits inert
	// forever. Fire any such stranded clear here regardless of where the frontier sits: it's
	// eligible the moment nothing below it in the lane is still pending, running, errored, or
	// walled off by a barrier (any of which means the run below it hasn't actually completed).
	// The frontier here is the top-most *marked* item — including the live EXECUTING/ATTENTION/
	// WAITING markers, not just DONE/ERROR as frontierIdx counts: an item still executing above the
	// `%` means the drain has already climbed past it, so the runs below are stranded cruft too.
	const frontier = s.prompts.reduce((m, p) => (p.desiredKind != null && p.order < m ? p.order : m), Number.POSITIVE_INFINITY)
	for (const c of s.prompts) {
		if (!c.isClear || c.fired) continue
		// When a finished run sits *above* the `%` (frontier before it), the climbing drain will
		// never reach the items below it — so a pending, never-run one there can't ever complete;
		// it's dead cruft this `%` exists to sweep, not a reason to wait. Only when the drain has
		// yet to arrive (no run above the `%`) does a pending item below mean an unfinished run.
		const stranded = frontier < c.order
		const blockedBelow = s.prompts.some(
			(p) =>
				p.order > c.order &&
				(p.isBarrier || p.desiredKind === 'EXECUTING' || p.desiredKind === 'ATTENTION' || p.desiredKind === 'WAITING' || p.desiredKind === 'ERROR' || (!stranded && p.desiredKind === null && !p.isShow && !p.isClear)),
		)
		if (!blockedBelow) c.fired = true
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
	// Top-level (column-0) `DUCKIES:` directives in this file — not attached to any session.
	duckies: DuckiesItem[]
	mtime: number
}

async function tick(rt: Rt) {
	const live = await listTmux()
	const aliases = loadAliases()
	const macros = loadMacros()
	const widgets = loadWidgets()
	const templates = loadTemplates()
	// Read + parse every `.dk` file. Each file's sessions carry line indices into
	// that file's own `lines`, so markers are written back to the file they came from.
	const files = controlFiles()
	// No control files at all means "not configured yet", not "kill everything" — do
	// nothing rather than tearing down every live session over a missing/renamed file.
	// (An empty `.dk` file is the explicit way to drain all sessions.)
	if (files.length === 0) return
	// ---- template expansion pass: physically inject `>name args` calls into the files ----
	// Before anything else looks at the queue, rewrite any template call lines into their bodies
	// (see expandTemplates). This mutates the `.dk` file itself, so we write and return: the write
	// wakes the watcher and the next tick parses+drives the now-ordinary injected rows, exactly as
	// if the user had typed them. In dry-run atomicWrite only logs, so we fall through unchanged.
	if (!DRY) {
		let injected = false
		for (const path of files) {
			const content = readFileSync(path, 'utf8')
			const next = expandTemplates(content, templates)
			if (next === content) continue
			atomicWrite(path, next)
			injected = true
		}
		if (injected) return
	}
	const controls: Control[] = files.map((path) => {
		const mtime = safeMtime(path)
		// Macros expand IN MEMORY inside parse (the `@name` line stays in the file); only the
		// single overall marker is ever written back.
		const content = readFileSync(path, 'utf8')
		const { lines, sessions, duckies } = parse(content, aliases, macros, widgets)
		return { path, content, lines, sessions, duckies, mtime }
	})
	// Merge into one global session list; the first file (alphabetical) to claim a
	// tmux label wins, later duplicates are skipped so only one driver owns each session.
	const { sessions, labels: modelLabels } = mergeSessions(controls.map((c) => c.sessions))
	const actions: (() => Promise<void>)[] = []

	// ---- reveal pass: fire `!` "show now" requests up front ----
	// A reveal just switches the tmux client to an item's pane — it needs no queue or pane-busy
	// state — but the main session loop below awaits a `claudeBusy` (tmux capture-pane) per live
	// lane before its own reveal action would run, so with several sessions a saved `!` could lag
	// behind that whole serial sweep. Firing it here lands the reveal within the watch debounce
	// instead. Only live sessions (the pane must exist); a `!` on a not-yet-spawned session still
	// spawns via the main loop and reveals once it's up. `showNowFired` is set so buildOps strips
	// the `!` at write time, consuming the request.
	if (!DRY)
		for (const s of sessions) {
			if (RESERVED.has(s.label) || !live.has(s.label)) continue
			if (s.showNow && !s.showNowFired) {
				// No queued frontier (e.g. a freshly added `!label` with nothing under it yet) → land on
				// the session's claude window rather than whatever tmux left active.
				await showSession(s.label, frontierWindow(s, rt[s.label]?.lanes) ?? { kind: 'claude', n: 1 })
				s.showNowFired = true
			}
			for (const p of s.prompts) {
				if (!p.showNow || p.showNowFired) continue
				await showSession(s.label, macroWindow(p, rt[s.label]?.lanes?.[p.pane]?.macroStep))
				p.showNowFired = true
			}
		}

	// ---- capture pass: mirror manually-typed prompts/commands back into the files ----
	// Read each live session's per-lane capture logs, drop duckies's own sends, and stage the
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
	// Split a lane's raw captured lines into the ones duckies sent (matched-and-removed from the
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
				const items = dropDuringAttention(s, n, [...p.manual.map((t) => ({ text: t, isCmd: false })), ...c.manual.map((t) => ({ text: t, isCmd: true }))])
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

	// A session that stays in the control file (and is live) is a safe place to park a client
	// before we kill the session it's watching (sleep teardown and reaping both use it).
	const survivor = [...live].find((label) => modelLabels.has(label) || RESERVED.has(label)) ?? null
	for (const s of sessions) {
		const label = s.label
		if (RESERVED.has(label)) continue
		const dir = s.dir
		if (s.sleep) {
			// `?`-prefixed scope (sleep): keep it torn down but remember it's `parked` and keep both
			// its tracked conversation ids (rt[label].conv) and its state files, so removing the `?`
			// later wakes it and --resumes — even if its queue is fully drained. Kill the live tmux
			// session once; never respawn while asleep. A worktree's dir is left on disk, so a wake
			// reopens it in place. (State files are kept, not swept, so resumeIdFor's fallback works.)
			if (live.has(label)) actions.push(() => doKill(label, survivor))
			const e = (rt[label] ??= { starting: false, startedAt: 0, lanes: {} })
			e.parked = true
			continue
		}
		if (!existsSync(dir)) {
			// A worktree session's dir doesn't exist until we create it — and only once it has
			// work (like any spawn). A git base is worktree'd; a non-git base is symlinked so the
			// session works directly on its files (see linkDirAndSpawn).
			if (s.worktreeBase) {
				if (!hasPendingInput(s) && !s.showNow && !rt[label]?.parked) continue
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
				const conv = rt[label]?.conv // preserve tracked conversation ids across the reset
				rt[label] = { starting: true, startedAt: Date.now(), lanes: {}, worktreeDir: dir, worktreeBase: base, conv }
				const resumeId = resumeIdFor(rt, label, 1)
				if (existsSync(join(base, '.git'))) {
					const cfg = { cmd: s.worktreeCmd, copy: s.worktreeCopy }
					actions.push(() => addWorktreeAndSpawn(label, base, dir, cfg, resumeId))
				} else actions.push(() => linkDirAndSpawn(label, base, dir, resumeId))
				continue
			}
			s.desiredSession = `[NO DIR ${dir}]`
			continue
		}
		if (!live.has(label)) {
			// Only spawn once there's something to feed the session; a bare header
			// (or a fully drained one) gets no tmux session until work appears. A
			// pending `show`, or a `!` "show now" header, also counts — you can't
			// switch to a session that isn't there yet — so it spawns first. A `parked`
			// session (one just woken from `?` sleep) also respawns, even when drained,
			// so removing the `?` brings it back and --resumes its conversation.
			if (!hasPendingInput(s) && !s.showNow && !rt[label]?.parked) continue
			const conv = rt[label]?.conv // preserve tracked conversation ids across the reset
			rt[label] = { starting: true, startedAt: Date.now(), lanes: {}, conv }
			actions.push(() => doSpawn(label, dir, resumeIdFor(rt, label, 1)))
			continue
		}
		// `!` "show now" reveals (header and per-item) fired up front in the reveal pass, so
		// they land within the watch debounce rather than behind this loop's paneBusy sweep.
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

		// Reap lanes whose lines were deleted from the file: any numbered tmux lane (n>1) no
		// longer in the model gets its windows + state torn down, leaving the rest of the session
		// alive. Skip a lane with pending manual input (a `.in`/`.incmd` log this tick) — its new
		// `:n`/`$n` row isn't in the model until the next parse, so reaping now would kill a pane
		// the user just typed into and drop that input.
		if (!DRY)
			for (const n of lanesToReap(await liveLanes(label), lanesOf(s), captureFiles(label).map((c) => c.n)))
				actions.push(() => reapLane(label, n, re))

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
				// The lane's claude pane must be *tagged* to report turn completion. Absent ⇒ a
				// partial spawn (n>1; claude1 came with the session); untagged ⇒ a tmux-resurrect
				// restore stripped DUCKIES_LABEL/DUCKIES_PANE and the tag, so its Stop hook no-ops and
				// the frontier prompt hangs at [EXECUTING]. Recreate it (self-heal) before dispatching
				// — but never kill a claude that's mid-turn (a live pane that merely lost its tag):
				// wait it out. Only when the lane actually needs the pane (pending or stuck work), so
				// a drained session's idle pane isn't churned.
				if (laneHasClaude(s, n) && hasPendingInput(laneView(s, n)) && (await taggedPane(label, 'claude', n)) === null) {
					if ((await claudeBusy(label, n)) === true) continue // working; don't kill it mid-turn
					resetLaneFrontier(s, n, lr) // its prior turn died with the restore; run it again
					lr.starting = true
					lr.startedAt = Date.now()
					actions.push(() => repairClaude(label, dir, n, resumeIdFor(rt, label, n)))
					continue
				}
				if (lr.starting && Date.now() - lr.startedAt < READY_MS) continue // let claude<N> boot
				lr.starting = false
				// A `$N` lane isn't ready until it has a *tagged* shell<N> pane — the pane
				// whose per-shell hook reports completion. Missing ⇒ partial spawn; untagged ⇒
				// tmux-resurrect stripped DUCKIES_SHELL/DUCKIES_PANE (commands would hang at
				// [EXECUTING]). Either way recreate it (self-heal) before dispatching.
				if (laneHasShell(s, n) && (await taggedPane(label, 'shell', n)) === null) {
					actions.push(() => repairShell(label, dir, n))
					continue
				}
			}
			const cmdDoneMtime = readCmdDone(label, n)
			const cmdDoneExit = cmdDoneMtime !== null ? readCmdExit(label, n) : null
			// Poll the claude pane's live state once (lanes with prompts only; `$`-only lanes
			// have no claude pane). null (unreadable) ⇒ undefined so the planner falls back to
			// pure hook-driven behavior rather than acting on a bad read. `background` = the pane
			// has backgrounded tasks that will resume it (→ [WAITING], not [DONE]).
			const pane = !DRY && laneHasClaude(s, n) ? ((await readClaudePane(label, n)) ?? undefined) : undefined
			const paneBusy = pane?.busy
			const paneBackground = pane?.background
			const state = readState(label, n)
			// Track this lane's conversation id from whatever the latest hook reported, so a later
			// respawn can --resume it (and a `/resume` in the pane is followed automatically). Kept
			// even once the session is torn down-and-removed only until rt[label] is deleted.
			if (state?.sessionId) (re.conv ??= {})[n] = state.sessionId
			// A finished `:` prompt (fresh Stop, pane idle) gets a one-line `-> ` summary mirrored
			// below it. Capture it now — before planQueue advances the queue and dispatches any next
			// prompt at tick's end — so the transcript still reflects the turn that just ended. Same
			// freshness/paneBusy gate planQueue uses to latch [DONE]; the `!p.note` guard makes it
			// fire once (a lingering stale Stop is ignored after the line lands). Plain prompts only.
			// Not while backgrounded tasks still run: the turn is [WAITING], not finished, so
			// its `-> ` summary would be premature (it settles to [DONE] once they clear).
			if (!DRY && isTurnEnd(state, lr.sentAt) && paneBusy !== true && paneBackground !== true) {
				const done = s.prompts.find(
					(p) => p.pane === n && p.desiredKind === 'EXECUTING' && !p.isCmd && !p.isMacro && !p.isBarrier && !p.isShow && !p.note && p.text.trim() !== '/clear',
				)
				if (done) {
					// One transcript read serves both the `-> ` summary and the Jev attention
					// judgment. Jev runs at most once per turn: latched on this Stop's mtime, so the
					// lingering-Stop ticks that follow reuse the verdict (by then the item is [NEEDS
					// ATTENTION]/noted, so `done` no longer matches anyway).
					const text = readAssistantText(label, n)
					if (text !== null) {
						const summary = extractNote(text)
						if (summary) done.desiredNote = summary
						if (JEV_ATTENTION && lr.attnAt !== state!.mtimeMs) {
							const prob = await jevAttentionProb(text)
							lr.attention = prob !== null && prob >= JEV_THRESHOLD
							lr.attnAt = state!.mtimeMs
							if (prob !== null) log(`jev ${T(label)}${n > 1 ? `:${n}` : ''}: p=${prob.toFixed(2)} (≥${JEV_THRESHOLD}?) → ${lr.attention ? '[NEEDS ATTENTION]' : '[DONE]'}`)
						}
					}
				}
			}
			const needsAttention = JEV_ATTENTION && lr.attention === true && lr.attnAt === state?.mtimeMs
			const dispatches = planQueue(laneView(s, n), lr, { now: Date.now(), state, cmdDoneMtime, cmdDoneExit, paneBusy, paneBackground, needsAttention })
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

	for (const { label, worktree } of reapTargets(live, modelLabels, RESERVED, rt)) {
		actions.push(() => doKill(label, survivor))
		// If this was a worktree, remove it from disk too. The scheduling action still runs after
		// the kill (so the removal starts with the cwd freed), but the removal itself is slow
		// (`git worktree remove` scans the whole tree), so it runs DETACHED from this tick — queued
		// per base repo (see backgroundWorktreeJob) instead of blocking every session's tick.
		if (worktree) {
			const wt = worktree
			actions.push(async () => {
				void backgroundWorktreeJob(wt.base, wt.dir, () => removeWorktree(label, wt.base, wt.dir))
			})
		}
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

	// ---- duckies pass: drive a visible `claude` window for each `DUCKIES:` directive ----
	// A `DUCKIES:` directive runs a real claude in its own window in the `__duckies-agent` session.
	// Lifecycle (recorded per key in rt): spawn the window → after the boot grace, type the directive
	// → poll the agent's Stop hook → mirror its `-> ` summary below the directive (the durable
	// done-marker; delete it to re-run). The window is then KEPT ALIVE as a live conversation — you
	// can keep prompting it — and torn down only once it's sat idle (no Stop/prompt hook activity) for
	// DUCKIES_AGENT_IDLE_MS; a fresh prompt bumps the state-file mtime and so resets that timer. A
	// `!DUCKIES:` reveals the window once it's up. Spawn/prompt/reveal/teardown are queued as `actions`
	// so they run past the mid-tick defer; the note/marker flow through buildDuckiesOps (same defer).
	if (!DRY) {
		const now = Date.now()
		const seen = new Map<string, Map<string, number>>() // label → (directive → occurrence)
		const liveKeys = new Set<string>() // `label\0key` still present this tick (for cancel-teardown)
		for (const c of controls) {
			// Session-attached directives use their session's label; top-level (column-0) ones resolve
			// to the control-file basename (e.g. `app.dk` → `app`) so they still have an rt/state
			// namespace and an agent-window name.
			const fileLabel = basename(c.path, CONTROL_EXT)
			for (const item of [...c.sessions.flatMap((s) => s.duckies), ...c.duckies]) {
				{
					if (!item.label) item.label = fileLabel
					// Occurrence key is computed for EVERY directive (noted or not) so a directive keeps
					// the same key across the transition to "noted" — its lingering window's rt entry
					// still matches.
					const perLabel = seen.get(item.label) ?? new Map<string, number>()
					seen.set(item.label, perLabel)
					const occ = perLabel.get(item.directive) ?? 0
					perLabel.set(item.directive, occ + 1)
					const key = `${duckiesHash(item.directive)}-${occ}`
					const entry = rt[item.label]?.duckies?.[key]
					// Noted (done) AND no live window left ⇒ fully finished; nothing to do. (A noted
					// directive whose window still lingers falls through to the idle-teardown below.)
					if (!entry && item.note) continue
					liveKeys.add(`${item.label}\0${key}`)
					// All rt mutations live inside actions, which run only past the mid-tick defer — so a
					// deferred tick leaves rt untouched and the phase simply retries next tick (no double-
					// spawn, no phantom "sent"). Teardown deletes the record and kills the window together.
					const teardown = () => actions.push(async () => (await teardownDuckiesAgent(item.label, key), void delete rt[item.label]?.duckies?.[key]))
					if (!entry) {
						// First sighting: create the window + launch claude (rt set in the action, past the
						// defer). The directive is typed in a later tick, once claude has booted.
						item.desiredKind = 'EXECUTING'
						const e = (rt[item.label] ??= { starting: true, startedAt: 0, lanes: {} })
						e.duckies ??= {}
						actions.push(async () => (e.duckies![key] = { startedAt: Date.now(), sentAt: 0 }, void (await spawnDuckiesAgent(item, key))))
					} else if (entry.sentAt === 0) {
						// Window up, claude booting: type the directive once the boot grace has passed.
						item.desiredKind = 'EXECUTING'
						if (now - entry.startedAt >= READY_MS) actions.push(async () => ((entry.sentAt = Date.now()), void (await sendDuckiesDirective(item, key, c.path))))
					} else {
						// Directive sent. `lastActivity` is the agent's state-file mtime (bumped by every
						// Stop/prompt hook) — the inactivity clock; `pane`/`busy` read the live window.
						const st = readStateFile(duckiesFile(item.label, key, 'json'))
						const lastActivity = st?.mtimeMs ?? entry.startedAt
						const pane = await duckiesAgentPane(key)
						const busy = pane !== null && (await duckiesAgentBusy(key))
						const idleGone = pane === null || (now - lastActivity > DUCKIES_AGENT_IDLE_MS && !busy)
						if (!item.note) {
							item.desiredKind = 'EXECUTING'
							if (pane !== null && isTurnEnd(st, entry.sentAt) && !busy) {
								// First turn finished: mirror the `-> ` summary (fallback so it isn't re-run) and
								// drop the marker. The window is KEPT ALIVE — not torn down — so you can keep
								// prompting it; the idle check below reaps it once it's been quiet long enough.
								item.desiredNote = noteFromState(duckiesFile(item.label, key, 'json')) ?? 'duckies agent finished'
								item.desiredKind = null
							} else if (idleGone) {
								// Window closed, or went idle for the TTL before ever finishing → give up, recording
								// a note so the directive isn't relaunched (a stuck *busy* pane is left alone).
								item.desiredNote = pane === null ? 'duckies agent window closed' : 'duckies agent timed out'
								item.desiredKind = null
								teardown()
							}
						} else if (idleGone) {
							// Done (noted); its lingering window has closed or gone idle for the TTL → tear down.
							teardown()
						}
					}
					// A `!DUCKIES:` reveals the agent window once it exists; consumed (strip `!`) when revealed.
					if (item.showNow && !item.showNowFired) {
						const pane = await duckiesAgentPane(key)
						if (pane) {
							item.showNowFired = true
							actions.push(() => showSession(AGENT_SESSION_LABEL, undefined, pane))
						}
					}
				}
			}
		}
		// Cancel-teardown: a directive whose line was deleted while its agent ran is gone from the
		// model this tick — kill its orphaned window and drop its record (in the action, past the
		// defer, so a deferred tick retries rather than orphaning the window).
		for (const [label, e] of Object.entries(rt)) {
			for (const key of Object.keys(e.duckies ?? {})) {
				if (liveKeys.has(`${label}\0${key}`)) continue
				actions.push(async () => (await teardownDuckiesAgent(label, key), void delete e.duckies![key]))
			}
		}
	}

	// ---- widget pass: rerun each due `&name` widget and mirror its output back into the file ----
	// A widget is a live display, not a queue item: a live (`&&`) widget reruns its commands every
	// `interval` ms; a one-shot (`&`) widget runs once. Either way duckies rewrites the `| ` block
	// below the `&name` line. Runs happen concurrently and are gated per widget by
	// `rt[label].widgets[key].lastRun`; the resulting ops merge into the per-file rewrite
	// below (so they respect the same mid-tick defer, and an unchanged display writes nothing).
	const widgetOpsByPath = new Map<string, Op[]>()
	if (!DRY) {
		const now = Date.now()
		const seen = new Map<string, Map<string, number>>() // label → (widget name → occurrence), for a stable run key
		const due: { control: Control; item: WidgetItem; def: Widget; key: string; label: string; dir: string }[] = []
		const outputsByPath = new Map<string, Map<WidgetItem, string>>()
		for (const c of controls) {
			for (const s of c.sessions) {
				for (const w of s.widgets) {
					if (w.unknown) {
						// A `!&name` refresh-now on a name that matches no widget: report it inline
						// (`&name: no widget "name"`) — the rewrite also drops the `!`, consuming the
						// request without doing anything else.
						const m = outputsByPath.get(c.path) ?? new Map<WidgetItem, string>()
						m.set(w, `no widget "${w.name}"`)
						outputsByPath.set(c.path, m)
						continue
					}
					const def = widgets[w.name]
					if (!def) continue
					const perLabel = seen.get(s.label) ?? new Map<string, number>()
					seen.set(s.label, perLabel)
					const occ = perLabel.get(w.name) ?? 0
					perLabel.set(w.name, occ + 1)
					const key = `${w.name}#${occ}`
					const lastRun = rt[s.label]?.widgets?.[key]?.lastRun ?? 0
					// A leading `!` (`w.bang`) forces a single refresh now, whatever the gate says; the
					// rewrite regenerates the line from the clean `call`, so the `!` is consumed. Absent a
					// bang, a one-shot (`&`) runs a single time and never again; a live (`&&`) reruns once
					// its interval has elapsed. Both gates survive restarts via `lastRun` in controller.json.
					if (!w.bang && (w.once ? lastRun > 0 : now - lastRun < def.interval)) continue
					due.push({ control: c, item: w, def, key, label: s.label, dir: s.dir })
				}
			}
		}
		await Promise.all(
			due.map(async (d) => {
				const output = await runWidget(d.def, d.item.args, d.dir)
				const entry = (rt[d.label] ??= { starting: true, startedAt: 0, lanes: {} })
				;(entry.widgets ??= {})[d.key] = { lastRun: now }
				const m = outputsByPath.get(d.control.path) ?? new Map<WidgetItem, string>()
				m.set(d.item, output)
				outputsByPath.set(d.control.path, m)
			}),
		)
		for (const c of controls) {
			const m = outputsByPath.get(c.path)
			if (m) widgetOpsByPath.set(c.path, buildWidgetOps(c.sessions, c.lines, m))
		}
	}

	// If the user edited any `.dk` file while we computed, defer: skip writes AND
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
	// A drained-to-nothing label (its finished worktree, then its now-empty repo) has its whole
	// block deleted; the next tick reaps the vacated tmux session (and worktree) via reapTargets.
	// Queried after the reveal pass above, so a session we just switched the client to reads as
	// attached and is spared reaping (don't tear down what you're looking at).
	const attached = await attachedLabels()
	for (const c of controls) {
		const { tops, all } = vacatedSessions(c.sessions, live, attached)
		const ops = [...buildOps(c.sessions, all), ...buildDuckiesOps(c.duckies), ...vacateOps(tops, c.lines), ...(captureOps.get(c.path) ?? []), ...(widgetOpsByPath.get(c.path) ?? [])]
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
			for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => (dash?.teardown(), release(), process.exit(1)))
			return
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
			const owner = Number(readFileSync(LOCK, 'utf8').trim())
			if (owner && owner !== process.pid && pidAlive(owner)) {
				log(`another duckies supervisor is already running (pid ${owner}); refusing to start a second`)
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
			log(`duckies dry-run against ${found.length ? found.map((f) => basename(f)).join(', ') : `(no ${CONTROL_EXT} files found)`}`)
			await tick(rt)
			log('dry-run complete (no changes made)')
			return
		}
		acquireLock()
		// Interactive dashboard: colorized log + popup menu (press `m`). Only in a real TTY; skipped in
		// dry-run (returns above) and disabled with DUCKIES_TUI=0, so piped/headless runs log plainly.
		if (process.stdin.isTTY && process.env.DUCKIES_TUI !== '0') {
			dash = startDashboard({
				controlFiles,
				configFiles: { aliases: ALIASES_FILE, macros: MACROS_FILE, widgets: WIDGETS_FILE, templates: TEMPLATES_FILE },
				colorEnabled: !process.env.NO_COLOR,
				locateLabel,
				revealSession: (label) => void showSession(label),
			})
			process.on('exit', () => dash?.teardown())
		}
		log(`duckies watching ${SINGLE_FILE ?? `${CONTROL_DIR}/*${CONTROL_EXT}`} (${found.length} file(s))${dash ? ' · press m for menu' : ''}`)
		// Between ticks, sleep TICK_MS — but a `.dk` edit wakes us early (after a short
		// WATCH_MS debounce that folds an editor's write+rename into one tick), so a saved `!`
		// reveal reaches wezterm in tens of ms rather than up to a second. The poll remains the
		// backstop for state/hook files and tmux, and for platforms where the watch doesn't fire.
		let wake: (() => void) | null = null
		let dirtyBetweenTicks = false
		let debounce: ReturnType<typeof setTimeout> | null = null
		if (WATCH_MS > 0)
			watchControls(() => {
				if (debounce) return // already coalescing this burst
				debounce = setTimeout(() => {
					debounce = null
					if (wake) wake()
					else dirtyBetweenTicks = true // change landed mid-tick; the next wait resolves at once
				}, WATCH_MS)
			})
		while (true) {
			// A pending restart request (state/restart) is consumed here and the process exits with
			// RESTART_EXIT, which the `nr start` wrapper (duckies-run.ts) relaunches on — picking up any
			// edited source. tmux sessions are left running, so the fresh instance just reconciles them.
			if (existsSync(RESTART_FILE)) {
				try {
					unlinkSync(RESTART_FILE)
				} catch {}
				log('restart requested — exiting for the wrapper to relaunch on current source')
				dash?.teardown()
				process.exit(RESTART_EXIT)
			}
			await tick(rt)
			await new Promise<void>((resolve) => {
				if (dirtyBetweenTicks) {
					dirtyBetweenTicks = false
					return resolve()
				}
				const timer = setTimeout(done, TICK_MS)
				function done() {
					clearTimeout(timer)
					wake = null
					resolve()
				}
				wake = done
			})
		}
	})
