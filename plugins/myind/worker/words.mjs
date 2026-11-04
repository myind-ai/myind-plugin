// A video's words, brought by the owner. Myind never fetches a video's content, so a video link the phone couldn't
// read waits in the inbox as `"needs": "words"` until the owner gives its words: `needs-words` lists those jobs,
// `words <id> <file|->` learns from the words given, and `add <url> --words <file>` does the same for a new link.
// The words are untrusted text like any source: they reach the reader only as data (claude.mjs).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homeDir, loadConfig, takeLock } from './config.mjs'
import { hasCommits, pullRebase, syncAndPush } from './gitops.mjs'
import { parseJob, processParsed } from './process.mjs'
import { context, heartbeat } from './run.mjs'
import { sourceText } from './sources.mjs'
import { itemIdForUrl, normaliseUrl, routeLink } from './url.mjs'
import { oneLine } from './util.mjs'
import { paragraphs, parseVtt, plainText, renderTranscript, seconds } from './vtt.mjs'

export const MAX_WORDS_BYTES = 5 * 1024 * 1024
const ID = /^[0-9a-f]{16}$/

const readJson = (path) => {
	try {
		return JSON.parse(readFileSync(path, 'utf8'))
	} catch {
		return null
	}
}

/** The inbox jobs that wait for the owner's words, oldest first. Reads the clone only. */
export function wordsJobs(repoDir) {
	const dir = join(repoDir, 'inbox')
	if (!existsSync(dir)) return []
	return readdirSync(dir)
		.filter((n) => n.endsWith('.json'))
		.map((n) => readJson(join(dir, n)))
		.filter((j) => j && j.needs === 'words' && ID.test(String(j.id)))
		.map((j) => ({ id: j.id, title: j.title ?? null, url: j.url ?? null, by: j.by ?? null, savedAt: j.createdAt ?? null, reason: j.reason ?? null }))
		.sort((a, b) => String(a.savedAt).localeCompare(String(b.savedAt)))
}

const TIMED_LINE = /^\[?((?:\d{1,2}:)?\d{1,2}:\d{2})\]?\s*[-–:]?\s+(.+)$/
const VTT_TIMING = /^(?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}\s+-->/m

/** Cues from what the owner gave: a .vtt or .srt file, or lines starting with a time ("1:05 …", "[01:05] …"). */
export function cuesOf(text) {
	if (VTT_TIMING.test(text)) return parseVtt(text)
	const cues = []
	for (const raw of text.split('\n')) {
		const m = raw.trim().match(TIMED_LINE)
		if (m) cues.push({ start: seconds(m[1]), line: m[2].trim() })
	}
	return cues.length >= 2 ? cues : []
}

/** "0:00 Intro" lines (as in a video's description) to chapters. */
export function chaptersOf(text) {
	return String(text ?? '')
		.split('\n')
		.map((l) => l.trim().match(TIMED_LINE))
		.filter(Boolean)
		.map((m) => ({ start_time: seconds(m[1]), title: m[2].trim().slice(0, 200) }))
}

/** The owner's words as a "gathered" source (sources.mjs): a timed, chaptered transcript when it can be. */
export function gatherGiven(workDir, text, { title, url, by, type, chapters = [] }) {
	const dir = join(workDir, 'words')
	mkdirSync(dir, { recursive: true })
	const cues = cuesOf(text)
	if (cues.length) {
		const paras = paragraphs(cues, chapters)
		writeFileSync(join(dir, 'transcript.md'), renderTranscript({ title, url, by, kind: 'pasted', paras, chapters, machine: false }))
		writeFileSync(join(dir, 'transcript.txt'), plainText(paras))
	} else {
		writeFileSync(join(dir, 'transcript.md'), `# Transcript: ${title}\n\n${[url, by].filter(Boolean).length ? `Source: ${[url, by].filter(Boolean).join(' · ')}\n\n` : ''}${text.trim()}\n`)
		writeFileSync(join(dir, 'transcript.txt'), `${text.trim().replace(/\s+/g, ' ')}\n`)
	}
	const meta = { title, channel: by || null, source_type: type, saved_at: new Date().toISOString().slice(0, 10), webpage_url: url, chapters: chapters.map((c) => ({ start: Math.floor(c.start_time), title: c.title })), subtitles: { kind: 'pasted' }, words_from: 'owner', video: null }
	writeFileSync(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
	const duration = cues.length ? Math.ceil(cues[cues.length - 1].start) + 60 : null
	return { dir, meta, title, by: by || '', type, sourceLanguage: null, duration, transcriptKind: 'pasted', tags: [], problems: [], videos: [], thumbnail: null, chapters, text: sourceText(dir) }
}

/** The words from a file, or stdin for "-". Text only, at most 5 MB. */
export function readWords(source) {
	const bytes = source === '-' ? readFileSync(0) : readFileSync(source)
	if (bytes.length > MAX_WORDS_BYTES) throw new Error('the words are over 5 MB; give a shorter text')
	if (bytes.includes(0)) throw new Error('that file is not text; give the words as plain text, .vtt or .srt')
	const text = bytes.toString('utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n')
	if (!text.trim()) throw new Error('no words were given')
	return text
}

/**
 * Learns from the owner's words for an inbox job (`id`) or a new link (`url`), exactly as from words pasted on the
 * phone: the reader with no tools, notes, learning.json, related items, one commit, push. The inbox job is cleared in
 * the same commit.
 */
export async function runWords({ id, url, text, title, by, chapters, force = false }, log = console.log) {
	const release = takeLock()
	if (!release) {
		log('another run is in progress; nothing done')
		return { code: 1, busy: true }
	}
	const warnings = []
	try {
		const cfg = loadConfig()
		const ctx = context(cfg, { force }, log, warnings)
		if (!(await hasCommits(cfg.dir))) throw new Error('the repository has no commits yet')
		const pulled = await pullRebase(cfg.dir)
		if (!pulled.ok) throw new Error(`could not pull: ${pulled.error}`)
		let job
		if (id) {
			if (!ID.test(id)) throw new Error('give the 16-letter id that needs-words shows')
			const path = join(cfg.dir, 'inbox', `${id}.json`)
			if (!existsSync(path)) throw new Error(`no job ${id} in the inbox (run needs-words to see them)`)
			job = parseJob(readFileSync(path, 'utf8'), id, ctx.warn)
			if (job.kind !== 'link') throw new Error('that job is a stored file, not a link; its words come from the file itself')
		} else {
			const normal = normaliseUrl(url)
			job = { schema: 'myind.inbox/1', id: itemIdForUrl(normal), kind: 'link', url, normal, title: null, note: null, speechLang: null, createdAt: new Date().toISOString() }
		}
		rmSync(ctx.workDir, { recursive: true, force: true })
		const route = routeLink(job.normal)
		const name = title || job.title || job.normal
		const gathered = gatherGiven(ctx.workDir, text, { title: name, url: job.normal, by: by || job.by || '', type: route.type, chapters: chapters ?? [] })
		const result = await processParsed({ ...ctx, opts: { force } }, { ...job, title: name }, { gathered })
		log(`${result.status} ${job.id} ${oneLine(result.title ?? '', 80)}${result.quality ? ` (${result.quality})` : ''}`)
		await heartbeat(ctx)
		const pushed = await syncAndPush(cfg.dir)
		if (!pushed.ok) log(`warning: not pushed yet: ${pushed.error}`)
		return { code: pushed.ok ? 0 : 1, id: job.id, ...result }
	} finally {
		rmSync(join(homeDir(), 'work', 'job'), { recursive: true, force: true })
		release()
	}
}
