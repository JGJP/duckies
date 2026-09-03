#!/usr/bin/env tsx
import { aliasWorktree, applyOps, buildOps, frontierWindow, hasPendingInput, macroSteps, mergeSessions, parse, planCapture, planQueue, reapTargets, slashEcho } from './herald'
import { merge3, nearestIndex, toLines } from './tui'

let failures = 0
const check = (name: string, cond: boolean, detail?: string) => {
	console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  -> ${detail ?? ''}`}`)
	if (!cond) failures++
}

// A self-contained sessions-only layout (independent of the live herald file's
// current contents). The whole file is sessions now. Tabs are significant.
const example = [
	'superapp',
	'\tprompt: prompt that will automatically run after below is marked done',
	'\tprompt: please add feature X, commit the changes, push PR',
	'\t\t[EXECUTING]',
	'\tprompt: please start working on X',
	'\t\t[DONE]',
	'superapp-2',
	'\tprompt: investigate the flaky test',
	'\t\t[NEEDS ATTENTION]',
	'superapp-3',
	'\tprompt: /handle-pr-comments',
	'superapp-4',
	'superapp-reviews',
	'core-iac',
	'tmux',
	'fish',
	'',
].join('\n')

// 1. Round-trip: parsing then applying no-op ops must be byte-identical.
const { lines, sessions } = parse(example)
const roundTrip = applyOps(lines, buildOps(sessions)).join('\n')
check('round-trip byte-identical on example', roundTrip === example)

// 2. Structure of the example.
const labels = sessions.map((s) => s.label)
check(
	'parsed session labels',
	JSON.stringify(labels) ===
		JSON.stringify([
			'superapp',
			'superapp-2',
			'superapp-3',
			'superapp-4',
			'superapp-reviews',
			'core-iac',
			'tmux',
			'fish',
		]),
	JSON.stringify(labels),
)
const sa = sessions[0]
check('superapp has 3 prompts', sa.prompts.length === 3, `${sa.prompts.length}`)
check(
	'superapp markers bottom=DONE mid=EXECUTING top=none',
	sa.prompts[0].marker === null &&
		sa.prompts[1].marker?.kind === 'EXECUTING' &&
		sa.prompts[2].marker?.kind === 'DONE',
)
check(
	'superapp-2 attention is a per-prompt marker (not session-level)',
	sessions[1].prompts.length === 1 &&
		sessions[1].prompts[0].marker?.kind === 'ATTENTION' &&
		sessions[1].desiredSession === null,
)
check('superapp-3 has 1 prompt (/handle-pr-comments)', sessions[2].prompts.length === 1 && sessions[2].prompts[0].text === '/handle-pr-comments')

// 3. Marker mutation: set top prompt EXECUTING, mid DONE -> only those lines change.
const m = parse(example)
const s0 = m.sessions[0]
s0.prompts[2].desiredKind = 'DONE' // was DONE, no change
s0.prompts[1].desiredKind = 'DONE' // EXECUTING -> DONE
s0.prompts[0].desiredKind = 'EXECUTING' // none -> insert
const mutated = applyOps(m.lines, buildOps(m.sessions)).join('\n')
check(
	'top prompt gained [EXECUTING] and mid became [DONE]',
	mutated.includes('prompt that will automatically run after below is marked done\n\t\t[EXECUTING]') &&
		(mutated.match(/\[DONE\]/g) ?? []).length === 2 &&
		!mutated.includes('[EXECUTING]\n\tprompt: please start'),
)

// 4. Attention is a per-prompt marker: promoting it to [DONE] rewrites the
// prompt's own marker in place (no stray session-level line).
const m2 = parse(example)
m2.sessions[1].prompts[0].desiredKind = 'DONE'
const settled = applyOps(m2.lines, buildOps(m2.sessions)).join('\n')
check(
	'attention -> done rewrites the prompt marker in place',
	settled.includes('prompt: investigate the flaky test\n\t\t[DONE]') && !settled.includes('[NEEDS ATTENTION]'),
)

// 4b. Clearing the marker (desiredKind -> null) removes just that line.
const m2b = parse(example)
m2b.sessions[1].prompts[0].desiredKind = null
const cleared = applyOps(m2b.lines, buildOps(m2b.sessions)).join('\n')
check('clearing attention removes the marker line', !cleared.includes('[NEEDS ATTENTION]') && cleared.includes('prompt: investigate the flaky test\nsuperapp-3'))

// 4c. A `!` appended to a marker ("reveal this item's window now") parses as an
// ordinary marker plus a one-shot showNow request; unfired it round-trips verbatim,
// and once fired buildOps strips the `!` (leaving the plain marker).
const bangAttn = 'alpha\n\t: fix it\n\t\t[NEEDS ATTENTION]!\n'
const ba = parse(bangAttn)
check('marker `!` parses as its kind + a showNow request', ba.sessions[0].prompts[0].marker?.kind === 'ATTENTION' && ba.sessions[0].prompts[0].showNow === true)
check('an unfired marker `!` round-trips verbatim', applyOps(ba.lines, buildOps(ba.sessions)).join('\n') === bangAttn)
ba.sessions[0].prompts[0].showNowFired = true
check('a fired marker `!` is stripped to the plain marker', applyOps(ba.lines, buildOps(ba.sessions)).join('\n') === 'alpha\n\t: fix it\n\t\t[NEEDS ATTENTION]\n')
// A `!` on a `$command`'s [EXECUTING] marker targets the shell window; on a prompt, claude.
const baCmd = parse('alpha\n\t$ deploy\n\t\t[EXECUTING]!\n')
check('marker `!` on a command keeps the shell as its window', baCmd.sessions[0].prompts[0].isCmd === true && baCmd.sessions[0].prompts[0].showNow === true)

// 4d. A space-separated trailing `!` on the item's own line ("reveal this item's
// window now") sets a one-shot showNow without touching the item's text; unfired it
// round-trips verbatim, and once fired buildOps strips the ` !` from that line.
const inlineP = 'alpha\n\t: look at this !\n'
const ip = parse(inlineP)
check('inline `!` on a prompt sets showNow + strips it from the text', ip.sessions[0].prompts[0].showNow === true && ip.sessions[0].prompts[0].text === 'look at this' && ip.sessions[0].prompts[0].isCmd === false)
check('an unfired inline `!` round-trips verbatim', applyOps(ip.lines, buildOps(ip.sessions)).join('\n') === inlineP)
ip.sessions[0].prompts[0].showNowFired = true
check('a fired inline `!` is stripped from the item line', applyOps(ip.lines, buildOps(ip.sessions)).join('\n') === 'alpha\n\t: look at this\n')
// Firing coexists with a marker inserted the same tick (strip + insert on one line).
ip.sessions[0].prompts[0].desiredKind = 'EXECUTING'
check('a fired inline `!` strips and still gets its marker', applyOps(ip.lines, buildOps(ip.sessions)).join('\n') === 'alpha\n\t: look at this\n\t\t[EXECUTING]\n')
// On a `$command` the reveal targets the shell window, and the command text is clean.
const inlineC = parse('alpha\n\t$ gpo !\n')
check('inline `!` on a command sets showNow, targets shell, keeps clean text', inlineC.sessions[0].prompts[0].isCmd === true && inlineC.sessions[0].prompts[0].showNow === true && inlineC.sessions[0].prompts[0].text === 'gpo')
// Ordinary end punctuation (no separating space) stays text, not a reveal.
const punct = parse('alpha\n\t: ship it!\n')
check('a bare trailing `!` (no space) is text, not a reveal', punct.sessions[0].prompts[0].showNow === undefined && punct.sessions[0].prompts[0].text === 'ship it!')

// 5. Minimal file with a single session.
const single = 'alpha\n\tprompt: do a\n\tprompt: do b\n'
const nb = parse(single)
check('single-session file parses', nb.sessions.length === 1 && nb.sessions[0].prompts.length === 2)
check('single-session round-trips', applyOps(nb.lines, buildOps(nb.sessions)).join('\n') === single)

