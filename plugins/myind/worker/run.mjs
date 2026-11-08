// `once`: pull, process every inbox job, push. `--workpulse` also sends lessons and text to the WorkPulse Brain.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { BlobStore } from './blobs.mjs'
import { commandFor, homeDir, loadConfig, loadState, resolveTools, saveState, takeLock } from './config.mjs'
import { hasCommits, pullRebase, syncAndPush, unpushedCount } from './gitops.mjs'
import { writeHeartbeat } from './heartbeat.mjs'
import { maybeIndex } from './index.mjs'
import { processJob } from './process.mjs'
import { wordsJobs } from './words.mjs'
import { lastLine, oneLine, run } from './util.mjs'

export function inboxStems(repoDir) {
	const dir = join(repoDir, 'inbox')
	if (!existsSync(dir)) return []
	const rows = readdirSync(dir)
		.filter((n) => n.endsWith('.json'))
		.map((n) => {
			const stem = n.slice(0, -5)
			let createdAt = ''
			try {
				createdAt = String(JSON.parse(readFileSync(join(dir, n), 'utf8')).createdAt ?? '')
			} catch {
				// a broken job sorts first and fails cleanly
			}
			return { stem, createdAt }
		})
	return rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.stem < b.stem ? -1 : 1)).map((r) => r.stem)
}

const WP_TYPES = { youtube: 'youtube', instagram: 'instagram', site: 'site', video: 'site', file: 'manual', note: 'manual' }

/** Failure here only warns: the item is safely in the repo either way. */
export async function sendToWorkpulse(ctx, result) {
	const { tools, repoDir, warn } = ctx
	if (!tools.wpBrain) return warn('--workpulse: wp-brain was not found')
	const { cmd, args } = commandFor(tools.wpBrain)
	const { learning, rel } = result
	const type = WP_TYPES[learning.sourceType] ?? 'manual'
	const added = await run(cmd, [...args, 'library', 'add', join(repoDir, rel), '--type', type])
	if (added.code !== 0) warn(`--workpulse: library add failed: ${oneLine(lastLine(added.stderr || added.stdout))}`)
	const library = added.code === 0 ? added.stdout.match(/^library:\s*(.+)$/m)?.[1]?.trim() : undefined
	if (!learning.lessons.length) return
	const source = { type, ...(learning.sourceUrl ? { url: learning.sourceUrl } : {}), title: learning.title, ...(learning.by ? { by: learning.by } : {}), ...(library ? { library } : {}) }
	const entries = learning.lessons.map((l) => ({
		kind: 'learning',
		scope: 'personal',
		project: 'myind',
		title: l.text,
		tags: learning.tags,
		source,
		body: `From "${learning.title}"${learning.by ? ` (${learning.by})` : ''}${learning.sourceUrl ? ` ${learning.sourceUrl}` : ''}${l.at !== undefined ? ` at ${l.at} s` : ''}.`,
	}))
	const res = await run(cmd, [...args, 'add', '--json', '-'], { input: JSON.stringify(entries) })
	if (res.code !== 0) warn(`--workpulse: add failed: ${oneLine(lastLine(res.stderr || res.stdout))}`)
}

export function context(cfg, opts, log, warnings) {
	const tools = resolveTools(cfg)
	const warn = (message) => {
		const line = oneLine(message)
		warnings.push(line)
		log(`warning: ${line}`)
	}
	return { cfg, opts, tools, repoDir: cfg.dir, workDir: join(homeDir(), 'work', 'job'), store: new BlobStore(tools, cfg), warn }
}

/** devices/<computer>.json, so the phone sees this computer. `"heartbeat": false` in worker.json turns it off. Only warns. */
export async function heartbeat(ctx) {
	if (ctx.cfg.heartbeat === false) return
	try {
		const num = (v, d) => (Number.isFinite(Number(v ?? d)) && Number(v ?? d) >= 0 ? Number(v ?? d) : d)
		await writeHeartbeat(ctx.repoDir, { tools: ctx.tools, everyMinutes: num(ctx.cfg.heartbeatMinutes, 30), idleMinutes: num(ctx.cfg.heartbeatIdleMinutes, 720) })
	} catch (e) {
		ctx.warn(`could not write this computer's check-in: ${oneLine(e.message)}`)
	}
}

