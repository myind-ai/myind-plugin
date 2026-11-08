// Where the tokens go. Every claude call appends one line to ~/.myind/usage.jsonl: when, which item, what kind of call,
// the model, tokens in/out/cache and the cost claude reported. Local only: it never goes in git, and no prompt or reply
// text is ever written. `report` sums a window of days; the weekly reminder writes it to ~/.myind/reports/.
// On a Claude subscription the cost is what the same tokens would cost on the API: compare weeks, don't read it as a bill.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homeDir } from './config.mjs'

export const usagePath = () => join(homeDir(), 'usage.jsonl')

let label = null
/** What the next calls are for: { id, title, kind } (kind: learn, file, topic). null clears it. */
export function setUsageLabel(next) {
	label = next
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** One row. A logging failure never fails the call it describes. */
export function recordUsage(row) {
	try {
		mkdirSync(homeDir(), { recursive: true })
		appendFileSync(usagePath(), `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`)
	} catch {
		// the read itself worked; losing one log line is fine
	}
}

/** From claude's JSON result (`--output-format json`, or the stream-json `result` row). */
export function recordClaudeResult(outer, { llm = 'claude', chars = 0 } = {}) {
	const u = outer?.usage ?? {}
	recordUsage({
		...(label ?? { kind: 'other' }),
		llm,
		model: Object.keys(outer?.modelUsage ?? {})[0] ?? null,
		input: num(u.input_tokens),
		output: num(u.output_tokens),
		cacheRead: num(u.cache_read_input_tokens),
		cacheWrite: num(u.cache_creation_input_tokens),
		cost: num(outer?.total_cost_usd),
		ms: num(outer?.duration_ms),
		chars,
		ok: !outer?.is_error,
	})
}

export function readUsage() {
	if (!existsSync(usagePath())) return []
	return readFileSync(usagePath(), 'utf8')
		.split('\n')
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line)]
			} catch {
				return []
			}
		})
}

const add = (into, r) => {
	into.calls += 1
	into.input += num(r.input) + num(r.cacheRead) + num(r.cacheWrite)
	into.output += num(r.output)
	into.cost += num(r.cost)
	return into
}
const zero = () => ({ calls: 0, input: 0, output: 0, cost: 0 })

/** Totals for the last `days` days, by kind and by model, and the items that cost most. */
export function summarise(rows, { days = 7, now = Date.now() } = {}) {
	const from = now - days * 86_400_000
	const recent = rows.filter((r) => Date.parse(r.at) >= from)
	const total = recent.reduce(add, zero())
	const byKind = {}
	const byModel = {}
	const byItem = new Map()
	for (const r of recent) {
		add((byKind[r.kind ?? 'other'] ??= zero()), r)
		add((byModel[r.model ?? r.llm ?? 'unknown'] ??= zero()), r)
		const key = r.id ?? `${r.kind}:${r.title}`
		if (!byItem.has(key)) byItem.set(key, { title: r.title ?? r.id ?? '(no title)', kind: r.kind, ...zero() })
		add(byItem.get(key), r)
	}
	const top = [...byItem.values()].sort((a, b) => b.cost - a.cost || b.input - a.input).slice(0, 10)
	return { days, from: new Date(from).toISOString(), ...total, byKind, byModel, top }
}

const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const usd = (n) => `$${n.toFixed(n < 0.01 ? 4 : n < 1 ? 3 : 2)}`
/** Today in the computer's own time zone, YYYY-MM-DD. */
export const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const cell = (s) => String(s).replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 70)

export function reportMarkdown(s, { needsWords = 0, failed = 0, pending = 0, date = localDate() } = {}) {
	const rows = (obj) => Object.entries(obj).sort((a, b) => b[1].cost - a[1].cost).map(([name, v]) => `| ${cell(name)} | ${v.calls} | ${k(v.input)} | ${k(v.output)} | ${usd(v.cost)} |`)
	const head = '| | calls | tokens in | tokens out | cost |\n|---|---|---|---|---|'
	return `# Myind weekly report

Updated: ${date} · last ${s.days} days. Where the worker's Claude tokens went, and what waits for you.
Local file from \`myind-worker report\`; the log is \`~/.myind/usage.jsonl\` (never in git).

## Totals

${s.calls} Claude calls · ${k(s.input)} tokens in · ${k(s.output)} tokens out · ${usd(s.cost)} (API price of the same tokens)

## By kind of work

${s.calls ? `${head}\n${rows(s.byKind).join('\n')}` : 'No Claude calls this week.'}

## By model

${s.calls ? `${head}\n${rows(s.byModel).join('\n')}` : '-'}

## Items that cost most

${s.top.length ? `| item | kind | calls | tokens in | cost |\n|---|---|---|---|---|\n${s.top.map((i) => `| ${cell(i.title)} | ${i.kind ?? ''} | ${i.calls} | ${k(i.input)} | ${usd(i.cost)} |`).join('\n')}` : '-'}

## Waiting for you

- ${needsWords} reels or videos wait for your words (\`myind-worker needs-words\`, or /myind:words in Claude Code)
- ${failed} failed (\`myind-worker status\`)
- ${pending} other jobs in the inbox, waiting for the worker

## Saving tokens

- Short texts (reel captions) go to \`smallModel\` in \`~/.myind/worker.json\`; long ones to \`claudeModel\` (unset = Claude Code's default).
- Topic pages are only rewritten for tags that gained items.
`
}
