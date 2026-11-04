// devices/<computer>.json: so the phone can say "Computer: checked 4 min ago". Only the computer's short host name, the
// worker version, which tools are present (true/false, never their paths) and two counts. No user name, path or token.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { commitPaths } from './gitops.mjs'
import { VERSION } from './version.mjs'

/** The short host name, lower-case `a-z0-9-`: the file name in `devices/`. */
export const safeHost = (name = hostname()) =>
	String(name).split('.')[0].toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'computer'

export const devicePath = (name = hostname()) => `devices/${safeHost(name)}.json`

export const countJson = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.json')).length : 0)

export function heartbeatBody({ host = hostname(), tools = {}, pending = 0, failed = 0, now = new Date() }) {
	return {
		schema: 'myind.device/1',
		name: String(host).split('.')[0].slice(0, 60) || 'computer',
		kind: 'computer',
		lastRun: now.toISOString(),
		version: VERSION,
		tools: { gh: !!tools.gh, claude: !!tools.claude, whisper: !!tools.whisper, wpBrain: !!tools.wpBrain },
		pending,
		failed,
	}
}

const sameExceptTime = (a, b) => JSON.stringify({ ...a, lastRun: '' }) === JSON.stringify({ ...b, lastRun: '' })

/**
 * Whether the check-in needs writing again. A change (anything but `lastRun`) always does. Otherwise only when it is
 * older than `everyMinutes` while jobs wait (the phone calls a computer "not seen for a while" after two hours of
 * waiting jobs with no check-in), or older than `idleMinutes` when nothing waits. That keeps an idle `watch` loop to
 * two commits a day instead of 48. `everyMinutes: 0` always writes (setup).
 */
export function heartbeatDue(old, body, { now = new Date(), everyMinutes = 30, idleMinutes = 720 } = {}) {
	if (!old || everyMinutes <= 0 || !sameExceptTime(old, body)) return true
	const age = now.getTime() - Date.parse(old.lastRun)
	if (!(age >= 0)) return true // unreadable or from the future: write a true one
	const limit = body.pending > 0 ? everyMinutes : Math.max(everyMinutes, idleMinutes)
	return age >= limit * 60_000
}

/**
 * Writes and commits the heartbeat (explicit path, one commit) when `heartbeatDue` says so, so a `watch` loop doesn't
 * add a commit every five minutes. The caller pushes. Resolves with { rel, written }.
 */
export async function writeHeartbeat(repoDir, { tools, host = hostname(), now = new Date(), everyMinutes = 30, idleMinutes = 720 } = {}) {
	const rel = devicePath(host)
	const body = heartbeatBody({ host, tools, now, pending: countJson(join(repoDir, 'inbox')), failed: countJson(join(repoDir, 'failed')) })
	let old = null
	try {
		old = JSON.parse(readFileSync(join(repoDir, rel), 'utf8'))
	} catch {
		// first run on this computer
	}
	if (!heartbeatDue(old, body, { now, everyMinutes, idleMinutes })) return { rel, written: false }
	mkdirSync(join(repoDir, 'devices'), { recursive: true })
	writeFileSync(join(repoDir, rel), `${JSON.stringify(body, null, 2)}\n`)
	await commitPaths(repoDir, [rel], `chore: ${safeHost(host)} checked in`)
	return { rel, written: true }
}
