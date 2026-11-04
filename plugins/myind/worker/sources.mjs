// Getting a source's text: words the owner saved for a video link (on the phone, or with `myind-worker words`),
// `wp-brain learn` for pages, Whisper or Claude for a stored file. Myind never fetches a video's content. Each returns a "gathered" object; nothing here touches the clone.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { readFileWithClaude } from './claude.mjs'
import { commandFor } from './config.mjs'
import { findItem } from './library.mjs'
import { manifestPath } from './media.mjs'
import { JobError, NeedsTool, lastLine, oneLine, run } from './util.mjs'
import { paragraphs, plainText, renderTranscript } from './vtt.mjs'
import { transcribeToCues } from './whisper.mjs'

const readText = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '')
const readJson = (path) => {
	try {
		return JSON.parse(readFileSync(path, 'utf8'))
	} catch {
		return {}
	}
}
const jsonLines = (stdout) =>
	stdout.split('\n').flatMap((l) => {
		try {
			const row = JSON.parse(l)
			return row && typeof row === 'object' ? [row] : []
		} catch {
			return []
		}
	})

/**
 * A video link (YouTube, Instagram, others): Myind never fetches it (their terms forbid automated collection). It is
 * read only from words the owner brought: pasted on the phone, written by Gemini from a public YouTube link with the
 * owner's own key, or given on the computer with `myind-worker words`. Those sit in the item's folder. With none, the job
 * fails saying what to do (`needs-words`).
 */
export async function gatherVideo(ctx, job, route) {
	const old = findItem(ctx.repoDir, job.id)
	const dir = old ? join(ctx.repoDir, old.rel) : null
	const text = dir ? sourceText(dir) : ''
	if (dir && text.trim()) return gatherWords(old, dir, text, route)
	throw new JobError(NO_WORDS, 'needs-words')
}

function gatherWords(old, dir, text, route) {
	const learning = old.learning ?? {}
	const meta = readJson(join(dir, 'meta.json'))
	return {
		dir,
		meta,
		title: learning.title || meta.title || '',
		by: learning.by || meta.channel || '',
		type: route.type,
		sourceLanguage: learning.language || meta.language || null,
		duration: null,
		transcriptKind: typeof learning.transcriptKind === 'string' ? learning.transcriptKind : 'none',
		tags: Array.isArray(meta.tags) ? meta.tags : [],
		problems: [],
		videos: [],
		thumbnail: null,
		text,
	}
}

export const NO_WORDS = "Myind doesn't download videos from links. In the app, paste what the video says, or share the video file if you have it."

export async function gatherPage(ctx, job) {
	const { tools, workDir } = ctx
	if (!tools.wpBrain) throw new NeedsTool('wp-brain was not found: set MYIND_WP_BRAIN or wpBrain in worker.json')
	const { cmd, args } = commandFor(tools.wpBrain)
	const res = await run(cmd, [...args, 'learn', new URL(job.url.trim()).href, '--root', join(workDir, 'page')], { timeoutMs: 120_000 })
	const row = jsonLines(res.stdout).find((r) => r.folder)
	if (res.code !== 0 || !row) throw new Error(lastLine(res.stderr) || lastLine(res.stdout) || 'wp-brain gave no result')
	const meta = readJson(join(row.folder, 'meta.json'))
	return { dir: row.folder, meta, title: meta.title || row.title, by: meta.channel || '', type: 'site', sourceLanguage: null, duration: null, transcriptKind: 'none', tags: [], problems: row.problems ?? [], videos: [], thumbnail: null, text: sourceText(row.folder) }
}

/** Everything Claude should read, whole: the caption or description, then the words of the source. */
export function sourceText(dir) {
	const description = readText(join(dir, 'description.md'))
	const body = readText(join(dir, 'transcript.md')) || readText(join(dir, 'article.md'))
	const hasDescription = description.replace(/^# .*$/m, '').trim() && description.replace(/^# .*$/m, '').trim() !== '(none)'
	// The links on the timestamps are all the same video; the marks stay, the URLs are noise.
	const compact = body.replace(/\[(\d+:\d{2}(?::\d{2})?)\]\(https?:[^)\s]*\)/g, '[$1]')
	return [hasDescription ? description.trim() : '', compact.trim()].filter(Boolean).join('\n\n')
}

const AUDIO_VIDEO = /^(audio|video)\//
const TEXTUAL = /^text\/|^application\/(json|xml|x-yaml|yaml)$/
const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.log', '.yaml', '.yml', '.html', '.xml'])
const IMAGES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' }
const MAX_TEXT_BYTES = 50 * 1024 * 1024
const MAX_PDF_BYTES = 20 * 1024 * 1024
const MAX_IMAGE_BYTES = 3 * 1024 * 1024

