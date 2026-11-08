// `evolve`: topics/<slug>.md for tags that gained items since their page was last updated. The page ends with a marker
// listing the items it has taken in, so "gained" is a set difference rather than a clock comparison.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { askClaude, wrap } from './claude.mjs'
import { setUsageLabel } from './usage.mjs'
import { loadConfig, resolveTools, takeLock } from './config.mjs'
import { commitPaths, hasCommits, pullRebase, syncAndPush } from './gitops.mjs'
import { listItems } from './library.mjs'
import { parseJsonReply } from './schema.mjs'
import { commitSubject, oneLine, secretsIn } from './util.mjs'

const MARKER = /<!-- myind-topic (\{.*\}) -->\s*$/
const SOURCES_HEADING = '\n## Sources\n'
const TAG = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}-]*$/u
const MAX_BATCH_CHARS = 200_000

export function topicSlug(tag) {
	return /^[a-z0-9-]+$/.test(tag) ? tag.slice(0, 50).replace(/-+$/, '') || 'topic' : `topic-${createHash('sha256').update(tag).digest('hex').slice(0, 8)}`
}

function readPage(path) {
	if (!existsSync(path)) return { body: '', items: [], exists: false }
	const text = readFileSync(path, 'utf8')
	let items = []
	try {
		items = JSON.parse(text.match(MARKER)?.[1] ?? '{}').items ?? []
	} catch {
		// an edited marker means the page takes everything in again
	}
	const cut = text.lastIndexOf(SOURCES_HEADING)
	return { body: (cut >= 0 ? text.slice(0, cut) : text).trim(), items, exists: true }
}

/** Tags with at least minItems items, each with the items its page hasn't seen. */
export function tagsThatGrew(repoDir, minItems = 2) {
	const byTag = new Map()
	for (const item of listItems(repoDir)) {
		if (!item.learning?.id) continue
		for (const tag of item.learning.tags ?? []) {
			if (typeof tag !== 'string' || !TAG.test(tag)) continue
			if (!byTag.has(tag)) byTag.set(tag, [])
			byTag.get(tag).push(item)
		}
	}
	const out = []
	for (const [tag, items] of [...byTag].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
		if (items.length < minItems) continue
		const slug = topicSlug(tag)
		const rel = `topics/${slug}.md`
		const page = readPage(join(repoDir, rel))
		const fresh = items.filter((it) => !page.items.includes(it.learning.id))
		if (fresh.length) out.push({ tag, slug, rel, page, items, fresh })
	}
	return out
}

const refOf = (item) => item.learning.id.slice(0, 8)
const linkTo = (item) => `[${String(item.learning.title).replace(/[[\]\n]/g, ' ')}](../${item.rel}/notes.md)`

function batches(items) {
	const groups = [[]]
	let size = 0
	for (const item of items) {
		const row = { ref: refOf(item), title: item.learning.title, by: item.learning.by, summary: item.learning.summary, lessons: item.learning.lessons, terms: item.learning.terms }
		const length = JSON.stringify(row).length
		if (size + length > MAX_BATCH_CHARS && groups[groups.length - 1].length) {
			groups.push([])
			size = 0
		}
		groups[groups.length - 1].push(row)
		size += length
	}
	return groups
}

/** A reply is usable only as {"markdown": ...} that cites at least one given item and no item it wasn't given. */
export function checkTopicReply(text, refs) {
	const parsed = parseJsonReply(text)
	if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).join() !== 'markdown' || typeof parsed.markdown !== 'string' || !parsed.markdown.trim()) return { ok: false, error: 'not the expected JSON' }
	if (parsed.markdown.length > 200_000) return { ok: false, error: 'too long' }
	const cited = [...parsed.markdown.matchAll(/\[([0-9a-f]{8})\]/g)].map((m) => m[1])
	if (!cited.length) return { ok: false, error: 'it cites no item' }
	const unknown = cited.find((c) => !refs.includes(c))
	if (unknown) return { ok: false, error: 'it cites an item it was not given' }
	return { ok: true, markdown: parsed.markdown.trim() }
}

