// Reading items in the clone, and `related`: shared-term scoring over learning.json, no AI.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { wordsOf } from './schema.mjs'

function dirsIn(path) {
	try {
		return readdirSync(path).filter((n) => statSync(join(path, n)).isDirectory())
	} catch {
		return []
	}
}

function readLearning(path) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'))
	} catch {
		return null
	}
}

/** Every item: { type, folder, rel, learning } (learning is null when the file is missing or broken). */
export function listItems(repoDir) {
	const items = []
	const root = join(repoDir, 'library')
	for (const type of dirsIn(root)) {
		for (const folder of dirsIn(join(root, type))) items.push({ type, folder, rel: `library/${type}/${folder}`, learning: readLearning(join(root, type, folder, 'learning.json')) })
	}
	return items
}

/** An item is found by its `_<id8>` suffix; when learning.json is there it must name the same id. */
export function findItem(repoDir, id) {
	const suffix = `_${id.slice(0, 8)}`
	return listItems(repoDir).find((it) => it.folder.endsWith(suffix) && (!it.learning?.id || it.learning.id === id)) ?? null
}

export const filesIn = (repoDir, rel) => {
	try {
		return readdirSync(join(repoDir, rel)).map((n) => `${rel}/${n}`)
	} catch {
		return []
	}
}

const STOP = new Set('the and for with this that from your you are was were have has had not but about into over how what when why who which will can its their they them then than there here more most very also just one two out use using used video post reel'.split(' '))
const usable = (w) => [...w].length >= 3 && !STOP.has(w)

/** term -> weight. A tag, a term or a word of the title says more about a subject than a word of the text. */
function termsOf(learning) {
	const weights = new Map()
	const add = (text, weight) => {
		for (const w of wordsOf(text)) if (usable(w)) weights.set(w, Math.max(weights.get(w) ?? 0, weight))
	}
	add(learning.summary, 1)
	for (const l of learning.lessons ?? []) add(l.text, 1)
	add(learning.title, 3)
	for (const t of learning.tags ?? []) add(String(t).replace(/-/g, ' '), 3)
	for (const t of learning.terms ?? []) add(t.term, 3)
	return weights
}

const MIN_SCORE = 3
const MAX_RELATED = 5

/** Ids of the items most like this one: the score is the shared terms' smaller weights added up. */
export function relatedIds(repoDir, learning) {
	const mine = termsOf(learning)
	const scored = []
	for (const { learning: other } of listItems(repoDir)) {
		if (!other?.id || other.id === learning.id) continue
		let score = 0
		for (const [term, weight] of termsOf(other)) if (mine.has(term)) score += Math.min(weight, mine.get(term))
		if (score >= MIN_SCORE) scored.push({ id: other.id, score })
	}
	return scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)).slice(0, MAX_RELATED).map((x) => x.id)
}