// 5b. `:` is shorthand for `prompt:` (and round-trips verbatim).
const shorthand = 'alpha\n\t: do a\n\tprompt: do b\n\t:do c\n'
const sh = parse(shorthand)
check(
	'`:` shorthand parses as prompts',
	sh.sessions[0].prompts.length === 3 &&
		sh.sessions[0].prompts.map((p) => p.text).join(',') === 'do a,do b,do c',
	JSON.stringify(sh.sessions[0].prompts.map((p) => p.text)),
)
check('`:` shorthand round-trips', applyOps(sh.lines, buildOps(sh.sessions)).join('\n') === shorthand)

// 5b'. Numbered/repeated sigils pick the lane (pane): `::`==`:2`, `:::`==`:3`, `$$`==`$2`.
// Digits win over the repeat count. The spec is stripped from the text; base `:`/`$` stay
// lane 1.
const panes = parse('alpha\n\t: base\n\t:: two\n\t:3 three\n\t::: also three\n\t$ c1\n\t$$ c2\n\t$3 c3\n')
const pp = panes.sessions[0].prompts
check(
	'sigil runs and digits select the lane, text stripped clean',
	JSON.stringify(pp.map((p) => [p.isCmd, p.pane, p.text])) ===
		JSON.stringify([
			[false, 1, 'base'],
			[false, 2, 'two'],
			[false, 3, 'three'],
			[false, 3, 'also three'],
			[true, 1, 'c1'],
			[true, 2, 'c2'],
			[true, 3, 'c3'],
		]),
	JSON.stringify(pp.map((p) => [p.isCmd, p.pane, p.text])),
)
check('numbered/repeated sigils round-trip verbatim', applyOps(panes.lines, buildOps(panes.sessions)).join('\n') === 'alpha\n\t: base\n\t:: two\n\t:3 three\n\t::: also three\n\t$ c1\n\t$$ c2\n\t$3 c3\n')
check('`prompt:` stays lane 1', parse('alpha\n\tprompt: x\n').sessions[0].prompts[0].pane === 1)

// Two lanes plan independently and run concurrently (mirrors tick()'s per-lane loop:
// planQueue on each lane's filtered view with its own rt + done-files). Both dispatch on
// the same tick; lane 2 then completes on its own Stop while lane 1 — given no Stop —
// stays [EXECUTING]. Neither blocks the other.
const twoLane = (() => {
	const { sessions } = parse('alpha\n\t: work one\n\t:2 work two\n')
	const s = sessions[0]
	const rt: Record<number, { sentAt: number; cmdSentAt: number; prevPromptCount: number }> = {
		1: { sentAt: 0, cmdSentAt: 0, prevPromptCount: 1 },
		2: { sentAt: 0, cmdSentAt: 0, prevPromptCount: 1 },
	}
	const plan = (n: number, io: Parameters<typeof planQueue>[2]) => planQueue({ ...s, prompts: s.prompts.filter((p) => p.pane === n) }, rt[n], io)
	const d1 = plan(1, { now: 100, state: null, cmdDoneMtime: null })
	const d2 = plan(2, { now: 100, state: null, cmdDoneMtime: null })
	plan(2, { now: 200, state: { event: 'Stop', mtimeMs: 200 }, cmdDoneMtime: null }) // lane 2's item finishes
	plan(1, { now: 200, state: null, cmdDoneMtime: null }) // lane 1 gets no Stop, still running
	const by = (t: string) => s.prompts.find((p) => p.text === t)!
	return { d1, d2, one: by('work one').desiredKind, two: by('work two').desiredKind }
})()
check(
	'two lanes plan independently and run concurrently',
	twoLane.d1.some((d) => d.type === 'prompt' && d.text === 'work one') &&
		twoLane.d2.some((d) => d.type === 'prompt' && d.text === 'work two') &&
		twoLane.one === 'EXECUTING' &&
		twoLane.two === 'DONE',
	JSON.stringify(twoLane),
)

// 5c. `$` command lines parse as one-shot commands (isCmd) separate from prompts.
const cmds = 'alpha\n\tprompt: do a\n\t$git status\n\t$pnpm test\n'
const cm = parse(cmds)
check(
	'`$` lines parse as commands, not prompts',
	cm.sessions[0].prompts.filter((p) => !p.isCmd).length === 1 &&
		cm.sessions[0].prompts.filter((p) => p.isCmd).map((p) => p.text).join(',') === 'git status,pnpm test',
	JSON.stringify(cm.sessions[0].prompts.map((p) => [p.isCmd, p.text])),
)
check('`$` command lines round-trip', applyOps(cm.lines, buildOps(cm.sessions)).join('\n') === cmds)
// A ran command carries a [DONE] marker attached to its own line.
const ran = parse('alpha\n\t$git status\n\t\t[DONE]\n')
check(
	'`$` command [DONE] marker attaches to the command',
	ran.sessions[0].prompts.length === 1 &&
		ran.sessions[0].prompts[0].isCmd &&
		ran.sessions[0].prompts[0].marker?.kind === 'DONE',
)
// An in-flight command carries an [EXECUTING] marker while it runs (gated on its
// done-file before advancing to [DONE]); it round-trips verbatim.
const running = 'alpha\n\t$sleep 5\n\t\t[EXECUTING]\n'
const rn = parse(running)
check(
	'`$` command [EXECUTING] marker attaches to the command',
	rn.sessions[0].prompts[0].isCmd && rn.sessions[0].prompts[0].marker?.kind === 'EXECUTING',
)
check('`$` executing command round-trips', applyOps(rn.lines, buildOps(rn.sessions)).join('\n') === running)

// 5d. planQueue: prompts and commands drain as ONE queue, bottom-to-top, one at a
// time. `drain` simulates ticks, completing whatever is active each tick (a prompt
// via a Stop event, a command via its done-file), round-tripping through the file
// (parse -> plan -> applyOps) exactly like the live loop, and records dispatch order.
const drain = (initial: string, maxTicks = 50) => {
	let content = initial
	const rt = { starting: false, startedAt: 0, sentAt: 0, cmdSentAt: 0, prevPromptCount: initial.match(/^\t(?:prompt:|:)/gm)?.length ?? 0 }
	let clock = 1000
	const order: string[] = []
	const markerCounts: number[] = []
	for (let i = 0; i < maxTicks; i++) {
		clock += 100
		const { lines, sessions } = parse(content)
		const s = sessions[0]
		const active = s.prompts.find((p) => p.desiredKind === 'EXECUTING' || p.desiredKind === 'ATTENTION')
		const io = {
			now: clock,
			state: active && !active.isCmd ? { event: 'Stop', mtimeMs: clock } : null,
			cmdDoneMtime: active?.isCmd ? clock : null,
		}
		const disp = planQueue(s, rt, io)
		for (const d of disp) order.push(d.type === 'clear' || d.type === 'show' ? d.type : `${d.type}:${d.text}`)
		content = applyOps(lines, buildOps(sessions)).join('\n')
		markerCounts.push((content.match(/\[(EXECUTING|DONE|NEEDS ATTENTION)\]/g) ?? []).length)
		if (!active && disp.length === 0) break
	}
	return { order, content, markerCounts }
}

// The reported failing case: interleaved commands and prompts must run in file
// order (bottom-to-top), NOT with all commands shoved after all prompts.
const interleaved = drain('bot-cmder\n\t$ label hi2\n\t: say hello\n\t$ label hi\n\t: /c\n')
check(
	'interleaved queue drains in bottom-to-top file order',
	JSON.stringify(interleaved.order) === JSON.stringify(['prompt:/c', 'cmd:label hi', 'prompt:say hello', 'cmd:label hi2']),
	JSON.stringify(interleaved.order),
)
check('interleaved: never more than one marker at a time', interleaved.markerCounts.every((n) => n <= 1), JSON.stringify(interleaved.markerCounts))

