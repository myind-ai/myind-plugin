// Subtitles and Whisper output (WebVTT) to a readable transcript: YouTube's rolling duplicate lines removed, lines
// grouped into paragraphs that never cross a chapter start, each paragraph with its moment (a link on YouTube).
// Ported from the youtube-learning skill's yt_learn.py, which was run on real videos.
const TIMING = /^((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})\s+-->/
const TAG = /<[^>]+>/g
const HEADER = /^(WEBVTT|Kind:|Language:|NOTE|STYLE)/

export function seconds(stamp) {
	const parts = String(stamp).replace(',', '.').split(':').map(Number)
	while (parts.length < 3) parts.unshift(0)
	return parts[0] * 3600 + parts[1] * 60 + parts[2]
}

/** Cues as { start, line }, with the rolling repeats of auto captions and the inline word timings removed. */
export function parseVtt(text) {
	const cues = []
	let start = 0
	let recent = []
	for (const raw of String(text ?? '').split('\n')) {
		const line0 = raw.trim()
		const time = line0.match(TIMING)
		if (time) {
			start = seconds(time[1])
			continue
		}
		if (!line0 || HEADER.test(line0) || /^\d+$/.test(line0)) continue
		const line = line0.replace(TAG, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()
		if (!line || recent.includes(line)) continue
		cues.push({ start, line })
		recent = [...recent, line].slice(-3)
	}
	return cues
}

/** `[mm:ss]`, or `[h:mm:ss]` past an hour: the mark the notes and the phone already use. */
export function hms(sec) {
	const s = Math.max(0, Math.floor(Number(sec) || 0))
	const two = (n) => String(n).padStart(2, '0')
	const h = Math.floor(s / 3600)
	return h ? `${h}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}` : `${two(Math.floor(s / 60))}:${two(s % 60)}`
}

/** A link to this moment on YouTube; null elsewhere (other sites have no reliable time links). */
export function timeLink(url, sec) {
	if (!url || !/^https:\/\/(music\.)?youtube\.com\/watch\?v=/.test(url)) return null
	return `${url}&t=${Math.max(0, Math.floor(sec))}s`
}

const cleanChapters = (chapters) =>
	(Array.isArray(chapters) ? chapters : [])
		.filter((c) => c && Number.isFinite(Number(c.start_time)) && typeof c.title === 'string' && c.title.trim())
		.map((c) => ({ start: Number(c.start_time), title: c.title.replace(/\s+/g, ' ').trim().slice(0, 200) }))
		.sort((a, b) => a.start - b.start)

/** Paragraphs of about `every` seconds that never cross a chapter start. */
export function paragraphs(cues, chapters, every = 60) {
	const bounds = cleanChapters(chapters).slice(1).map((c) => c.start)
	const out = []
	for (const { start, line } of cues) {
		const last = out[out.length - 1]
		const chapterBreak = last && bounds.some((b) => last.start < b && b <= start)
		if (!last || chapterBreak || start - last.start >= every) out.push({ start, text: line })
		else last.text += ` ${line}`
	}
	return out
}

const mark = (url, sec) => {
	const link = timeLink(url, sec)
	return link ? `[${hms(sec)}](${link})` : `[${hms(sec)}]`
}

/**
 * transcript.md: a header, a warning when the words are machine-made, then a `##` heading per chapter and one
 * paragraph per minute or so, each starting with its moment.
 */
export function renderTranscript({ title, url, by, kind, key, paras, chapters, machine }) {
	const facts = [url, by, key ? `subtitles: ${key} (${kind})` : kind === 'whisper' ? 'transcribed with Whisper' : null].filter(Boolean)
	const head = [`# Transcript: ${title}`, '', facts.length ? `Source: ${facts.join(' · ')}` : null, '']
	if (machine) head.push(kind === 'whisper' ? '> Machine-generated with Whisper: names and numbers may be misheard.' : '> Machine-generated captions: names, numbers and code may be misheard. Check against the video before quoting.', '')
	const list = cleanChapters(chapters)
	const body = []
	let ci = 0
	for (const p of paras) {
		while (ci < list.length && list[ci].start <= p.start) {
			body.push(`## ${list[ci].title} · ${mark(url, list[ci].start)}`, '')
			ci++
		}
		body.push(`${mark(url, p.start)} ${p.text}`, '')
	}
	return [...head.filter((l) => l !== null), ...body].join('\n')
}

export const plainText = (paras) => `${paras.map((p) => p.text).join(' ')}\n`

/** "## Chapters" for notes.md: the video's own chapter list with its moments. Empty when it has none. */
export function chapterList(url, chapters) {
	const list = cleanChapters(chapters)
	return list.length ? `## Chapters\n\n${list.map((c) => `- ${mark(url, c.start)} ${c.title}`).join('\n')}\n` : ''
}
