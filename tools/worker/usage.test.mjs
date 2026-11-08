// Where the tokens go: every claude call is logged to ~/.myind/usage.jsonl (local, never git), `report` sums a week,
// and short texts go to `smallModel`. A fake claude stands in for the real one, so this proves the plumbing, not a model.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { askClaude, readWithClaude } from '../../plugins/myind/worker/claude.mjs'
import { reminderPlist } from '../../plugins/myind/worker/service.mjs'
import { readUsage, recordUsage, reportMarkdown, setUsageLabel, summarise, usagePath } from '../../plugins/myind/worker/usage.mjs'

const REPLY = { summary: 'About bread.', lessons: [{ text: 'Knead for ten minutes.' }], tags: ['bread'], terms: [], links: [], notes_markdown: '## In one paragraph\nBread.' }

function world(t) {
	const dir = mkdtempSync(join(tmpdir(), 'myind-usage-'))
	process.env.MYIND_HOME = join(dir, 'home')
	const log = join(dir, 'argv.log')
	const claude = join(dir, 'claude')
	const outer = { type: 'result', is_error: false, result: JSON.stringify(REPLY), total_cost_usd: 0.0123, duration_ms: 900, usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 }, modelUsage: { 'claude-sonnet-5-5': {} } }
	writeFileSync(claude, `#!/bin/sh\necho "$@" >> '${log}'\ncat > /dev/null\necho '${JSON.stringify(outer)}'\n`)
	chmodSync(claude, 0o755)
	t.after(() => {
		rmSync(dir, { recursive: true, force: true })
		delete process.env.MYIND_HOME
		setUsageLabel(null)
	})
	return { claude, argv: () => readFileSync(log, 'utf8') }
}

test('a claude call is logged with tokens, cost, model and the item it was for', async (t) => {
	const w = world(t)
	setUsageLabel({ id: 'abc123', title: 'Bread reel', kind: 'learn' })
	const res = await askClaude({ claude: w.claude }, {}, 'hello')
	assert.equal(res.ok, true)
	const rows = readUsage()
	assert.equal(rows.length, 1)
	assert.equal(rows[0].id, 'abc123')
	assert.equal(rows[0].kind, 'learn')
	assert.equal(rows[0].input, 1200)
	assert.equal(rows[0].output, 300)
	assert.equal(rows[0].cacheRead, 50)
	assert.equal(rows[0].cost, 0.0123)
	assert.equal(rows[0].model, 'claude-sonnet-5-5')
	assert.ok(!readFileSync(usagePath(), 'utf8').includes('hello'), 'the prompt is never logged')
})

test('short text goes to smallModel, long text to claudeModel', async (t) => {
	const w = world(t)
	const cfg = { claudeModel: 'opus', smallModel: 'haiku', smallChars: 100 }
	await readWithClaude({ claude: w.claude }, cfg, { title: 't' }, 'short caption')
	await readWithClaude({ claude: w.claude }, cfg, { title: 't' }, 'x'.repeat(500))
	const log = w.argv()
	assert.ok(log.indexOf('--model haiku') >= 0 && log.indexOf('--model haiku') < log.indexOf('--model opus'), 'haiku for the caption, then opus for the long text')
})

test('summarise and the report: totals, by kind, top items, waiting counts; old rows left out', () => {
	const dir = mkdtempSync(join(tmpdir(), 'myind-usage-'))
	process.env.MYIND_HOME = dir
	try {
		const now = Date.parse('2026-11-09T10:00:00Z')
		recordUsage({ at: '2026-11-08T10:00:00Z', id: 'a', title: 'Reel A', kind: 'learn', model: 'm', input: 1000, output: 100, cost: 0.01 })
		recordUsage({ at: '2026-11-07T10:00:00Z', id: 'a', title: 'Reel A', kind: 'learn', model: 'm', input: 500, output: 50, cost: 0.005 })
		recordUsage({ at: '2026-11-06T10:00:00Z', title: 'small-business', kind: 'topic', model: 'm', input: 3000, output: 900, cost: 0.04 })
		recordUsage({ at: '2026-10-01T10:00:00Z', id: 'old', kind: 'learn', model: 'm', input: 99999, output: 1, cost: 9 })
		const s = summarise(readUsage(), { days: 7, now })
		assert.equal(s.calls, 3)
		assert.equal(s.input, 4500)
		assert.equal(s.output, 1050)
		assert.equal(Math.round(s.cost * 1000), 55)
		assert.equal(s.byKind.topic.calls, 1)
		assert.equal(s.top[0].title, 'small-business')
		const md = reportMarkdown(s, { needsWords: 27, failed: 1, pending: 0, date: '2026-11-09' })
		assert.match(md, /^# Myind weekly report/)
		assert.match(md, /27 reels or videos wait for your words/)
		assert.match(md, /Reel A/)
		assert.ok(!md.includes('old'))
	} finally {
		rmSync(dir, { recursive: true, force: true })
		delete process.env.MYIND_HOME
	}
})

test('no usage file is an empty week, not a crash', () => {
	const dir = mkdtempSync(join(tmpdir(), 'myind-usage-'))
	process.env.MYIND_HOME = dir
	try {
		assert.equal(existsSync(usagePath()), false)
		assert.equal(summarise(readUsage(), { days: 7 }).calls, 0)
	} finally {
		rmSync(dir, { recursive: true, force: true })
		delete process.env.MYIND_HOME
	}
})

test('the weekly reminder plist runs report once a week at the chosen day and hour', () => {
	const plist = reminderPlist('/x/myind-worker.mjs', { weekday: 1, hour: 10, path: '/usr/bin' })
	assert.match(plist, /<string>com\.myind\.weekly<\/string>/)
	assert.match(plist, /<string>report<\/string>/)
	assert.match(plist, /<string>--notify<\/string>/)
	assert.match(plist, /<key>Weekday<\/key>\s*<integer>1<\/integer>/)
	assert.match(plist, /<key>Hour<\/key>\s*<integer>10<\/integer>/)
	assert.ok(!plist.includes('KeepAlive'))
})
