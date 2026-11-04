// Connecting this computer to the owner's brain: which repository, which branch, and the local clone the worker reads
// and writes. git and gh use the owner's own login; no token is ever passed or stored.
import { existsSync, readdirSync } from 'node:fs'
import { branchOf, git } from './gitops.mjs'
import { lastLine, oneLine, run } from './util.mjs'

const BRANCH = /^(?!-)(?!.*\.\.)[\w./-]{1,100}$/

export function checkBranch(name) {
	if (name === undefined || name === true) return null
	if (typeof name !== 'string' || !BRANCH.test(name) || name.endsWith('/') || name.endsWith('.lock')) throw new Error('--branch must be a branch name like main or my-brain')
	return name
}

const remoteUrl = (repo, remote) => (typeof remote === 'string' ? remote : `https://github.com/${repo}.git`)

/** The branches on the remote, and which one is its default. Reads only. */
export async function listBranches({ repo, remote }) {
	const res = await run('git', ['ls-remote', '--symref', remoteUrl(repo, remote), 'HEAD', 'refs/heads/*'], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 60_000 })
	if (res.code !== 0) throw new Error(`could not list branches: ${oneLine(lastLine(res.stderr))}`)
	const lines = res.stdout.split('\n')
	const def = lines.map((l) => l.match(/^ref: refs\/heads\/(\S+)\s+HEAD$/)?.[1]).find(Boolean) ?? null
	const branches = lines.map((l) => l.match(/\trefs\/heads\/(\S+)$/)?.[1]).filter(Boolean).sort()
	return { default: def, branches }
}

/**
 * The clone at `dir`, on `branch` (the remote's default when not given). Clones when there is none; on an existing
 * clone, switches only when nothing is uncommitted, so a switch never loses work.
 */
export async function cloneOrSwitch({ repo, dir, branch, remote, gh }) {
	if (!existsSync(`${dir}/.git`)) {
		if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} exists and is not a git clone`)
		const useGh = gh && typeof remote !== 'string'
		const args = useGh ? ['repo', 'clone', repo, dir, ...(branch ? ['--', '-b', branch] : [])] : ['clone', '-q', ...(branch ? ['-b', branch] : []), remoteUrl(repo, remote), dir]
		const res = await run(useGh ? gh : 'git', args)
		if (res.code !== 0) throw new Error(`clone failed: ${oneLine(lastLine(res.stderr))}${branch ? ` (does branch ${branch} exist? myind-worker branches --repo ${repo})` : ''}`)
		return { cloned: true, branch: branch ?? (await currentBranch(dir)) }
	}
	const now = await currentBranch(dir)
	if (!branch || branch === now) return { cloned: false, branch: now }
	const dirty = (await git(dir, ['status', '--porcelain'])).stdout.trim()
	if (dirty) throw new Error(`the clone at ${dir} has uncommitted changes, so it was not switched to ${branch}. Commit or remove them first`)
	const fetched = await git(dir, ['fetch', '-q', 'origin', branch], { ok: true })
	if (fetched.code !== 0) throw new Error(`branch ${branch} is not on the remote: ${oneLine(fetched.stderr)}`)
	const local = (await git(dir, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { ok: true })).code === 0
	await git(dir, local ? ['switch', '-q', branch] : ['switch', '-q', '-c', branch, '--track', `origin/${branch}`])
	return { cloned: false, branch, switchedFrom: now }
}

async function currentBranch(dir) {
	try {
		return await branchOf(dir)
	} catch {
		return null // an empty repository has no branch yet
	}
}