// Pure prompts drain bottom-to-top with no re-runs, ending on a single [DONE].
const proms = drain('alpha\n\t: newest\n\t: mid\n\t: old\n')
check('pure prompts drain oldest-first, no re-run', JSON.stringify(proms.order) === JSON.stringify(['prompt:old', 'prompt:mid', 'prompt:newest']), JSON.stringify(proms.order))
check('drained queue keeps exactly one [DONE] on the frontier (newest)', proms.content.includes(': newest\n\t\t[DONE]') && (proms.content.match(/\[DONE\]/g) ?? []).length === 1, JSON.stringify(proms.content))

// Pure commands drain bottom-to-top, one at a time.
const cmds2 = drain('alpha\n\t$a\n\t$b\n\t$c\n')
check('pure commands drain bottom-to-top', JSON.stringify(cmds2.order) === JSON.stringify(['cmd:c', 'cmd:b', 'cmd:a']), JSON.stringify(cmds2.order))

// A command waits for the prompt below it before firing (the core requirement).
const gated = drain('alpha\n\t$git push\n\t: make the change\n')
check('command waits for the prompt below it', JSON.stringify(gated.order) === JSON.stringify(['prompt:make the change', 'cmd:git push']), JSON.stringify(gated.order))

// Attention: a mid-task Notification flags the prompt, a later Stop completes it.
const attn = (() => {
	let content = 'alpha\n\t: fix the bug\n'
	const rt = { starting: false, startedAt: 0, sentAt: 0, cmdSentAt: 0, prevPromptCount: 1 }
	const step = (io: Parameters<typeof planQueue>[2]) => {
		const { lines, sessions } = parse(content)
		const d = planQueue(sessions[0], rt, io)
		content = applyOps(lines, buildOps(sessions)).join('\n')
		return d
	}
	step({ now: 100, state: null, cmdDoneMtime: null }) // dispatch the prompt
	step({ now: 200, state: { event: 'Notification', mtimeMs: 200 }, cmdDoneMtime: null }) // blocks
	const flagged = content.includes('[NEEDS ATTENTION]')
	step({ now: 300, state: { event: 'Stop', mtimeMs: 300 }, cmdDoneMtime: null }) // answered -> done
	return { flagged, content }
})()
check('notification flags [NEEDS ATTENTION], later stop resolves it', attn.flagged && attn.content.includes('[DONE]') && !attn.content.includes('[NEEDS ATTENTION]'), JSON.stringify(attn))

// Answering a [NEEDS ATTENTION] prompt (a UserPromptSubmit event) flips it back to
// [EXECUTING]; a later Stop then completes it as usual.
const answered = (() => {
	let content = 'alpha\n\t: fix the bug\n'
	const rt = { starting: false, startedAt: 0, sentAt: 0, cmdSentAt: 0, prevPromptCount: 1 }
	const step = (io: Parameters<typeof planQueue>[2]) => {
		const { lines, sessions } = parse(content)
		planQueue(sessions[0], rt, io)
		content = applyOps(lines, buildOps(sessions)).join('\n')
	}
	step({ now: 100, state: null, cmdDoneMtime: null }) // dispatch
	step({ now: 200, state: { event: 'Notification', mtimeMs: 200 }, cmdDoneMtime: null }) // blocks
	const flagged = content.includes('[NEEDS ATTENTION]')
	step({ now: 300, state: { event: 'UserPromptSubmit', mtimeMs: 300 }, cmdDoneMtime: null }) // answered
	const executing = content.includes('[EXECUTING]') && !content.includes('[NEEDS ATTENTION]')
	step({ now: 400, state: { event: 'Stop', mtimeMs: 400 }, cmdDoneMtime: null }) // finishes
	return { flagged, executing, content }
})()
check('answering [NEEDS ATTENTION] flips it back to [EXECUTING], then Stop -> [DONE]', answered.flagged && answered.executing && answered.content.includes('[DONE]'), JSON.stringify(answered))

// Pane-busy veto: a Stop that arrives while the claude pane is still working (its "esc to
// interrupt" hint is up) must NOT complete the prompt. A session that resumes on its own
// (background task / loop) fires no hook, so the prior turn's Stop would otherwise latch it
// to [DONE] mid-run. Only once the pane reports idle does the Stop resolve it.
const busyVeto = (() => {
	let content = 'alpha\n\t: long task\n'
	const rt = { starting: false, startedAt: 0, sentAt: 0, cmdSentAt: 0, prevPromptCount: 1 }
	const step = (io: Parameters<typeof planQueue>[2]) => {
		const { lines, sessions } = parse(content)
		planQueue(sessions[0], rt, io)
		content = applyOps(lines, buildOps(sessions)).join('\n')
	}
	step({ now: 100, state: null, cmdDoneMtime: null }) // dispatch
	step({ now: 200, state: { event: 'Stop', mtimeMs: 200 }, cmdDoneMtime: null, paneBusy: true }) // busy: vetoed
	const held = content.includes('[EXECUTING]') && !content.includes('[DONE]')
	step({ now: 300, state: { event: 'Stop', mtimeMs: 200 }, cmdDoneMtime: null, paneBusy: false }) // idle: resolves
	return { held, content }
})()
check('a Stop while the pane is busy is vetoed; it completes only once the pane is idle', busyVeto.held && busyVeto.content.includes('[DONE]'), JSON.stringify(busyVeto))

// Self-resume: a [DONE] frontier whose pane is working again — a background task / loop
// resumed it, firing no hook — is re-reflected as [EXECUTING], then settles back to [DONE]
// once the pane goes idle.
const resume = (() => {
	let content = 'alpha\n\t: watch the PR\n'
	const rt = { starting: false, startedAt: 0, sentAt: 0, cmdSentAt: 0, prevPromptCount: 1 }
	const step = (io: Parameters<typeof planQueue>[2]) => {
		const { lines, sessions } = parse(content)
		planQueue(sessions[0], rt, io)
		content = applyOps(lines, buildOps(sessions)).join('\n')
	}
	step({ now: 100, state: null, cmdDoneMtime: null }) // dispatch
	step({ now: 200, state: { event: 'Stop', mtimeMs: 200 }, cmdDoneMtime: null, paneBusy: false }) // done
	const done = content.includes('[DONE]')
	step({ now: 300, state: { event: 'Stop', mtimeMs: 200 }, cmdDoneMtime: null, paneBusy: true }) // resumed
	const reExecuting = content.includes('[EXECUTING]') && !content.includes('[DONE]')
	step({ now: 400, state: { event: 'Stop', mtimeMs: 350 }, cmdDoneMtime: null, paneBusy: false }) // idle again
	return { done, reExecuting, content }
})()
check('a self-resumed [DONE] pane re-shows [EXECUTING], then settles back to [DONE]', resume.done && resume.reExecuting && resume.content.includes('[DONE]'), JSON.stringify(resume))

// Multiline prompt: lines indented deeper than a `:` line fold into that prompt's text and
// dispatch as one `\n`-joined block; there's still only one queue item, and its completion
// marker lands BELOW the body (not wedged between the prompt line and its body).
const multiline = (() => {
	let content = 'Claudia\n\t: how do I fix this?\n\t| WARNING: bad\n\t| Host key verification failed.\n'
	const rt = { starting: false, startedAt: 0, sentAt: 0, cmdSentAt: 0, prevPromptCount: 1 }
	const p0 = parse(content).sessions[0].prompts
	const { lines, sessions } = parse(content)
	const d = planQueue(sessions[0], rt, { now: 100, state: null, cmdDoneMtime: null }) // dispatch
	content = applyOps(lines, buildOps(sessions)).join('\n')
	return { count: p0.length, text: p0[0].text, dispatched: d.find((x) => x.type === 'prompt')?.text, content }
})()
check(
	'`|` lines fold into one multiline prompt with the marker below the body',
	multiline.count === 1 &&
		multiline.text === 'how do I fix this?\nWARNING: bad\nHost key verification failed.' &&
		multiline.dispatched === multiline.text &&
		multiline.content.includes('Host key verification failed.\n\t\t[EXECUTING]'),
	JSON.stringify(multiline),
)
// The `|` prefix (and one following space) is stripped, but further leading spaces are kept,
// so a body's own indentation survives — and a worktree at the same indent is untouched.
const cont = parse('app\n\t: fix this:\n\t| TypeError\n\t|   at foo (a.ts:10)\n\tfeat\n\t\t: work\n')
check(
	'`|` body preserves inner indentation and does not swallow a following worktree',
	cont.sessions[0].prompts[0].text === 'fix this:\nTypeError\n  at foo (a.ts:10)' &&
		cont.sessions.some((s) => s.label === 'app-feat' && s.worktreeBase) &&
		applyOps(cont.lines, buildOps(cont.sessions)).join('\n') === 'app\n\t: fix this:\n\t| TypeError\n\t|   at foo (a.ts:10)\n\tfeat\n\t\t: work\n',
	JSON.stringify({ text: cont.sessions[0].prompts[0].text, labels: cont.sessions.map((s) => s.label) }),
)