/** Runs one pass. Resolves with the summary; `code` is non-zero only when the pass itself couldn't complete. */
export async function runOnce(opts = {}, log = console.log) {
	const release = takeLock()
	if (!release) {
		log('another run is in progress; nothing done')
		return { code: 0, busy: true }
	}
	const summary = { startedAt: new Date().toISOString(), done: 0, kept: 0, failed: 0, skipped: 0, pushed: true, warnings: [], code: 0 }
	try {
		const cfg = loadConfig()
		const ctx = context(cfg, opts, log, summary.warnings)
		if (!(await hasCommits(cfg.dir))) {
			log('the repository has no commits yet; nothing to do')
			return summary
		}
		const pulled = await pullRebase(cfg.dir)
		if (!pulled.ok) {
			summary.code = 1
			ctx.warn(`could not pull: ${pulled.error}`)
			return summary
		}
		// Jobs waiting for the owner's words (words.mjs) are never read here, and don't count against --limit.
		const waiting = new Set(wordsJobs(cfg.dir).map((j) => j.id))
		summary.waitingWords = waiting.size
		const stems = inboxStems(cfg.dir).filter((s) => !waiting.has(s))
		const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : stems.length
		let handled = 0
		for (const stem of stems) {
			if (handled >= limit) break
			if (!existsSync(join(cfg.dir, 'inbox', `${stem}.json`))) continue // another device took it since the last pull
			handled++
			let result
			try {
				result = await processJob(ctx, stem)
			} catch (e) {
				summary.failed++
				ctx.warn(`${stem}: could not be finished: ${oneLine(e.message)}`)
				continue
			}
			summary[result.status] = (summary[result.status] ?? 0) + 1
			log(`${result.status} ${stem}${result.title ? ` ${oneLine(result.title, 80)}` : ''}${result.quality ? ` (${result.quality})` : ''}${result.error ? `: ${result.error}` : ''}`)
			if (result.status === 'skipped') continue
			// Pushed after each job, so a long queue reaches the phone as it goes.
			const pushed = await syncAndPush(cfg.dir)
			if (!pushed.ok) ctx.warn(pushed.conflict ? `${stem}: another device changed the same files; the commit was kept on ${pushed.pinned}` : `could not push yet: ${pushed.error}`)
			if (result.status === 'done' && opts.workpulse) await sendToWorkpulse(ctx, result)
		}
		await heartbeat(ctx)
		const left = await unpushedCount(cfg.dir)
		if (left) {
			const pushed = await syncAndPush(cfg.dir)
			if (!pushed.ok) {
				summary.pushed = false
				summary.code = 1
				ctx.warn(`${left} commit(s) not pushed: ${pushed.error}`)
			}
		}
		// A new phone reads one snapshot instead of every file (index.mjs); only of what the remote has.
		if (summary.pushed) await maybeIndex(ctx, log)
		log(`done ${summary.done} · kept ${summary.kept} · failed ${summary.failed} · left in inbox ${summary.skipped}${summary.waitingWords ? ` · waiting for your words ${summary.waitingWords} (myind-worker needs-words)` : ''}`)
		return summary
	} finally {
		summary.finishedAt = new Date().toISOString()
		saveState({ ...loadState(), lastRun: summary })
		release()
	}
}

/** Tools present, and what's waiting, from the local clone only. */
export function statusReport() {
	let cfg = {}
	let setUp = true
	try {
		cfg = loadConfig()
	} catch {
		setUp = false
	}
	const tools = resolveTools(cfg)
	const failed = setUp && existsSync(join(cfg.dir, 'failed')) ? readdirSync(join(cfg.dir, 'failed')).filter((n) => n.endsWith('.json')) : []
	const failures = failed.slice(0, 20).map((n) => {
		try {
			const job = JSON.parse(readFileSync(join(cfg.dir, 'failed', n), 'utf8'))
			return { id: n.slice(0, -5), error: oneLine(job.error ?? '') }
		} catch {
			return { id: n.slice(0, -5), error: 'unreadable' }
		}
	})
	return {
		setUp,
		repo: cfg.repo ?? null,
		dir: cfg.dir ?? null,
		branch: cfg.branch ?? null,
		pending: setUp ? inboxStems(cfg.dir).length : 0,
		needsWords: setUp ? wordsJobs(cfg.dir).length : 0,
		failed: failed.length,
		failures,
		lastRun: loadState().lastRun ?? null,
		tools: { ffmpeg: tools.ffmpeg, whisper: tools.whisper, 'whisper-cli': tools.whisperCpp, claude: tools.claude, gh: tools.gh, 'wp-brain': tools.wpBrain },
	}
}