async function writeWithClaude(tools, cfg, topic) {
	setUsageLabel({ title: topic.tag, kind: 'topic' })
	let body = topic.page.body
	const byRef = new Map(topic.items.map((it) => [refOf(it), it]))
	for (const group of batches(topic.page.exists ? topic.fresh : topic.items)) {
		const refs = group.map((r) => r.ref)
		const prompt = `Write the page on the subject "${topic.tag}" for a person's private notes, in ${cfg.language || 'English'}, ${body ? 'by updating the existing page with the new items, keeping what is still true' : 'from these items'}. Organise by idea rather than by source. Cite every fact by writing the item's ref in square brackets, like [${refs[0]}]; cite only refs given in the items.\nReturn exactly this JSON and nothing else: {"markdown": "the page, starting at a # heading"}\n\nThe existing page and the items:\n${wrap(JSON.stringify({ subject: topic.tag, existing_page: body, items: group }, null, 1))}\n`
		let checked = { ok: false, error: '' }
		for (let attempt = 0; attempt < 2 && !checked.ok; attempt++) {
			const reply = await askClaude(tools, cfg, attempt ? `${prompt}\nYour previous reply was rejected (${checked.error}). Reply with only the JSON object.\n` : prompt)
			checked = reply.ok ? checkTopicReply(reply.text, refs) : { ok: false, error: reply.error }
		}
		if (!checked.ok) return checked
		body = checked.markdown.replace(/\[([0-9a-f]{8})\]/g, (mark, ref) => (byRef.has(ref) ? `(${linkTo(byRef.get(ref))})` : mark))
	}
	return { ok: true, body }
}

function basicPage(topic) {
	const rows = topic.items.flatMap((it) => (it.learning.lessons ?? []).slice(0, 3).map((l) => `- ${String(l.text).replace(/\s+/g, ' ')} (${linkTo(it)})`))
	return `# ${topic.tag}\n\nPicked from the saved items; no AI has written this yet.\n\n${rows.join('\n')}`
}

function renderPage(topic, body, itemIds) {
	const sources = topic.items.map((it) => `- ${linkTo(it)}`).join('\n')
	return `${body.trim()}\n${SOURCES_HEADING}\n${sources}\n\n<!-- myind-topic ${JSON.stringify({ tag: topic.tag, updated: new Date().toISOString().slice(0, 10), items: itemIds })} -->\n`
}

export async function runEvolve(opts = {}, log = console.log) {
	const release = takeLock()
	if (!release) {
		log('another run is in progress; nothing done')
		return { code: 0, busy: true }
	}
	const summary = { code: 0, written: 0, basic: 0, skipped: 0 }
	try {
		const cfg = loadConfig()
		const tools = resolveTools(cfg)
		if (!(await hasCommits(cfg.dir))) return summary
		const pulled = await pullRebase(cfg.dir)
		if (!pulled.ok) {
			log(`could not pull: ${pulled.error}`)
			return { ...summary, code: 1 }
		}
		const topics = tagsThatGrew(cfg.dir, opts.minItems ?? 2).slice(0, opts.limit > 0 ? opts.limit : undefined)
		for (const topic of topics) {
			const written = await writeWithClaude(tools, cfg, topic)
			let text
			if (written.ok) {
				text = renderPage(topic, written.body, topic.items.map((it) => it.learning.id))
			} else if (!topic.page.exists) {
				// The marker lists no items, so the next run with Claude available writes the real page.
				log(`warning: ${topic.tag}: no AI page (${oneLine(written.error)}); saved a list of lessons`)
				text = renderPage(topic, basicPage(topic), [])
				summary.basic++
			} else {
				log(`warning: ${topic.tag}: left as it is (${oneLine(written.error)})`)
				summary.skipped++
				continue
			}
			const hits = secretsIn(text)
			if (hits.length) {
				log(`warning: refused ${topic.rel}: it looks like it holds a secret (${hits.join(', ')})`)
				summary.skipped++
				continue
			}
			const target = join(cfg.dir, topic.rel)
			if (existsSync(target) && readFileSync(target, 'utf8') === text) continue
			mkdirSync(join(cfg.dir, 'topics'), { recursive: true })
			writeFileSync(target, text)
			await commitPaths(cfg.dir, [topic.rel], commitSubject('topic', topic.tag, topic.slug))
			if (written.ok) summary.written++
			log(`topic ${topic.rel} (${topic.fresh.length} new)`)
		}
		if (summary.written || summary.basic) {
			const pushed = await syncAndPush(cfg.dir)
			if (!pushed.ok) {
				log(`warning: could not push: ${pushed.error}`)
				summary.code = 1
			}
		}
		log(`topics written ${summary.written} · lists ${summary.basic} · left ${summary.skipped}`)
		return summary
	} finally {
		release()
	}
}