// macroSteps: a macro body expands to runnable steps in RUN order (bottom-to-top, like every
// herald queue) — args fill `{0}`/`{1}`/`{*}` (0-based, quote-aware, missing=blank), `#`
// comment and blank lines drop, and `$` lines are commands. Braces (not `$1`) so `{n}` never
// disturbs a `$2` lane sigil in the body.
const steps = macroSteps(': review PR {0}, focus on {1}\n# skip me\n\n$ gh pr view {0}\n$2 npm run dev\n', ['2500', 'the auth refactor'])
check(
	'macroSteps runs bottom-to-top, fills args, drops comments/blanks, leaves $2 alone',
	JSON.stringify(steps) ===
		JSON.stringify([
			{ text: 'npm run dev', isCmd: true },
			{ text: 'gh pr view 2500', isCmd: true },
			{ text: 'review PR 2500, focus on the auth refactor', isCmd: false },
		]),
	JSON.stringify(steps),
)

// A `@macro` call is ONE queue item: the file keeps the `@name` line and carries a single
// overall marker, while its steps run bottom-to-top in sequence (the body's LAST line first —
// here: `: watch` → `$ checkout` → `: prep`), each waiting on its own completion signal. Only
// the last step's Stop advances the item to [DONE].
const macroRun = (() => {
	const macros = { ship: ': prep\n$ checkout\n: watch\n' }
	let content = 'app\n\t@ship\n'
	const rt = { starting: false, startedAt: 0, sentAt: 0, cmdSentAt: 0, prevPromptCount: 1, macroStep: 0 }
	const sent: string[] = []
	const marks: string[] = []
	const step = (io: Parameters<typeof planQueue>[2]) => {
		const { lines, sessions } = parse(content, {}, macros)
		const d = planQueue(sessions[0], rt, io)
		content = applyOps(lines, buildOps(sessions)).join('\n')
		for (const x of d) if (x.type === 'prompt' || x.type === 'cmd') sent.push(`${x.type}:${x.text}`)
		marks.push((content.match(/\[[^\]]+\]/g) ?? []).join(','))
	}
	step({ now: 100, state: null, cmdDoneMtime: null }) // dispatch step 0 (: watch — body's last line)
	step({ now: 200, state: { event: 'Stop', mtimeMs: 200 }, cmdDoneMtime: null, paneBusy: false }) // → step 1 ($ checkout)
	step({ now: 300, state: null, cmdDoneMtime: 250 }) // command done → step 2 (: prep)
	step({ now: 400, state: { event: 'Stop', mtimeMs: 400 }, cmdDoneMtime: null, paneBusy: false }) // last step done → [DONE]
	return { sent, marks, content, oneItem: parse(content, {}, macros).sessions[0].prompts.length === 1 }
})()
check(
	'a @macro is one item: steps run bottom-to-top, the file keeps @ship with one overall marker',
	JSON.stringify(macroRun.sent) === JSON.stringify(['prompt:watch', 'cmd:checkout', 'prompt:prep']) &&
		JSON.stringify(macroRun.marks) === JSON.stringify(['[EXECUTING]', '[EXECUTING]', '[EXECUTING]', '[DONE]']) &&
		macroRun.content.includes('\t@ship\n') &&
		macroRun.oneItem,
	JSON.stringify(macroRun),
)

// Worktrees: an indented non-sigil line names a git worktree of its enclosing repo — a child
// session at `<repo>/../<repo>-worktrees/<name>` whose deeper-indented children are its queue items.
// A childless non-sigil line is an inert session (never created).
const wt = (() => {
	const { sessions } = parse('superapp\n\t: base task\n\tfeat-x\n\t\t: work in x\n\t\t$ npm test\n\tjust a note\n')
	return {
		base: sessions.find((s) => s.label === 'superapp'),
		x: sessions.find((s) => s.label === 'superapp-feat-x'),
		note: sessions.find((s) => s.label === 'superapp-just a note'),
	}
})()
check(
	'a non-sigil indented line becomes a worktree session; its children run there',
	wt.base?.prompts.length === 1 &&
		wt.base.prompts[0].text === 'base task' &&
		wt.x?.worktreeBase === wt.base.dir &&
		wt.x.dir.endsWith('/superapp-worktrees/feat-x') &&
		wt.x.prompts.length === 2 &&
		wt.x.prompts[0].text === 'work in x' &&
		wt.x.prompts[1].isCmd === true &&
		wt.note?.prompts.length === 0,
	JSON.stringify({ base: wt.base?.prompts.map((p) => p.text), x: wt.x?.prompts.map((p) => p.text), xdir: wt.x?.dir, xbase: wt.x?.worktreeBase, note: wt.note?.prompts.length }),
)

// A worktree task carries its own marker one indent deeper (like any prompt), and it
// attaches back to the worktree's task — not the parent repo — so it round-trips byte-exact.
const wtMark = (() => {
	const content = 'repo\n\tfeat\n\t\t: do it\n\t\t\t[EXECUTING]\n'
	const { lines, sessions } = parse(content)
	const feat = sessions.find((s) => s.label === 'repo-feat')
	return { kind: feat?.prompts[0]?.marker?.kind, roundTrip: applyOps(lines, buildOps(sessions)).join('\n') === content }
})()
check('a worktree task keeps its own marker (deeper indent) and round-trips', wtMark.kind === 'EXECUTING' && wtMark.roundTrip, JSON.stringify(wtMark))

// A worktree's tmux label prefixes its container's label (`app-4-feat`), so it groups with
// the repo's `__app-4` and same-named worktrees under different repos don't collide. The
// prefix chains through nesting, while the dir leaf stays the bare on-disk name.
const wtPrefix = parse('app-4\n\tfeat\n\t\tsub\n\t\t\t: deep\n').sessions.filter((s) => s.worktreeBase)
check('a worktree label is prefixed with its repo, chaining through nesting', wtPrefix[0].label === 'app-4-feat' && wtPrefix[1].label === 'app-4-feat-sub' && wtPrefix[0].dir.endsWith('/app-4-worktrees/feat') && wtPrefix[1].dir.endsWith('/feat-worktrees/sub'), JSON.stringify(wtPrefix.map((s) => [s.label, s.dir])))

