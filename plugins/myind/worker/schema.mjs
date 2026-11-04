// Strict checks on what comes back from Claude (it read untrusted text, so its output is untrusted too), and the
// non-AI summary used when Claude can't be used. Nothing here ever runs anything from the text.
const TOP_KEYS = ['summary', 'lessons', 'tags', 'terms', 'links', 'notes_markdown']
const TAG = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}-]*$/u
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isText = (v) => typeof v === 'string' && v.trim().length > 0
const LIMITS = { summary: 6000, lessons: 60, lessonText: 500, tags: 20, tag: 40, terms: 60, term: 120, meaning: 500, links: 60, notes: 300_000 }

export function validateLearning(obj, { duration } = {}) {
	const bad = (error) => ({ ok: false, error })
	if (!isObject(obj)) return bad('not a JSON object')
	const unknown = Object.keys(obj).filter((k) => !TOP_KEYS.includes(k))
	if (unknown.length) return bad(`unexpected field ${unknown[0]}`)
	const missing = TOP_KEYS.find((k) => !(k in obj))
	if (missing) return bad(`missing field ${missing}`)
	if (!isText(obj.summary) || obj.summary.length > LIMITS.summary) return bad('summary must be text under the limit')
	if (!isText(obj.notes_markdown) || obj.notes_markdown.length > LIMITS.notes) return bad('notes_markdown must be text under the limit')
	if (!Array.isArray(obj.lessons) || !obj.lessons.length || obj.lessons.length > LIMITS.lessons) return bad('lessons must be a list of 1 to 60')
	const lessons = []
	for (const l of obj.lessons) {
		if (!isObject(l) || Object.keys(l).some((k) => k !== 'text' && k !== 'at')) return bad('a lesson must have only text and at')
		if (!isText(l.text) || l.text.length > LIMITS.lessonText || /[\r\n]/.test(l.text.trim())) return bad('a lesson must be one line of text')
		if (l.at !== undefined && l.at !== null && !(Number.isFinite(l.at) && l.at >= 0)) return bad('at must be seconds')
		const row = { text: l.text.trim() }
		// A moment past the end of the video is a wrong guess: keep the lesson, drop the moment.
		if (Number.isFinite(l.at) && !(duration && l.at > duration + 5)) row.at = Math.floor(l.at)
		lessons.push(row)
	}
	if (!Array.isArray(obj.tags) || obj.tags.length > LIMITS.tags) return bad('tags must be a list of at most 20')
	const tags = []
	for (const t of obj.tags) {
		if (!isText(t)) return bad('a tag must be text')
		const tag = t.trim().toLowerCase().replace(/[\s_]+/g, '-')
		if (!TAG.test(tag) || tag.length > LIMITS.tag) return bad('a tag must be a lower-case word')
		if (!tags.includes(tag)) tags.push(tag)
	}
	if (!Array.isArray(obj.terms) || obj.terms.length > LIMITS.terms) return bad('terms must be a list of at most 60')
	const terms = []
	for (const t of obj.terms) {
		if (!isObject(t) || Object.keys(t).some((k) => k !== 'term' && k !== 'meaning')) return bad('a term must have only term and meaning')
		if (!isText(t.term) || !isText(t.meaning) || t.term.length > LIMITS.term || t.meaning.length > LIMITS.meaning) return bad('a term needs a term and a meaning')
		terms.push({ term: t.term.trim(), meaning: t.meaning.trim() })
	}
	if (!Array.isArray(obj.links) || obj.links.length > LIMITS.links) return bad('links must be a list of at most 60')
	const links = []
	for (const link of obj.links) {
		if (!isText(link) || !isHttp(link)) return bad('a link must be an http or https address')
		if (!links.includes(link.trim())) links.push(link.trim())
	}
	return { ok: true, value: { summary: obj.summary.trim(), lessons, tags, terms, links, notes_markdown: obj.notes_markdown.trim() } }
}

function isHttp(text) {
	try {
		return ['http:', 'https:'].includes(new URL(text.trim()).protocol)
	} catch {
		return false
	}
}

/** JSON from a model's reply: the whole reply, or the part inside a code fence or between the outer braces. */
export function parseJsonReply(reply) {
	const text = String(reply ?? '').trim()
	const fence = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/)
	const tries = [fence?.[1], text]
	const open = text.indexOf('{')
	const close = text.lastIndexOf('}')
	if (open >= 0 && close > open) tries.push(text.slice(open, close + 1))
	for (const t of tries) {
		if (t === undefined) continue
		try {
			return JSON.parse(t)
		} catch {
			// next
		}
	}
	return undefined
}

const STOP = new Set(
	'the a an and or but of to in on for with is are was were be been it its this that these those as at by from you your i we our they their he she his her so if not no do does did have has had will would can could should about into over just than then there here what when where which who how why me my more most very also out up down'.split(
		' ',
	),
)
export const wordsOf = (text) => String(text ?? '').toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []
const STAMP = /^\[(\d+):(\d{2})(?::(\d{2}))?\]\s*/

/** Sentences of the source, each with the moment it was said when the line starts with [mm:ss]. */
function sentencesOf(text) {
	const out = []
	for (const raw of String(text).split('\n')) {
		let line = raw.trim()
		if (!line || line.startsWith('#') || line.startsWith('>')) continue
		const stamp = line.match(STAMP)
		let at
		if (stamp) {
			at = stamp[3] === undefined ? Number(stamp[1]) * 60 + Number(stamp[2]) : Number(stamp[1]) * 3600 + Number(stamp[2]) * 60 + Number(stamp[3])
			line = line.replace(STAMP, '')
		}
		for (const s of line.split(/(?<=[.!?।॥])\s+/u)) {
			const text = s.trim()
			if (text.length >= 20) out.push({ text: [...text].slice(0, 300).join(''), at, i: out.length })
		}
	}
	return out
}

/** A summary with no AI: the sentences that use the source's most frequent words. Marked basic / pc-local by the caller. */
export function extractiveSummary(text, { tags = [] } = {}) {
	const sentences = sentencesOf(text)
	const freq = new Map()
	for (const w of wordsOf(text)) if (w.length > 2 && !STOP.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1)
	const scored = sentences.map((s) => {
		const words = wordsOf(s.text)
		const score = words.reduce((sum, w) => sum + (freq.get(w) ?? 0), 0) / Math.max(words.length, 4)
		return { ...s, score }
	})
	const top = [...scored].sort((a, b) => b.score - a.score || a.i - b.i).slice(0, 5).sort((a, b) => a.i - b.i)
	const picked = top.length ? top : [{ text: [...String(text).trim().replace(/\s+/g, ' ')].slice(0, 300).join('') }]
	const links = [...new Set(String(text).match(/https?:\/\/[^\s)>\]"']+/g) ?? [])].slice(0, 20)
	const cleanTags = [...new Set(tags.map((t) => String(t).trim().toLowerCase().replace(/[\s_]+/g, '-')).filter((t) => TAG.test(t) && t.length <= LIMITS.tag))].slice(0, 10)
	const lessons = picked.map((s) => (s.at === undefined ? { text: s.text } : { text: s.text, at: s.at }))
	const notes = ['Picked sentences; no AI has read this yet.', '', ...lessons.map((l) => `- ${l.text}`)].join('\n')
	return { summary: picked.slice(0, 3).map((s) => s.text).join(' '), lessons, tags: cleanTags, terms: [], links, notes_markdown: notes }
}
