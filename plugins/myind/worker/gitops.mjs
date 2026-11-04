// Git for the worker's own clone. Paths are always explicit and literal. Commit subjects come from the caller; every
// commit then gets the same By / When / App lines the phone writes (storage-format.md, "Commit messages").
import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { oneLine, run, sleep } from './util.mjs'
import { VERSION } from './version.mjs'

const ENV = () => ({ ...process.env, GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' })

export async function git(dir, args, opts = {}) {
	const res = await run('git', ['-C', dir, ...args], { env: ENV() })
	if (res.code !== 0 && !opts.ok) throw new Error(`git ${args[0]} failed: ${oneLine(res.stderr || res.stdout)}`)
	return res
}

export const hasCommits = async (dir) => (await git(dir, ['rev-parse', '--verify', '-q', 'HEAD'], { ok: true })).code === 0
export const branchOf = async (dir) => (await git(dir, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim()
const inRebase = (dir) => existsSync(join(dir, '.git', 'rebase-merge')) || existsSync(join(dir, '.git', 'rebase-apply'))

const two = (n) => String(n).padStart(2, '0')

/** "2026-11-03 14:02 (+05:30)", in this computer's time zone. */
export function whenLine(now = new Date()) {
	const off = -now.getTimezoneOffset()
	const sign = off < 0 ? '-' : '+'
	const zone = `${sign}${two(Math.floor(Math.abs(off) / 60))}:${two(Math.abs(off) % 60)}`
	return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())} (${zone})`
}

/** The lines under every worker commit: who (the clone's git user), which computer, when, which worker. */
export async function stampLines(dir, now = new Date()) {
	const who = (await git(dir, ['config', 'user.name'], { ok: true })).stdout.trim() || 'Myind worker'
	const host = String(hostname()).split('.')[0] || 'computer'
	return `By: ${who} on ${host} (Myind worker)\nWhen: ${whenLine(now)}\nApp: Myind worker ${VERSION}`
}

/** Stages exactly these paths (a deleted one too) and commits exactly them. Returns the new commit's sha. */
export async function commitPaths(dir, paths, message) {
	const live = []
	for (const p of [...new Set(paths)]) {
		if (existsSync(join(dir, p))) live.push(p)
		else if ((await git(dir, ['ls-files', '--error-unmatch', '--', p], { ok: true })).code === 0) live.push(p)
	}
	if (!live.length) throw new Error('nothing to commit')
	await git(dir, ['add', '--all', '--', ...live])
	const full = /^By: /m.test(message) ? message : `${message.trimEnd()}\n\n${await stampLines(dir)}`
	await git(dir, ['commit', '-q', '-m', full, '--', ...live])
	return (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim()
}

export async function pullRebase(dir) {
	const branch = await branchOf(dir)
	const res = await git(dir, ['pull', '-q', '--rebase', '--autostash', 'origin', branch], { ok: true })
	if (res.code === 0) return { ok: true, conflict: false }
	const conflict = inRebase(dir)
	if (conflict) await git(dir, ['rebase', '--abort'], { ok: true })
	return { ok: false, conflict, error: oneLine(res.stderr || res.stdout) }
}

export async function unpushedCount(dir) {
	const branch = await branchOf(dir)
	const res = await git(dir, ['rev-list', '--count', `origin/${branch}..HEAD`], { ok: true })
	return res.code === 0 ? Number(res.stdout.trim()) : 0
}

/**
 * Another device wrote the same path, so our commit can't be replayed. Pin it on a branch so nothing is lost, and
 * put this clone back on what the remote has. If the job is still in the inbox it's simply done again next run.
 */
async function setAsideConflict(dir) {
	const branch = await branchOf(dir)
	const pin = `myind-conflict/${Date.now()}`
	await git(dir, ['branch', pin])
	await git(dir, ['reset', '--keep', `origin/${branch}`])
	return pin
}

const retryMs = () => (process.env.MYIND_RETRY_MS !== undefined ? Number(process.env.MYIND_RETRY_MS) : 1500)

/** `git pull --rebase` then push, with up to 3 retries. Never throws. */
export async function syncAndPush(dir, retries = 3) {
	let error = ''
	for (let attempt = 0; attempt <= retries; attempt++) {
		if (attempt) await sleep(retryMs() * attempt)
		const pulled = await pullRebase(dir)
		if (pulled.conflict) return { ok: false, conflict: true, pinned: await setAsideConflict(dir), error: pulled.error, attempts: attempt + 1 }
		if (!pulled.ok) {
			error = pulled.error
			continue
		}
		const pushed = await git(dir, ['push', '-q', 'origin', 'HEAD'], { ok: true })
		if (pushed.code === 0) return { ok: true, attempts: attempt + 1 }
		error = oneLine(pushed.stderr || pushed.stdout)
	}
	return { ok: false, conflict: false, error, attempts: retries + 1 }
}