// An object-form alias carries per-repo worktree setup (`worktree/cmd`, `worktree/copy`). The
// repo header resolves its `dir` like a string alias and holds the setup; a worktree child
// inherits it (that's what addWorktreeAndSpawn runs after `git worktree add`).
const wtAlias = { app: { dir: '/opt/superapp', 'worktree/cmd': ['pnpm install', 'direnv allow'], 'worktree/copy': ['.env', 'node_modules'] }, plain: '/opt/plain' }
const wa = parse('app\n\tfeat\n\t\t: work\nplain\n\twt2\n\t\t: go\n', wtAlias)
const waRepo = wa.sessions.find((s) => s.label === 'app')!
const waWt = wa.sessions.find((s) => s.label === 'app-feat')!
check('object-form alias resolves dir and holds worktree setup', waRepo.dir === '/opt/superapp' && JSON.stringify(waRepo.worktreeCmd) === JSON.stringify(['pnpm install', 'direnv allow']) && JSON.stringify(waRepo.worktreeCopy) === JSON.stringify(['.env', 'node_modules']))
check('a worktree child inherits its base repo worktree setup', JSON.stringify(waWt.worktreeCmd) === JSON.stringify(['pnpm install', 'direnv allow']) && JSON.stringify(waWt.worktreeCopy) === JSON.stringify(['.env', 'node_modules']))
check('a string-form alias carries no worktree setup', wa.sessions.find((s) => s.label === 'plain-wt2')!.worktreeCmd === undefined)
check('aliasWorktree: object yields its lists, string yields undefined', JSON.stringify(aliasWorktree(wtAlias.app)) === JSON.stringify({ cmd: ['pnpm install', 'direnv allow'], copy: ['.env', 'node_modules'] }) && aliasWorktree('/opt/plain') === undefined)

// Teardown: a live `__` session no longer in the model is reaped. A worktree session (its
// dir/base stamped in rt while alive) is reaped WITH its worktree so it's cleaned up from
// disk alongside its tmux session; a plain repo session carries no worktree to remove.
const reapRt = { 'app-4-feat': { worktreeDir: '/r/app-4-worktrees/feat', worktreeBase: '/r/app-4' }, app: {} }
const reaped = reapTargets(['app', 'app-4-feat', 'keep'], new Set(['keep']), new Set<string>(), reapRt)
check('a removed worktree session is reaped with its worktree (dir/base from rt)', JSON.stringify(reaped.find((r) => r.label === 'app-4-feat')?.worktree) === JSON.stringify({ base: '/r/app-4', dir: '/r/app-4-worktrees/feat' }))
check('a removed plain session is reaped with no worktree to remove', reaped.find((r) => r.label === 'app')?.worktree === null)
check('a session still in the model (or reserved) is not reaped', !reaped.some((r) => r.label === 'keep') && reaped.length === 2)
// A worktree whose rt entry is missing (e.g. never stamped) is still killed, just not
// removed from disk — never throws on the absent entry.
check('a reaped label with no rt entry yields a null worktree', reapTargets(['gone'], new Set<string>(), new Set<string>(), {}).every((r) => r.worktree === null))

// A trailing `!` on a worktree label means "show it now", exactly like on a repo header:
// it's stripped from the tmux label and the on-disk dir leaf so both stay clean.
const wtBang = parse('repo\n\tfeat !\n\t\t: do it\n').sessions.find((s) => s.worktreeBase)!
check('a worktree `!` sets showNow and cleans the label/dir', wtBang.showNow === true && wtBang.label === 'repo-feat' && wtBang.header === 'feat' && wtBang.dir.endsWith('/repo-worktrees/feat'))
// Unfired, the `!` round-trips verbatim (indent preserved); once fired, buildOps strips
// just the `!`, keeping the worktree's leading tab.
const wtBangParse = parse('repo\n\tfeat !\n\t\t: do it\n')
check('an unfired worktree `!` round-trips verbatim', applyOps(wtBangParse.lines, buildOps(wtBangParse.sessions)).join('\n') === 'repo\n\tfeat !\n\t\t: do it\n')
wtBangParse.sessions.find((s) => s.worktreeBase)!.showNowFired = true
check('a fired worktree `!` is stripped, keeping the indent', applyOps(wtBangParse.lines, buildOps(wtBangParse.sessions)).join('\n') === 'repo\n\tfeat\n\t\t: do it\n')
// A worktree with a `!` but no queued work still counts as pending-to-show, so the spawn
// gate (which ORs showNow with hasPendingInput) will create + reveal it.
check('a bare worktree `!` carries showNow even with no work', parse('repo\n\tfeat !\n').sessions.find((s) => s.worktreeBase)!.showNow === true)

// A worktree whose base doesn't exist can't be created, so the tick stamps a session marker
// ([NO DIR …]) that buildOps writes below the worktree's own block at the worktree's indent + 1
// — attaching to the worktree, not the parent repo — and clears again (base appeared →
// desiredSession null) by deleting that line.
const wtErr = (() => {
	const p = parse('repo\n\tfeat\n\t\t: do it\n')
	p.sessions.find((s) => s.worktreeBase)!.desiredSession = '[NO DIR /r/repo]'
	const marked = applyOps(p.lines, buildOps(p.sessions)).join('\n')
	const rp = parse(marked)
	const rfeat = rp.sessions.find((s) => s.worktreeBase)!
	const repoMarker = rp.sessions.find((s) => s.label === 'repo')!.sessionMarker
	rfeat.desiredSession = null
	return { marked, attached: rfeat.sessionMarker?.text, repoMarker, cleared: applyOps(rp.lines, buildOps(rp.sessions)).join('\n') }
})()
check(
	'a non-existent-base worktree gets a marker at its own indent, attaching to the worktree, and clears',
	wtErr.marked === 'repo\n\tfeat\n\t\t: do it\n\t\t[NO DIR /r/repo]\n' && wtErr.attached === '[NO DIR /r/repo]' && wtErr.repoMarker === null && wtErr.cleared === 'repo\n\tfeat\n\t\t: do it\n',
	JSON.stringify(wtErr),
)

// An explicit `: /clear` prompt clears the conversation without invoking the model,
// so no Stop event ever arrives. It must still complete (a tick after dispatch) so the
// drain continues, instead of hanging forever at [EXECUTING]. Note: state is null on
// every tick — no Stop is ever fed in.
const clearPrompt = (() => {
	let content = 'alpha\n\t: after the reset\n\t: /clear\n'
	const rt = { starting: false, startedAt: 0, sentAt: 0, cmdSentAt: 0, prevPromptCount: 2 }
	const step = (io: Parameters<typeof planQueue>[2]) => {
		const { lines, sessions } = parse(content)
		const d = planQueue(sessions[0], rt, io)
		content = applyOps(lines, buildOps(sessions)).join('\n')
		return d
	}
	const d1 = step({ now: 100, state: null, cmdDoneMtime: null }) // dispatch /clear (bottom-most)
	const d2 = step({ now: 200, state: null, cmdDoneMtime: null }) // completes it, drains next
	return { d1, d2, content }
})()
check(
	'a `: /clear` prompt completes with no Stop event and the drain continues',
	clearPrompt.d1.some((d) => d.type === 'prompt' && d.text === '/clear') &&
		clearPrompt.d2.some((d) => d.type === 'prompt' && d.text === 'after the reset') &&
		clearPrompt.content.includes(': after the reset\n\t\t[EXECUTING]'),
	JSON.stringify(clearPrompt),
)

// Deleting all prompts emits a /clear (and only then).
const clearTest = (() => {
	const rt = { starting: false, startedAt: 0, sentAt: 0, cmdSentAt: 0, prevPromptCount: 2 }
	const { sessions } = parse('alpha\n\t$keep me\n')
	return planQueue(sessions[0], rt, { now: 100, state: null, cmdDoneMtime: null })
})()
check('removing all prompts triggers /clear', JSON.stringify(clearTest) === JSON.stringify([{ type: 'clear' }]), JSON.stringify(clearTest))

// 5d-bis. An indented `#` is a human-action barrier: it halts the lane's drain until
// removed, reads as a comment (never a prompt/command), and round-trips verbatim. A
// column-0 `#` is a plain comment instead (no queue to halt) and is never a session.
const barrierParse = parse('alpha\n\t: newest\n\t# manual step\n\t: old\n')
check(
	'an indented `#` parses as a barrier (not a prompt/command)',
	barrierParse.sessions[0].prompts.length === 3 && barrierParse.sessions[0].prompts[1].isBarrier === true && barrierParse.sessions[0].prompts[1].text === 'manual step',
	JSON.stringify(barrierParse.sessions[0].prompts.map((p) => [p.isBarrier, p.text])),
)
check('a barrier round-trips verbatim', applyOps(barrierParse.lines, buildOps(barrierParse.sessions)).join('\n') === 'alpha\n\t: newest\n\t# manual step\n\t: old\n')

