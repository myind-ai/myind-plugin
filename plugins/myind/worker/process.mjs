// One inbox job, start to finish. Finishing writes the library folder and removes the inbox file in ONE commit; failing
// moves the job to failed/ in one commit. See storage-format.md.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { readWithClaude } from './claude.mjs'
import { processedByFor } from './llm.mjs'
import { commitPaths, git } from './gitops.mjs'
import { filesIn, findItem, relatedIds } from './library.mjs'
import { extractiveSummary, wordsOf } from './schema.mjs'
import { gatherFile, gatherPage, gatherVideo } from './sources.mjs'
import { itemIdForFile, itemIdForUrl, folderName, normaliseUrl, routeLink } from './url.mjs'
import { Later, NeedsTool, commitSubject, oneLine, redact, secretsIn } from './util.mjs'
import { chapterList } from './vtt.mjs'

const ID = /^[0-9a-f]{16}$/
const SHA = /^[0-9a-f]{64}$/
const COPIED = ['transcript.md', 'transcript.txt', 'article.md', 'description.md', 'meta.json']

export function parseJob(text, stem, warn) {
	let job
	try {
		job = JSON.parse(text)
	} catch {
		throw new Error('the job file is not valid JSON')
	}
	if (!job || typeof job !== 'object' || job.schema !== 'myind.inbox/1') throw new Error('the job file is not myind.inbox/1')
	if (!ID.test(String(job.id)) || job.id !== stem) throw new Error('the job id does not match its file name')
	if (job.kind === 'link') {
		const normal = normaliseUrl(job.url) // throws on anything but http and https
		if (itemIdForUrl(normal) !== job.id) warn(`${stem}: the id is not the hash of its normalised link; keeping the job's id`)
		job.normal = normal
	} else if (job.kind === 'file') {
		if (!SHA.test(String(job.fileSha))) throw new Error('the job has no valid fileSha')
		if (itemIdForFile(job.fileSha) !== job.id) warn(`${stem}: the id is not the hash of its file; keeping the job's id`)
	} else throw new Error(`unknown job kind ${oneLine(job.kind, 20)}`)
	// Goes on a command line as a value; only a language code gets that far.
	if (!/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(String(job.speechLang))) job.speechLang = null
	return job
}