/** Audio or video to a timed transcript with Whisper. */
async function transcribe(ctx, job, path, dir, manifest) {
	const cues = await transcribeToCues(ctx, path, join(dir, 'whisper'), { lang: job.speechLang })
	const paras = paragraphs(cues, [])
	writeFileSync(join(dir, 'transcript.md'), renderTranscript({ title: manifest.name, kind: 'whisper', paras, machine: true }))
	writeFileSync(join(dir, 'transcript.txt'), plainText(paras))
}

/** An image small enough to attach, converted when Claude can't take its format. Null when it can't be done. */
async function attachableImage(ctx, path, mime, dir) {
	const { tools } = ctx
	if (IMAGES[mime] && statSync(path).size <= MAX_IMAGE_BYTES) return { path, mime }
	const dest = join(dir, 'attach.jpg')
	if (tools.sips) await run(tools.sips, ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', '-Z', '1568', path, '--out', dest])
	else if (tools.ffmpeg) await run(tools.ffmpeg, ['-y', '-v', 'error', '-i', path, '-vf', "scale='min(1568,iw)':-2", '-frames:v', '1', '-q:v', '4', dest])
	return existsSync(dest) && statSync(dest).size <= MAX_IMAGE_BYTES ? { path: dest, mime: 'image/jpeg' } : null
}

async function readImageOrPdf(ctx, path, mime, dir, manifest) {
	let attach
	if (mime === 'application/pdf') attach = statSync(path).size <= MAX_PDF_BYTES ? { path, mime } : null
	else attach = await attachableImage(ctx, path, mime, dir)
	if (!attach) return 'it is too large to send for reading'
	if (!ctx.tools.claude) return 'reading it needs claude, which is not installed'
	const read = await readFileWithClaude(ctx.tools, ctx.cfg, attach)
	if (!read.ok) return `it could not be read (${read.error})`
	writeFileSync(join(dir, 'description.md'), `# Description: ${manifest.name}\n\n${read.value.description}\n`)
	if (read.value.text.trim()) writeFileSync(join(dir, 'article.md'), `# ${manifest.name}\n\n${read.value.text.trim()}\n`)
	return null
}

/** A stored file: fetch its parts, then read it however its type allows. `unread` says why when it can't be. */
export async function gatherFile(ctx, job) {
	const { store, repoDir, workDir } = ctx
	const relManifest = manifestPath(job.fileSha)
	if (!existsSync(join(repoDir, relManifest))) throw new Error('its file manifest is not in the repository')
	const manifest = JSON.parse(readFileSync(join(repoDir, relManifest), 'utf8'))
	if (manifest.sha256 !== job.fileSha) throw new Error('the manifest names a different file')
	const dir = join(workDir, 'file')
	mkdirSync(dir, { recursive: true })
	const ext = extname(String(manifest.name ?? '')).toLowerCase().replace(/[^.a-z0-9]/g, '')
	const body = join(dir, `body${ext}`)
	await store.get(manifest, body)

	const mime = String(manifest.mime ?? '').toLowerCase()
	const kind = manifest.kind
	let unread = null
	let transcriptKind = 'none'
	if (AUDIO_VIDEO.test(mime) || kind === 'audio' || kind === 'video') {
		await transcribe(ctx, job, body, dir, manifest)
		transcriptKind = 'whisper'
	} else if (TEXTUAL.test(mime) || TEXT_EXT.has(ext)) {
		const size = statSync(body).size
		const bytes = size <= MAX_TEXT_BYTES ? readFileSync(body) : null
		if (!bytes) unread = 'it is over 50 MB of text'
		else if (bytes.includes(0)) unread = 'it holds binary data, not text'
		else writeFileSync(join(dir, 'article.md'), `# ${manifest.name}\n\n${bytes.toString('utf8')}\n`)
	} else if (mime.startsWith('image/') || mime === 'application/pdf' || kind === 'photo') {
		unread = await readImageOrPdf(ctx, body, mime || 'image/jpeg', dir, manifest)
	} else {
		unread = `this worker has no reader for ${oneLine(mime || ext || 'this type', 60)}`
	}
	const meta = { id: job.id, title: manifest.name, channel: null, source_type: 'file', saved_at: new Date().toISOString().slice(0, 10), subtitles: { kind: transcriptKind }, video: null, file: { sha256: manifest.sha256, name: manifest.name, mime: manifest.mime, size: manifest.size } }
	writeFileSync(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
	return {
		dir,
		meta,
		title: manifest.description || manifest.name,
		by: '',
		type: 'file',
		sourceLanguage: null,
		duration: manifest.durationSec ?? null,
		transcriptKind,
		tags: Array.isArray(manifest.tags) ? manifest.tags : [],
		problems: [],
		videos: [],
		thumbnail: null,
		text: sourceText(dir),
		unread,
		fileRole: kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : 'file',
		manifest: { rel: relManifest, value: manifest },
	}
}