// The drain stops at the barrier: `old` (below it) runs, `newest` (above it) does not.
const blocked = drain('alpha\n\t: newest\n\t# manual step\n\t: old\n')
check('the drain halts at an indented `#` barrier', JSON.stringify(blocked.order) === JSON.stringify(['prompt:old']), JSON.stringify(blocked.order))
const unblocked = drain(blocked.content.replace('\t# manual step\n', ''))
check('removing the barrier releases the rest of the queue', JSON.stringify(unblocked.order) === JSON.stringify(['prompt:newest']), JSON.stringify(unblocked.order))
// A `#` below the last runnable item blocks the whole session (the `# blocked` pattern).
const bottom = drain('alpha\n\t: a\n\t# blocked\n')
check('a bottom `#` barrier blocks the entire session', JSON.stringify(bottom.order) === JSON.stringify([]), JSON.stringify(bottom.order))

// A column-0 `#` is a plain comment: not a session, ignored, preserved verbatim.
const col0 = parse('# top-level note\nalpha\n\t: work\n# another\n')
check('a column-0 `#` is a comment, not a session header', col0.sessions.length === 1 && col0.sessions[0].label === 'alpha' && col0.sessions[0].prompts.length === 1)
check('column-0 comments round-trip verbatim', applyOps(col0.lines, buildOps(col0.sessions)).join('\n') === '# top-level note\nalpha\n\t: work\n# another\n')

// A column-0 `#` closes the current session block, so an indented `#` note beneath it is
// NOT captured as the preceding session's barrier — the session stays spawnable.
const commentThenIndented = parse('alpha\n\t: work\n# a note\n\t# sub-note\n')
check('an indented `#` under a column-0 comment is not a barrier on the prior session', commentThenIndented.sessions.length === 1 && commentThenIndented.sessions[0].prompts.length === 1 && !commentThenIndented.sessions[0].prompts.some((p) => p.isBarrier))
check('a session is still pending despite a trailing commented note block', hasPendingInput(commentThenIndented.sessions[0]))
check('a comment-then-indented block round-trips verbatim', applyOps(commentThenIndented.lines, buildOps(commentThenIndented.sessions)).join('\n') === 'alpha\n\t: work\n# a note\n\t# sub-note\n')

// The spawn gate: a task below a barrier still spawns; a barrier-blocked session does not.
check('a task below a barrier is pending input (spawn)', hasPendingInput(parse('alpha\n\t# manual\n\t: run me\n').sessions[0]))
check('a barrier-blocked session has nothing to input (no spawn)', !hasPendingInput(parse('alpha\n\t: a\n\t# blocked\n').sessions[0]))

// 5f. A bare `show` line is a queue item (isShow) that switches the tmux client
// when the drain reaches it. Parsing records it as a non-prompt queue item; it
// round-trips while pending; and once fired buildOps deletes the line (consumed).
const showParse = parse('alpha\n\t: do a\n\tshow\n')
const showItem = showParse.sessions[0].prompts.find((p) => p.isShow)
check('bare `show` parses as an isShow queue item (not a prompt/command)', !!showItem && showParse.sessions[0].prompts.length === 2 && showParse.sessions[0].prompts.filter((p) => !p.isShow).length === 1)
check('an unfired `show` round-trips verbatim', applyOps(showParse.lines, buildOps(showParse.sessions)).join('\n') === 'alpha\n\t: do a\n\tshow\n')
showItem!.fired = true
check('a fired `show` is deleted from the file', applyOps(showParse.lines, buildOps(showParse.sessions)).join('\n') === 'alpha\n\t: do a\n')

// A bare `!` line is shorthand for `show`: same isShow queue item, round-trips
// verbatim while pending, and is deleted once fired.
const bangShow = parse('alpha\n\t: do a\n\t!\n')
const bangShowItem = bangShow.sessions[0].prompts.find((p) => p.isShow)
check('bare `!` parses as a show queue item', !!bangShowItem && bangShow.sessions[0].prompts.length === 2)
check('an unfired `!` show round-trips verbatim', applyOps(bangShow.lines, buildOps(bangShow.sessions)).join('\n') === 'alpha\n\t: do a\n\t!\n')
bangShowItem!.fired = true
check('a fired `!` show is deleted from the file', applyOps(bangShow.lines, buildOps(bangShow.sessions)).join('\n') === 'alpha\n\t: do a\n')

// `show` drains in queue order: it fires only after the item below it is done, and
// before the item above it runs. The `show` line is consumed (deleted) when it fires.
const showQueue = drain('alpha\n\t: after\n\tshow\n\t: before\n')
check('show runs in queue order (below done → show → above)', JSON.stringify(showQueue.order) === JSON.stringify(['prompt:before', 'show', 'prompt:after']), JSON.stringify(showQueue.order))
check('a fired show leaves the file without the show line', !showQueue.content.includes('show') && showQueue.content.includes(': after\n\t\t[DONE]'), JSON.stringify(showQueue.content))
check('show never adds a second marker', showQueue.markerCounts.every((n) => n <= 1), JSON.stringify(showQueue.markerCounts))

// A `show` reveals the window the last task before it used: the shell window when the
// preceding item was a `$command`, the claude window when it was a prompt.
const showWindowOf = (initial: string): string | undefined => {
	let content = initial
	const rt = { starting: false, startedAt: 0, sentAt: 0, cmdSentAt: 0, prevPromptCount: initial.match(/^\t(?:prompt:|:)/gm)?.length ?? 0 }
	let clock = 1000
	for (let i = 0; i < 50; i++) {
		clock += 100
		const { lines, sessions } = parse(content)
		const s = sessions[0]
		const active = s.prompts.find((p) => p.desiredKind === 'EXECUTING' || p.desiredKind === 'ATTENTION')
		const io = { now: clock, state: active && !active.isCmd ? { event: 'Stop', mtimeMs: clock } : null, cmdDoneMtime: active?.isCmd ? clock : null }
		const show = planQueue(s, rt, io).find((d) => d.type === 'show')
		if (show) return show.window?.kind
		content = applyOps(lines, buildOps(sessions)).join('\n')
		if (!active && s.prompts.every((p) => p.desiredKind !== 'EXECUTING')) break
	}
	return undefined
}
check('show after a $command reveals the shell window', showWindowOf('alpha\n\tshow\n\t$ deploy\n') === 'shell', showWindowOf('alpha\n\tshow\n\t$ deploy\n'))
check('show after a prompt reveals the claude window', showWindowOf('alpha\n\tshow\n\t: do a thing\n') === 'claude', showWindowOf('alpha\n\tshow\n\t: do a thing\n'))
check('show with nothing before it defaults to the claude window', showWindowOf('alpha\n\tshow\n') === 'claude', String(showWindowOf('alpha\n\tshow\n')))

// A header `!` reveals the frontier item's window: whatever is [EXECUTING] (a command
// -> shell, a prompt -> claude), else the most recently [DONE] one, else nothing.
const fw = (s: string) => frontierWindow(parse(s).sessions[0])?.kind
check('frontier window is the executing command\'s shell', fw('alpha!\n\t$ deploy\n\t\t[EXECUTING]\n') === 'shell', String(fw('alpha!\n\t$ deploy\n\t\t[EXECUTING]\n')))
check('frontier window is the executing prompt\'s claude', fw('alpha!\n\t: work\n\t\t[EXECUTING]\n') === 'claude', String(fw('alpha!\n\t: work\n\t\t[EXECUTING]\n')))
check('executing wins over a done item below it', fw('alpha!\n\t: work\n\t\t[EXECUTING]\n\t$ built\n\t\t[DONE]\n') === 'claude', String(fw('alpha!\n\t: work\n\t\t[EXECUTING]\n\t$ built\n\t\t[DONE]\n')))
check('with nothing executing, the last [DONE] wins', fw('alpha!\n\t$ built\n\t\t[DONE]\n') === 'shell', String(fw('alpha!\n\t$ built\n\t\t[DONE]\n')))
check('frontier window is undefined when nothing has run', fw('alpha!\n\t: pending\n') === undefined, String(fw('alpha!\n\t: pending\n')))

