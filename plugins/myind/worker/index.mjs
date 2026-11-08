// The index snapshot (storage-format.md, "Index snapshot (2026-11-05)"): one gzipped file of every small text file a
// phone's first pull reads, each with its git blob sha, as a release asset in `myind-index`. A new phone downloads it in
// one request instead of reading thousands of files one by one. It is only a cache: the tree stays the truth, and the
// phone checks every line against its sha and against the tree before using it.
// Built from the worker's own clone (no GitHub API calls), uploaded with the owner's `gh` login.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { homeDir, loadState, saveState } from './config.mjs'
import { git } from './gitops.mjs'
import { oneLine, run, secretsIn } from './util.mjs'

export const INDEX_TAG = 'myind-index'
export const INDEX_SCHEMA = 'myind.index/1'
export const INDEX_NAME = /^index-\d{8}T\d{6}Z-[0-9a-f]{12}\.ndjson\.gz$/
const SMALL = 64 * 1024 // the app reads mail, storage.json, settings.json and devices/ only under this
const MAX_TEXT = 256 * 1024 // longer texts are left out and read normally
const LIBRARY_TEXTS = new Set(['learning.json', 'notes.md', 'meta.json', 'description.md', 'transcript.md', 'transcript.txt', 'article.md'])

/** Whether a phone's pull reads this file (mirrors `pullReadsBlob` in lib/sync/pull_progress.dart, plus library texts). */
export function indexable(path, size) {
	const parts = path.split('/')
	const first = parts[0]
	if (size > MAX_TEXT) return false
	if ((first === 'inbox' || first === 'failed') && path.endsWith('.json')) return true
	if (first === 'files' && parts[1] === 'manifests' && path.endsWith('.json')) return true
	if (first === 'topics' && path.endsWith('.md')) return true
	if (first === 'mail' && parts.length === 4 && path.endsWith('.json')) return size < SMALL
	if (path === 'storage.json' || path === 'settings.json') return size < SMALL
	if (first === 'devices' && parts.length === 2 && path.endsWith('.json')) return size < SMALL
	if (first === 'library' && parts.length === 4) return LIBRARY_TEXTS.has(parts[3])
	return false
}

