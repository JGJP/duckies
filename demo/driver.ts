#!/usr/bin/env tsx
// Supervisor-simulation driver for the VHS demo. It drives ONE session's frontier markers
// (EXECUTING -> DONE, bottom-to-top) using the SAME real reconcile functions the live tick does
// (parse -> planQueue -> buildOps -> applyOps), but feeds fabricated "turn finished" signals
// instead of a real claude/tmux session. It mirrors test.ts's `drain` helper, with real sleeps
// between ticks so the built-in editor (tui.ts, 300ms live-reload poll) shows the markers march.
//
// Usage: tsx demo/driver.ts <file.dk> --label <session> --wait <substring> --step <ms> --hold <ms>
// It waits until <substring> appears in the file (the author has saved the prompts), then animates.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { applyOps, buildOps, parse, planQueue } from '../duckies'

const arg = (flag: string, def: string) => {
	const i = process.argv.indexOf(flag)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const file = process.argv[2]
const label = arg('--label', 'api-server')
const waitFor = arg('--wait', '')
const stepMs = Number(arg('--step', '1800'))
const holdMs = Number(arg('--hold', '4000'))
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const read = () => readFileSync(file, 'utf8')
const write = (content: string) => {
	const tmp = `${file}.tmp`
	writeFileSync(tmp, content)
	renameSync(tmp, file) // atomic swap so the editor never reads a half-written file
}
const driven = (content: string) => parse(content).sessions.find((s) => s.label === label)

// Wait (bounded) until the author has written + saved the prompts we animate.
for (let i = 0; i < 400; i++) {
	const s = driven(read())
	if (s && s.prompts.length >= 1 && (!waitFor || read().includes(waitFor))) break
	await sleep(300)
}

// Animate: one tick per step, completing whatever is active (via a fabricated Stop event) and
// dispatching the next, exactly like the live loop — the marker walks up the queue as it goes.
const start = parse(read()).sessions.find((s) => s.label === label)
const rt = { starting: false, startedAt: 0, sentAt: 0, cmdSentAt: 0, prevPromptCount: start?.prompts.length ?? 0 }
let clock = 1000
for (let i = 0; i < 50; i++) {
	clock += 100
	const { lines, sessions } = parse(read())
	const s = sessions.find((x) => x.label === label)
	if (!s) break
	const active = s.prompts.find((p) => p.desiredKind === 'EXECUTING' || p.desiredKind === 'ATTENTION')
	const io = {
		now: clock,
		state: active && !active.isCmd ? { event: 'Stop', mtimeMs: clock } : null,
		cmdDoneMtime: active?.isCmd ? clock : null,
	}
	const disp = planQueue(s, rt, io)
	write(applyOps(lines, buildOps([s])).join('\n'))
	if (!active && disp.length === 0) break
	await sleep(stepMs)
}
await sleep(holdMs)