// A `show` sitting above a `#` barrier waits: the barrier halts the drain before it.
const showBehindBarrier = drain('alpha\n\tshow\n\t# manual\n\t: first\n')
check('show above a `#` barrier does not fire (barrier halts first)', !showBehindBarrier.order.includes('show') && JSON.stringify(showBehindBarrier.order) === JSON.stringify(['prompt:first']), JSON.stringify(showBehindBarrier.order))

// 5e. Spawn gate: only spawn a session once there's something to input. A bare
// header (or a fully drained one) has nothing pending, so it stays unspawned.
check('bare header has no pending input', !hasPendingInput(parse('alpha\n').sessions[0]))
check('header with a fresh prompt has pending input', hasPendingInput(parse('alpha\n\t: do a\n').sessions[0]))
check('header with a fresh command has pending input', hasPendingInput(parse('alpha\n\t$git status\n').sessions[0]))
check('all-done session has no pending input', !hasPendingInput(parse('alpha\n\t: do a\n\t\t[DONE]\n').sessions[0]))
check('an executing session still counts as pending (resume after restart)', hasPendingInput(parse('alpha\n\t: do a\n\t\t[EXECUTING]\n').sessions[0]))
check('a fully drained queue (frontier at top, nulls below) has no pending input', !hasPendingInput(parse('alpha\n\t: newest\n\t\t[DONE]\n\t: old\n').sessions[0]))

// 6. Path-form headers: label = basename, bare names still map by name.
const pathFile = '~/projects/superapp\n\tprompt: hi\n/abs/path/foo\nbarename\n'
const pf = parse(pathFile)
check(
	'path header -> basename label',
	pf.sessions[0].label === 'superapp' && pf.sessions[0].dir.endsWith('/projects/superapp'),
	`${pf.sessions[0].label} / ${pf.sessions[0].dir}`,
)
check('absolute path header', pf.sessions[1].label === 'foo' && pf.sessions[1].dir === '/abs/path/foo')
check('bare name still maps to ~/_dev/<name>', pf.sessions[2].label === 'barename' && pf.sessions[2].dir.endsWith('/_dev/barename'))

// 6b. An aliased header resolves to the mapped path (label = the alias); a bare
// name that isn't an alias still falls back to ~/_dev/<name>.
const aliased = parse('app\n\tprompt: hi\nbarename\n', { app: '/opt/repos/superapp', other: '~/x' })
check('alias header -> mapped path, label = alias', aliased.sessions[0].label === 'app' && aliased.sessions[0].dir === '/opt/repos/superapp', `${aliased.sessions[0].label} / ${aliased.sessions[0].dir}`)
check('alias `~` expands to home', parse('other\n', { other: '~/x' }).sessions[0].dir.endsWith('/x') && !parse('other\n', { other: '~/x' }).sessions[0].dir.startsWith('~'))
check('non-aliased bare name still maps to ~/_dev/<name>', aliased.sessions[1].dir.endsWith('/_dev/barename'))

// 6c. A `!` suffix on a header means "show it immediately": the label/dir resolve
// from the name without the `!`, and firing the request strips the `!` from the line.
const bang = parse('superapp!\n\t: do a\n')
check('`!` header sets showNow and resolves the name without it', bang.sessions[0].showNow === true && bang.sessions[0].label === 'superapp' && bang.sessions[0].dir.endsWith('/_dev/superapp'))
check('a plain header has showNow false', parse('superapp\n').sessions[0].showNow === false)
check('an unfired `!` header round-trips verbatim', applyOps(bang.lines, buildOps(bang.sessions)).join('\n') === 'superapp!\n\t: do a\n')
bang.sessions[0].showNowFired = true
check('firing a `!` header strips the `!` from the line', applyOps(bang.lines, buildOps(bang.sessions)).join('\n') === 'superapp\n\t: do a\n')
// `!` composes with aliases and paths (resolve the name without the `!`).
check('`!` composes with an alias header', parse('app!\n', { app: '/opt/x' }).sessions[0].showNow === true && parse('app!\n', { app: '/opt/x' }).sessions[0].dir === '/opt/x')
check('`!` composes with a path header', parse('/abs/foo!\n').sessions[0].showNow === true && parse('/abs/foo!\n').sessions[0].dir === '/abs/foo' && parse('/abs/foo!\n').sessions[0].label === 'foo')

// 7. Blank lines between sessions are skipped but preserved on round-trip.
const withBlanks = 'superapp\n\tprompt: do a thing\n\nsuperapp-2\n\tprompt: do another\n'
const wb = parse(withBlanks)
check('blank-separated sessions both parsed', wb.sessions.length === 2 && wb.sessions.map((s) => s.label).join(',') === 'superapp,superapp-2')
check('blank lines round-trip byte-identical', applyOps(wb.lines, buildOps(wb.sessions)).join('\n') === withBlanks)

// 8. `pnpm herald` TUI sync helpers. toLines mirrors nvim's buffer representation
// (a trailing newline is the eol marker, not an extra empty line).
check('toLines drops the trailing-newline eol', JSON.stringify(toLines('a\nb\n')) === JSON.stringify(['a', 'b']))
check('toLines keeps a missing final newline as a real last line', JSON.stringify(toLines('a\nb')) === JSON.stringify(['a', 'b']))

// The core sync guarantee: the controller flips a marker (theirs) while the user is
// editing a prompt on another line (ours). The merge keeps BOTH — the user's edit
// is never lost — and the untouched controller line is picked up.
const base8 = ['superapp', '\t: fix the bug', '\t\t[EXECUTING]', '\t: start X', '\t\t[DONE]']
const ours8 = ['superapp', '\t: fix the login bug now', '\t\t[EXECUTING]', '\t: start X', '\t\t[DONE]'] // user edited a prompt
const theirs8 = ['superapp', '\t: fix the bug', '\t\t[DONE]', '\t: start X', '\t\t[DONE]'] // controller: EXECUTING -> DONE
const merged8 = merge3(ours8, base8, theirs8)
check('merge keeps the user edit and the controller marker change', JSON.stringify(merged8) === JSON.stringify(['superapp', '\t: fix the login bug now', '\t\t[DONE]', '\t: start X', '\t\t[DONE]']), JSON.stringify(merged8))

// On a genuine same-line conflict (both changed the same line), OURS wins so the
// line you're typing is never dropped.
check('same-line conflict keeps ours', JSON.stringify(merge3(['x', 'MINE'], ['x', 'o'], ['x', 'THEIRS'])) === JSON.stringify(['x', 'MINE']), JSON.stringify(merge3(['x', 'MINE'], ['x', 'o'], ['x', 'THEIRS'])))

// nearestIndex keeps the cursor on the same logical line after lines shift.
check('nearestIndex finds the anchor line nearest the old row', nearestIndex(['a', 'x', 'b', 'x', 'c'], 'x', 3) === 3 && nearestIndex(['a', 'x', 'b', 'x', 'c'], 'x', 1) === 1)
check('nearestIndex falls back to a clamped row when absent', nearestIndex(['a', 'b'], 'zzz', 9) === 1)