/** Git's blob sha: sha1 of "blob <length>\0" and the bytes. */
export function gitBlobSha(bytes) {
	return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

const two = (n) => String(n).padStart(2, '0')

/** `index-<yyyymmddThhmmssZ>-<commit12>.ndjson.gz`, in UTC. */
export function indexName(now, commit) {
	const d = now
	const stamp = `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}T${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`
	return `index-${stamp}-${commit.slice(0, 12)}.ndjson.gz`
}

/** Reads many blobs in one `git cat-file --batch`. */
function readBlobs(dir, shas) {
	if (!shas.length) return new Map()
	const r = spawnSync('git', ['-C', dir, 'cat-file', '--batch'], { input: `${shas.join('\n')}\n`, maxBuffer: 2 ** 31 - 1 })
	if (r.status !== 0) throw new Error(`git cat-file failed: ${oneLine(String(r.stderr))}`)
	const out = r.stdout
	const blobs = new Map()
	let at = 0
	while (at < out.length) {
		const nl = out.indexOf(10, at)
		if (nl < 0) break
		const [sha, type, size] = out.subarray(at, nl).toString('utf8').split(' ')
		if (type === 'missing' || size === undefined) {
			at = nl + 1
			continue
		}
		const n = Number(size)
		blobs.set(sha, out.subarray(nl + 1, nl + 1 + n))
		at = nl + 1 + n + 1
	}
	return blobs
}

/** Valid UTF-8 that survives a round trip, so the phone gets the exact bytes back from the JSON string. */
function exactText(bytes) {
	const text = bytes.toString('utf8')
	return Buffer.from(text, 'utf8').equals(bytes) ? text : null
}

/**
 * Builds a snapshot of commit [rev] in the clone [dir]. Returns { name, gz, commit, files, left }:
 * `left` counts indexable files left out (not exact UTF-8, or a secret shape the repo should never hold).
 */
export async function buildIndex(dir, { rev = 'HEAD', now = new Date(), writer = `computer:${String(hostname()).split('.')[0] || 'computer'}` } = {}) {
	const commit = (await git(dir, ['rev-parse', '--verify', `${rev}^{commit}`])).stdout.trim()
	const listing = spawnSync('git', ['-C', dir, 'ls-tree', '-r', '-l', '-z', commit], { maxBuffer: 2 ** 31 - 1 })
	if (listing.status !== 0) throw new Error(`git ls-tree failed: ${oneLine(String(listing.stderr))}`)
	const wanted = []
	for (const row of listing.stdout.toString('utf8').split('\0')) {
		if (!row) continue
		const tab = row.indexOf('\t')
		const [, type, sha, size] = row.slice(0, tab).trim().split(/\s+/)
		const path = row.slice(tab + 1)
		if (type === 'blob' && indexable(path, Number(size))) wanted.push({ path, sha })
	}
	wanted.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
	const blobs = readBlobs(dir, [...new Set(wanted.map((w) => w.sha))])
	const lines = []
	let left = 0
	for (const w of wanted) {
		const bytes = blobs.get(w.sha)
		const text = bytes && gitBlobSha(bytes) === w.sha ? exactText(bytes) : null
		if (text === null || secretsIn(text).length) {
			left++
			continue
		}
		lines.push(JSON.stringify({ p: w.path, s: w.sha, c: text }))
	}
	const header = JSON.stringify({ schema: INDEX_SCHEMA, commit, made: now.toISOString(), files: lines.length, writer })
	const gz = gzipSync(Buffer.from(`${[header, ...lines].join('\n')}\n`, 'utf8'), { level: 9 })
	return { name: indexName(now, commit), gz, commit, files: lines.length, left }
}

async function gh(tools, args, what) {
	if (!tools.gh) throw new Error('gh is not installed')
	const res = await run(tools.gh, args)
	if (res.code !== 0) throw new Error(`${what} failed: ${oneLine(res.stderr || res.stdout)}`)
	return res.stdout
}

/** The snapshot names in the release, newest first; null when there is no release yet. */
export async function listIndexAssets(tools, repo) {
	if (!tools.gh) throw new Error('gh is not installed')
	const res = await run(tools.gh, ['api', `repos/${repo}/releases/tags/${INDEX_TAG}`])
	if (res.code !== 0) return null
	let assets = []
	try {
		assets = JSON.parse(res.stdout).assets ?? []
	} catch {
		assets = []
	}
	return assets.map((a) => String(a.name)).filter((n) => INDEX_NAME.test(n)).sort().reverse()
}

/** Which snapshots to delete so the newest [keep] stay (names sort by time). */
export function toPrune(names, keep = 2) {
	return [...names].filter((n) => INDEX_NAME.test(n)).sort().reverse().slice(keep)
}

/**
 * Uploads [built] to the `myind-index` release (made when missing), then deletes all but the newest [keep]. The new one
 * goes up first, so a phone in the middle of downloading the previous one still finds it. Never touches `myind-blobs-*`.
 */
export async function publishIndex(tools, repo, built, { keep = 2 } = {}) {
	const dir = join(homeDir(), 'work', 'index')
	mkdirSync(dir, { recursive: true })
	const file = join(dir, built.name)
	writeFileSync(file, built.gz)
	try {
		if ((await listIndexAssets(tools, repo)) === null) {
			await gh(tools, ['release', 'create', INDEX_TAG, '--repo', repo, '--prerelease', '--title', INDEX_TAG, '--notes', 'Myind index snapshot: a cache for a new phone. The repository is the truth.'], 'making the index release')
		}
		await gh(tools, ['release', 'upload', INDEX_TAG, file, '--repo', repo, '--clobber'], 'uploading the index snapshot')
		const pruned = []
		for (const name of toPrune((await listIndexAssets(tools, repo)) ?? [], keep)) {
			await gh(tools, ['release', 'delete-asset', INDEX_TAG, name, '--repo', repo, '--yes'], `deleting ${name}`)
			pruned.push(name)
		}
		return { pruned }
	} finally {
		rmSync(file, { force: true })
	}
}

/**
 * Whether a new snapshot is due: with none yet, once the repo holds [every] files; otherwise after [every] changed
 * paths, or after [maxDays] days when anything changed.
 */
export function indexDue({ last, changed, files, now = new Date(), every = 500, maxDays = 7 }) {
	if (!last?.commit) return files >= every
	if (changed >= every) return true
	const age = now.getTime() - Date.parse(last.made ?? 0)
	return changed > 0 && !(age < maxDays * 86400000)
}

/** Paths changed between two commits; Infinity when the old one is gone (a rewritten history). */
export async function changedSince(dir, from, to) {
	const r = await git(dir, ['diff', '--name-only', '--no-renames', from, to], { ok: true })
	return r.code === 0 ? r.stdout.split('\n').filter(Boolean).length : Infinity
}

async function remoteHead(dir) {
	const branch = (await git(dir, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim()
	const r = await git(dir, ['rev-parse', '--verify', '-q', `origin/${branch}`], { ok: true })
	return r.code === 0 ? r.stdout.trim() : (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim()
}

/** Builds and uploads one snapshot of what the remote has, and remembers it in the worker's state. */
export async function runIndex(cfg, tools, log = console.log, now = new Date()) {
	const rev = await remoteHead(cfg.dir)
	const built = await buildIndex(cfg.dir, { rev, now })
	const { pruned } = await publishIndex(tools, cfg.repo, built, { keep: 2 })
	saveState({ ...loadState(), index: { commit: built.commit, made: now.toISOString(), name: built.name, files: built.files } })
	log(`index snapshot ${built.name}: ${built.files} files, ${Math.round(built.gz.length / 1024)} KB${built.left ? `, ${built.left} left out` : ''}${pruned.length ? `, removed ${pruned.length} older` : ''}`)
	return built
}

/** At the end of `once` / `watch`: a snapshot when one is due. `"index": false` in worker.json turns it off. Only warns. */
export async function maybeIndex(ctx, log = console.log) {
	const { cfg, tools } = ctx
	if (cfg.index === false || !tools.gh) return null
	try {
		const head = await remoteHead(cfg.dir)
		const last = loadState().index
		if (last?.commit === head) return null
		const changed = last?.commit ? await changedSince(cfg.dir, last.commit, head) : 0
		const files = last?.commit ? 0 : (await git(cfg.dir, ['ls-tree', '-r', '--name-only', head])).stdout.split('\n').filter(Boolean).length
		const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)
		if (!indexDue({ last, changed, files, every: num(cfg.indexEvery, 500), maxDays: num(cfg.indexMaxDays, 7) })) return null
		return await runIndex(cfg, tools, log)
	} catch (e) {
		ctx.warn(`could not make the index snapshot: ${oneLine(e.message)}`)
		return null
	}
}