/** Marks in notes become links on YouTube, the one place with reliable time links here. */
function linkTimes(notes, gathered, url) {
	if (gathered.type !== 'youtube' || !url) return notes
	return notes.replace(/\[(?:(\d+):)?(\d{1,2}):(\d{2})\](?!\()/g, (mark, h, m, s) => `${mark}(${url}&t=${Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s)}s)`)
}

function languageOf(gathered) {
	if (gathered.sourceLanguage) return String(gathered.sourceLanguage).split('-')[0]
	const letters = gathered.text.match(/\p{L}/gu)?.length ?? 0
	const devanagari = gathered.text.match(/\p{Script=Devanagari}/gu)?.length ?? 0
	if (letters && devanagari / letters > 0.3) return 'hi'
	return 'und' // the phone reads this as a string, so "undetermined" rather than null
}

function notesFor(learning, body, job) {
	const source = learning.sourceUrl ? `Source: [${learning.by || learning.sourceUrl}](${learning.sourceUrl})\n` : ''
	const note = job.note ? `\nMy note: ${String(job.note).replace(/\s+/g, ' ').trim()}\n` : ''
	return `# ${learning.title}\n\n${source}Saved: ${learning.savedAt.slice(0, 10)} · ${learning.quality} · ${learning.processedBy}\n${note}\n${body.trim()}\n`
}

/** The worker uploads nothing: Myind never downloads videos, and the phone stores your own files. A file job's
 * manifest gains the item it belongs to. */
async function storeBodies(ctx, job, gathered) {
	const files = []
	const writes = new Map()
	if (gathered.manifest) {
		const value = { ...gathered.manifest.value, item: gathered.manifest.value.item ?? job.id }
		files.push({ sha256: value.sha256, role: gathered.fileRole })
		writes.set(gathered.manifest.rel, `${JSON.stringify(value, null, 2)}\n`)
	}
	return { files, writes }
}

/** Refuses text that holds a secret shape. learning.json is the item, so its refusal fails the job; others are dropped. */
function checkText(ctx, job, files) {
	const allowed = new Map()
	for (const [name, content] of files) {
		const hits = typeof content === 'string' ? secretsIn(content) : []
		if (!hits.length) {
			allowed.set(name, content)
			continue
		}
		const message = `refused ${basename(name)}: it looks like it holds a secret (${hits.join(', ')})`
		if (name === 'learning.json' || name.startsWith('files/manifests/')) throw new Error(message)
		ctx.warn(`${job.id}: ${message}`)
	}
	return allowed
}

async function finish(ctx, job, { old, type, folder, files, writes, title }) {
	const rel = `library/${type}/${folder}`
	const texts = checkText(ctx, job, files)
	const extra = checkText(ctx, job, writes)
	const stale = old ? filesIn(ctx.repoDir, old.rel) : []
	for (const path of stale) rmSync(join(ctx.repoDir, path), { recursive: true, force: true })
	const paths = [...stale]
	const put = (path, content) => {
		mkdirSync(dirname(join(ctx.repoDir, path)), { recursive: true })
		writeFileSync(join(ctx.repoDir, path), content)
		paths.push(path)
	}
	for (const [name, content] of texts) put(`${rel}/${name}`, content)
	for (const [path, content] of extra) put(path, content)
	const inbox = `inbox/${job.id}.json`
	const queued = existsSync(join(ctx.repoDir, inbox)) // a link added on the computer has no inbox job
	if (queued) {
		unlinkSync(join(ctx.repoDir, inbox))
		paths.push(inbox)
	}
	try {
		await commitPaths(ctx.repoDir, paths, commitSubject('learn', title, job.id))
	} catch (e) {
		if (queued) await git(ctx.repoDir, ['checkout', '-q', 'HEAD', '--', inbox], { ok: true }) // the job stays in the inbox
		throw e
	}
	return rel
}

/** Moves a job to failed/ in one commit. The text that goes there is cleaned of anything shaped like a secret. */
async function failJob(ctx, stem, rawText, error, code) {
	let job
	try {
		job = JSON.parse(rawText)
	} catch {
		job = { schema: 'myind.inbox/1', id: stem }
	}
	const failedRel = `failed/${stem}.json`
	let earlier = Number(job?.attempts) || 0
	if (existsSync(join(ctx.repoDir, failedRel))) {
		try {
			earlier = Math.max(earlier, Number(JSON.parse(readFileSync(join(ctx.repoDir, failedRel), 'utf8')).attempts) || 0)
		} catch {
			// a broken earlier record counts for nothing
		}
	}
	const record = { ...job, error: oneLine(error), ...(typeof code === 'string' ? { errorCode: code } : {}), failedAt: new Date().toISOString(), failedOn: ctx.cfg.device, attempts: earlier + 1 }
	if (typeof code !== 'string') delete record.errorCode
	const target = join(ctx.repoDir, failedRel)
	mkdirSync(dirname(target), { recursive: true })
	writeFileSync(target, redact(`${JSON.stringify(record, null, 2)}\n`))
	const inbox = `inbox/${stem}.json`
	unlinkSync(join(ctx.repoDir, inbox))
	await commitPaths(ctx.repoDir, [inbox, failedRel], `failed: item ${stem.slice(0, 8)}`)
	return record
}

async function learnFrom(ctx, job, gathered, title, sourceUrl) {
	if (gathered.unread) return { body: { summary: `The file "${gathered.manifest?.value?.name ?? title}" is stored, but ${gathered.unread}.`, lessons: [], tags: [], terms: [], links: [], notes_markdown: `This file is stored but was not read: ${gathered.unread}.` }, quality: 'basic', processedBy: 'pc-local' }
	if (!gathered.text.trim()) throw new Error('no text could be read from this source')
	const source = { title, by: gathered.by, url: sourceUrl, type: gathered.type, duration: gathered.duration, language: ctx.cfg.language, chapters: gathered.chapters }
	const read = await readWithClaude(ctx.tools, ctx.cfg, source, gathered.text)
	if (read.ok) return { body: read.value, quality: 'full', processedBy: processedByFor(ctx.cfg) }
	ctx.warn(`${job.id}: no AI summary (${oneLine(read.error)}); saved picked sentences`)
	return { body: extractiveSummary(gathered.text, { tags: gathered.tags }), quality: 'basic', processedBy: 'pc-local' }
}

/**
 * One parsed job to a library item. `given` is a source already gathered (the owner's words, words.mjs); without it a
 * job marked `"needs": "words"` is never read by the worker itself: it waits for those words.
 */
export async function processParsed(ctx, job, { gathered: given } = {}) {
	if (job.needs === 'words' && !given) return { status: 'waiting' }
	const old = findItem(ctx.repoDir, job.id)
	if (old?.learning?.quality === 'full' && !ctx.opts.force) {
		const inbox = `inbox/${job.id}.json`
		if (!existsSync(join(ctx.repoDir, inbox))) return { status: 'kept', title: old.learning.title }
		unlinkSync(join(ctx.repoDir, inbox))
		await commitPaths(ctx.repoDir, [inbox], commitSubject('learn', `${old.learning.title} (already saved)`, job.id))
		return { status: 'kept', title: old.learning.title }
	}
	const route = job.kind === 'link' ? routeLink(job.normal) : { how: 'file', type: 'file' }
	const gathered = given ?? (route.how === 'video' ? await gatherVideo(ctx, job, route) : route.how === 'page' ? await gatherPage(ctx, job) : await gatherFile(ctx, job))
	for (const problem of gathered.problems) ctx.warn(`${job.id}: ${oneLine(problem)}`)
	const title = job.title || gathered.title || job.normal || job.id
	const sourceUrl = job.normal ?? null
	const { body, quality, processedBy } = await learnFrom(ctx, job, gathered, title, sourceUrl)
	// --force may redo a full item, but a failed read must not take away what's there.
	if (old?.learning?.quality === 'full' && quality !== 'full') throw new Error('could not read it again, so the existing full item was kept')

	const { files: stored, writes } = await storeBodies(ctx, job, gathered)
	const savedAt = old?.learning?.savedAt || job.createdAt || new Date().toISOString()
	const oldFiles = Array.isArray(old?.learning?.files) ? old.learning.files : []
	const learning = {
		schema: 'myind.learning/1',
		id: job.id,
		title,
		by: gathered.by || (sourceUrl ? new URL(sourceUrl).hostname : ''),
		sourceUrl,
		sourceType: gathered.type,
		savedAt,
		language: languageOf(gathered),
		summary: body.summary,
		lessons: body.lessons,
		tags: body.tags,
		terms: body.terms,
		links: body.links,
		related: [],
		quality,
		processedBy,
		transcriptKind: gathered.transcriptKind,
		files: [...new Map([...oldFiles, ...stored].map((f) => [f.sha256, f])).values()],
	}
	// The owner's note and the tags they added are theirs: a new reading keeps them.
	if (typeof old?.learning?.note === 'string' && old.learning.note.trim()) learning.note = old.learning.note
	if (Array.isArray(old?.learning?.tags)) learning.tags = [...new Set([...(learning.tags ?? []), ...old.learning.tags.filter((t) => typeof t === 'string')])].slice(0, 20)
	learning.related = relatedIds(ctx.repoDir, learning)
	const meta = { ...gathered.meta, ...(job.note ? { note: String(job.note) } : {}), ...(gathered.problems.length ? { problems: gathered.problems.map((p) => oneLine(p)) } : {}) }

	const files = new Map()
	for (const name of COPIED) {
		const path = join(gathered.dir, name)
		if (name !== 'meta.json' && existsSync(path)) files.set(name, readFileSync(path, 'utf8'))
	}
	files.set('meta.json', `${JSON.stringify(meta, null, 2)}\n`)
	const chapters = gathered.chapters?.length ? `\n\n${chapterList(sourceUrl, gathered.chapters)}` : ''
	files.set('notes.md', notesFor(learning, `${linkTimes(body.notes_markdown, gathered, sourceUrl)}${chapters}`, job))
	files.set('learning.json', `${JSON.stringify(learning, null, 2)}\n`)
	const folder = old?.type === gathered.type ? old.folder : folderName(savedAt, title, job.id)
	const rel = await finish(ctx, job, { old, type: gathered.type, folder, files, writes, title })
	return { status: 'done', title, quality, rel, learning, gathered: { type: gathered.type }, words: wordsOf(gathered.text).length }
}

/**
 * A job that must wait keeps its inbox file, with `reason` (and `reasonCode`) saying why, so the phone shows "Waiting:
 * no network on the computer" instead of nothing. Committed only when the reason changed, so a long wait adds one
 * commit, not one per run. Never throws: the job is safe in the inbox either way.
 */
async function sayWhyWaiting(ctx, stem, rawText, e) {
	try {
		const job = JSON.parse(rawText)
		const reason = oneLine(e.message, 200)
		if (job.reason === reason && job.reasonCode === e.code) return
		const rel = `inbox/${stem}.json`
		writeFileSync(join(ctx.repoDir, rel), redact(`${JSON.stringify({ ...job, reason, reasonCode: e.code ?? null }, null, 2)}\n`))
		await commitPaths(ctx.repoDir, [rel], `wait: item ${stem.slice(0, 8)}`)
	} catch (err) {
		ctx.warn(`${stem}: could not write why it waits: ${oneLine(err.message)}`)
		await git(ctx.repoDir, ['checkout', '-q', 'HEAD', '--', `inbox/${stem}.json`], { ok: true })
	}
}

/** Runs one job. Never throws for the job's own problems: one bad job must not stop the others. */
export async function processJob(ctx, stem) {
	const inboxPath = join(ctx.repoDir, 'inbox', `${stem}.json`)
	const rawText = readFileSync(inboxPath, 'utf8')
	rmSync(ctx.workDir, { recursive: true, force: true })
	mkdirSync(ctx.workDir, { recursive: true })
	try {
		return await processParsed(ctx, parseJob(rawText, stem, ctx.warn))
	} catch (e) {
		if (e instanceof NeedsTool) {
			ctx.warn(`${stem}: left in the inbox: ${e.message}`)
			if (e instanceof Later) await sayWhyWaiting(ctx, stem, rawText, e)
			return { status: 'skipped' }
		}
		if (!existsSync(inboxPath)) throw e
		const record = await failJob(ctx, stem, rawText, e.message, e.code)
		return { status: 'failed', error: record.error }
	} finally {
		rmSync(ctx.workDir, { recursive: true, force: true })
	}
}