// 9. Multi-file merge: a label appearing in several files becomes ONE logical queue —
// every occurrence's rows combine (in file order), and a marker still writes back to
// whichever file its row lives in. `shared` is in both files here.
const fileA = parse('alpha\n\t: work on alpha\nshared\n\t: from A\n')
const fileB = parse('shared\n\t: from B\nbeta\n\t: work on beta\n')
const merged = mergeSessions([fileA.sessions, fileB.sessions])
check('merge unions distinct labels across files', [...merged.labels].sort().join(',') === 'alpha,beta,shared')
check('one merged session per label (no dropping)', merged.sessions.map((s) => s.label).join(',') === 'alpha,shared,beta')
const sharedMerged = merged.sessions.find((s) => s.label === 'shared')!
check(
	'a shared label combines every file’s rows into one renumbered queue',
	sharedMerged.prompts.map((p) => p.text).join(',') === 'from A,from B' && JSON.stringify(sharedMerged.prompts.map((p) => p.order)) === JSON.stringify([0, 1]),
	JSON.stringify(sharedMerged.prompts.map((p) => [p.text, p.order])),
)
check('the merged session records its parts, primary (file A) first', sharedMerged.parts?.length === 2 && sharedMerged.parts![0] === fileA.sessions.find((s) => s.label === 'shared'))
check('no [DUPLICATE] left on either file', fileA.sessions.find((s) => s.label === 'shared')!.desiredSession === null && fileB.sessions[0].desiredSession === null)

// Driving the merged queue: the bottom row (from B, highest order) runs first; its
// [EXECUTING] writes back into file B only — file A is untouched (per-file buildOps).
const sharedRt = { sentAt: 0, cmdSentAt: 0, prevPromptCount: 2 }
planQueue(sharedMerged, sharedRt, { now: 100, state: null, cmdDoneMtime: null })
check('the bottom (file B) row dispatches first', sharedMerged.prompts.find((p) => p.text === 'from B')!.desiredKind === 'EXECUTING' && sharedMerged.prompts.find((p) => p.text === 'from A')!.desiredKind === null)
check('the marker writes back into file B only', applyOps(fileB.lines, buildOps(fileB.sessions)).join('\n') === 'shared\n\t: from B\n\t\t[EXECUTING]\nbeta\n\t: work on beta\n')
check('file A is left unchanged by a marker on file B', applyOps(fileA.lines, buildOps(fileA.sessions)).join('\n') === 'alpha\n\t: work on alpha\nshared\n\t: from A\n')

// The frontier crosses the file boundary: finishing `from B` (file B) makes `from A`
// (file A) the frontier, so B's marker is cleared and A gets the [EXECUTING] — a single
// queue spanning two files.
const xfA = parse('shared\n\t: from A\n')
const xfB = parse('shared\n\t: from B\n')
const xfMerged = mergeSessions([xfA.sessions, xfB.sessions]).sessions.find((s) => s.label === 'shared')!
const xfRt = { sentAt: 0, cmdSentAt: 0, prevPromptCount: 2 }
planQueue(xfMerged, xfRt, { now: 100, state: null, cmdDoneMtime: null }) // dispatch `from B`
planQueue(xfMerged, xfRt, { now: 200, state: { event: 'Stop', mtimeMs: 200 }, cmdDoneMtime: null }) // B done → A runs
check('frontier crosses to file A on B’s completion', applyOps(xfA.lines, buildOps(xfA.sessions)).join('\n') === 'shared\n\t: from A\n\t\t[EXECUTING]\n', applyOps(xfA.lines, buildOps(xfA.sessions)).join('\n'))
check('file B’s marker is cleared as the frontier leaves it', applyOps(xfB.lines, buildOps(xfB.sessions)).join('\n') === 'shared\n\t: from B\n', applyOps(xfB.lines, buildOps(xfB.sessions)).join('\n'))

// Capturing manually-typed input back into the file. A prompt typed into a live pane lands
// just above the lane's frontier as the newest [EXECUTING] row; the previous frontier's
// marker is cleared (it's now below the divider = already run). Mirrors how the controller
// stages a capture: planCapture → clear the prior frontier → merge with buildOps.
const capApply = (src: string, n: number, items: { text: string; isCmd: boolean }[]): string => {
	const { lines, sessions } = parse(src)
	const plan = planCapture(sessions[0], n, items)!
	if (plan.clear) plan.clear.desiredKind = null
	return applyOps(lines, [...buildOps(sessions), { pos: plan.at - 1, type: 'insert' as const, text: plan.lines.join('\n') }]).join('\n')
}
check(
	'manual prompt lands above the frontier, taking its marker',
	capApply('visa\n\t: old pending\n\t: done one\n\t\t[DONE]\n', 1, [{ text: 'my manual', isCmd: false }]) === 'visa\n\t: old pending\n\t: my manual\n\t\t[EXECUTING]\n\t: done one\n',
	capApply('visa\n\t: old pending\n\t: done one\n\t\t[DONE]\n', 1, [{ text: 'my manual', isCmd: false }]),
)
check(
	'manual command lands as a finished [DONE] row (fresh lane, appended at bottom)',
	capApply('accounting\n\t: seed\n', 1, [{ text: 'sm .', isCmd: true }]) === 'accounting\n\t: seed\n\t$ sm .\n\t\t[DONE]\n',
	capApply('accounting\n\t: seed\n', 1, [{ text: 'sm .', isCmd: true }]),
)
check(
	'a multiline manual prompt uses `|` continuation lines',
	capApply('repo\n\t: x\n\t\t[DONE]\n', 1, [{ text: 'line one\nline two\n\nline four', isCmd: false }]) ===
		'repo\n\t: line one\n\t| line two\n\t|\n\t| line four\n\t\t[EXECUTING]\n\t: x\n',
	capApply('repo\n\t: x\n\t\t[DONE]\n', 1, [{ text: 'line one\nline two\n\nline four', isCmd: false }]),
)
check(
	'a numbered lane keeps its `:N`/`$N` sigil',
	capApply('repo\n\t::2 seed\n\t\t[DONE]\n', 2, [{ text: 'hi', isCmd: false }]) === 'repo\n\t:2 hi\n\t\t[EXECUTING]\n\t::2 seed\n',
	capApply('repo\n\t::2 seed\n\t\t[DONE]\n', 2, [{ text: 'hi', isCmd: false }]),
)
{
	// The newest prompt in a batch keeps the [EXECUTING] marker; the earlier one drops below
	// it, unmarked (already run). A command in the same batch is a finished [DONE] row.
	const plan = planCapture(parse('repo\n\t: base\n\t\t[DONE]\n').sessions[0], 1, [
		{ text: 'first', isCmd: false },
		{ text: 'second', isCmd: false },
	])!
	check('newest prompt of a batch is [EXECUTING], older is unmarked below it', plan.lines.join('\n') === '\t: second\n\t\t[EXECUTING]\n\t: first', plan.lines.join('\n'))
	check('a command-only batch marks the row [DONE], not [EXECUTING]', planCapture(parse('repo\n\t: base\n\t\t[DONE]\n').sessions[0], 1, [{ text: 'ls', isCmd: true }])!.executing === false)
	check('an empty batch is a no-op', planCapture(parse('repo\n\t: base\n').sessions[0], 1, []) === null)
}
{
	// A finished command captured while a prompt is still [EXECUTING] logs below that prompt
	// without stealing its marker — the shell and claude panes run concurrently.
	const out = capApply('repo\n\t: working\n\t\t[EXECUTING]\n', 1, [{ text: 'git status', isCmd: true }])
	check('a command during a live prompt logs below it, leaving [EXECUTING] intact', out === 'repo\n\t: working\n\t\t[EXECUTING]\n\t$ git status\n', out)
}

{
	// Claude Code resolves a sent slash command to its canonical `.scope` id, so the echo we
	// capture won't string-match the short form we sent (a macro `: /cmd` step is the usual case).
	check('scope-suffixed echo matches the short command we sent', slashEcho('/watch-pr-comments.shared', '/watch-pr-comments') === true)
	check('identical slash commands still match', slashEcho('/ship', '/ship') === true)
	check('scope-suffixed echo matches with identical args', slashEcho('/ship.shared feat', '/ship feat') === true)
	check('a distinct command is not swallowed as a scope suffix', slashEcho('/cp', '/c') === false)
	check('differing args do not match', slashEcho('/ship.shared a', '/ship b') === false)
	check('non-slash text is left to exact matching', slashEcho('git status', 'git status') === false)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
