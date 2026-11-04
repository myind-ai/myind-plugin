import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { chunkText } from '../../plugins/myind/worker/claude.mjs'
import { checkTopicReply, topicSlug } from '../../plugins/myind/worker/evolve.mjs'
import { relatedIds } from '../../plugins/myind/worker/library.mjs'
import { extractiveSummary, parseJsonReply, validateLearning } from '../../plugins/myind/worker/schema.mjs'
import { makeWorld } from './test-helpers.mjs'
import { commitSubject, oneLine, secretsIn } from '../../plugins/myind/worker/util.mjs'

const NUDGE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'myind', 'scripts', 'myind-nudge.mjs')
const good = { summary: 's', lessons: [{ text: 't', at: 1 }], tags: ['a-b'], terms: [{ term: 'x', meaning: 'y' }], links: ['https://e.com'], notes_markdown: 'n' }

test('setup clones, writes settings with no token, and refuses a token in the remote', (t) => {
	const w = makeWorld(t)
	const bad = w.worker('setup', '--repo', 'me/brain', '--remote', 'https://me:ghp_abc@github.com/me/brain.git')
	assert.equal(bad.code, 1)
	assert.ok(!bad.all.includes('ghp_abc'))
	assert.equal(w.worker('setup', '--repo', 'not a repo').code, 1)
	w.setup()
	assert.ok(existsSync(join(w.clone, 'myind.json')))
	const cfg = JSON.parse(readFileSync(join(w.env.MYIND_HOME, 'worker.json'), 'utf8'))
	assert.equal(cfg.repo, 'me/brain')
	assert.equal(cfg.dir, w.clone)
	assert.equal(cfg.device, 'test-pc')
	assert.ok(existsSync(cfg.workerPath))
	assert.ok(!/token|ghp_|password/i.test(JSON.stringify(cfg)))
	assert.equal(w.worker('setup', '--repo', 'me/brain', '--remote', w.bare).code, 0, 'running it again is fine')
})

test('setup without --remote uses gh with the given repo', (t) => {
	const w = makeWorld(t)
	w.worker('setup', '--repo', 'me/brain')
	const first = w.log('gh')[0].argv
	assert.deepEqual(first.slice(0, 3), ['repo', 'clone', 'me/brain'])
})

test('status reports pending, failed, last run and tools from the local clone', (t) => {
	const w = makeWorld(t)
	assert.match(w.worker('status').out, /not set up/)
	w.setup()
	w.setFake('wp', { learnError: 'unreadable page' })
	const bad = w.addLink('https://example.com/x', { createdAt: '2026-11-01T00:00:00Z' })
	w.worker('once')
	w.addLink('https://youtu.be/waiting')
	w.sh(w.clone, 'pull', '-q', 'origin', 'main')
	const s = JSON.parse(w.worker('status', '--json').out)
	assert.equal(s.pending, 1)
	assert.equal(s.failed, 1)
	assert.equal(s.failures[0].id, bad)
	assert.match(s.failures[0].error, /unreadable page/)
	assert.equal(s.lastRun.failed, 1)
	assert.ok(s.tools.gh.startsWith(w.bin) && s.tools.claude.startsWith(w.bin) && s.tools.whisper.startsWith(w.bin))
	const text = w.worker('status').out
	assert.match(text, /pending 1/)
	assert.match(text, /last run/)
	assert.match(text, /ok claude/)
})

test('tool paths: the environment wins over worker.json, and a path that is gone counts as missing', (t) => {
	const w = makeWorld(t)
	w.setup()
	const path = join(w.env.MYIND_HOME, 'worker.json')
	writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), wpBrain: join(w.bin, 'claude') }))
	assert.equal(JSON.parse(w.worker('status', '--json').out).tools['wp-brain'], join(w.bin, 'wp-brain'))
	delete w.env.MYIND_WP_BRAIN
	assert.equal(JSON.parse(w.worker('status', '--json').out).tools['wp-brain'], join(w.bin, 'claude'))
	writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), wpBrain: join(w.bin, 'gone') }))
	assert.equal(JSON.parse(w.worker('status', '--json').out).tools['wp-brain'], null)
})

test('no video downloader: status lists none, and the removed video options say why', (t) => {
	const w = makeWorld(t)
	w.setup()
	const s = JSON.parse(w.worker('status', '--json').out)
	assert.ok(!Object.keys(s.tools).some((k) => /yt|dl|deno/.test(k)), 'no downloader among the tools')
	assert.equal(s.needsWords, 0)
	for (const flag of ['--with-video', '--cookies-from-browser']) {
		const res = w.worker('once', flag, 'x')
		assert.notEqual(res.code, 0)
		assert.match(res.all, /doesn't download videos/)
	}
})
test('--workpulse sends the folder and each lesson; its failure only warns', (t) => {
	const w = makeWorld(t)
	w.setup()
	const id = w.addLink('https://youtu.be/wp')
	assert.equal(w.worker('once', '--workpulse').code, 0)
	const calls = w.log('wp')
	const lib = calls.find((c) => c.argv[0] === 'library')
	assert.deepEqual(lib.argv.slice(0, 2), ['library', 'add'])
	assert.ok(lib.argv[2].endsWith(w.itemDir(id, 'youtube')))
	assert.equal(lib.argv[lib.argv.indexOf('--type') + 1], 'youtube')
	const add = calls.find((c) => c.argv[0] === 'add')
	assert.deepEqual(add.argv, ['add', '--json', '-'])
	const entries = JSON.parse(add.input)
	assert.equal(entries.length, 2)
	assert.equal(entries[0].kind, 'learning')
	assert.equal(entries[0].scope, 'personal')
	assert.equal(entries[0].project, 'myind')
	assert.equal(entries[0].title, 'Lesson one from the model')
	assert.equal(entries[0].source.type, 'youtube')
	assert.equal(entries[0].source.url, 'https://youtube.com/watch?v=wp')
	assert.match(entries[0].source.library, /^bridge\/library\/youtube\//)

	w.setFake('wp', { fail: true })
	const second = w.addLink('https://youtu.be/wp2')
	const res = w.worker('once', '--workpulse')
	assert.equal(res.code, 0, res.all)
	assert.match(res.out, /--workpulse: library add failed/)
	assert.match(res.out, /--workpulse: add failed/)
	assert.equal(w.learning(second, 'youtube').quality, 'full')
})

test('related links items that share terms, with no AI', (t) => {
	const w = makeWorld(t)
	const write = (id, learning) => {
		const dir = join(w.other, `library/site/2026-01-01_x_${id.slice(0, 8)}`)
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, 'learning.json'), JSON.stringify({ id, ...learning }))
	}
	write('a'.repeat(16), { title: 'Git rebase basics', tags: ['git', 'rebase'], summary: 'about commits', lessons: [] })
	write('b'.repeat(16), { title: 'Cooking rice', tags: ['food'], summary: 'about grains', lessons: [] })
	write('c'.repeat(16), { title: 'हिंदी संपादन', tags: ['संपादन'], summary: 'वीडियो', lessons: [] })
	assert.deepEqual(relatedIds(w.other, { id: 'd'.repeat(16), title: 'Rebase with git safely', tags: ['git'], summary: '', lessons: [] }), ['a'.repeat(16)])
	assert.deepEqual(relatedIds(w.other, { id: 'e'.repeat(16), title: 'संपादन के नियम', tags: [], summary: '', lessons: [] }), ['c'.repeat(16)])
	assert.deepEqual(relatedIds(w.other, { id: 'f'.repeat(16), title: 'Nothing alike', tags: [], summary: '', lessons: [] }), [])
})

test('a new item stores its related ids through a real run', (t) => {
	const w = makeWorld(t)
	w.setup()
	const a = w.addLink('https://youtu.be/one')
	w.worker('once')
	const b = w.addLink('https://youtu.be/two')
	w.worker('once')
	assert.deepEqual(w.learning(b, 'youtube').related, [a])
})

test('evolve writes a page for a tag that gained items, cites them, and does nothing when none is new', (t) => {
	const w = makeWorld(t)
	w.setup()
	const a = w.addLink('https://youtu.be/one')
	const b = w.addLink('https://youtu.be/two')
	w.worker('once')
	const res = w.worker('evolve')
	assert.equal(res.code, 0, res.all)
	const page = w.originFile('topics/git.md')
	assert.match(page, /^# Topic page/)
	assert.match(page, /\(\[A test video\]\(\.\.\/library\/youtube\//, 'the ref became a link to its notes')
	assert.ok(!/\[[0-9a-f]{8}\]/.test(page), 'no raw ref is left')
	assert.match(page, /## Sources/)
	assert.ok(page.includes(a) && page.includes(b), 'the marker lists both')
	assert.ok(w.originLog().some((m) => m === 'topic: git'))

	const calls = w.log('claude').length
	assert.equal(w.worker('evolve').code, 0)
	assert.equal(w.log('claude').length, calls, 'nothing new, so no call')

	w.addLink('https://youtu.be/three')
	w.worker('once')
	const before = w.log('claude').length
	w.worker('evolve')
	const prompts = w.log('claude').slice(before)
	assert.equal(prompts.length, 2, 'git and testing both gained an item')
	assert.match(prompts[0].input, /existing page/)
	assert.match(prompts[0].input, /Topic page/)
})

test('evolve without Claude writes a plain list and the next run writes the real page', (t) => {
	const w = makeWorld(t)
	w.setup()
	w.addLink('https://youtu.be/one')
	w.addLink('https://youtu.be/two')
	w.worker('once')
	w.setFake('claude', { mode: 'fail' })
	w.worker('evolve')
	assert.match(w.originFile('topics/git.md'), /no AI has written this yet/)
	w.setFake('claude', { mode: 'good' })
	w.worker('evolve')
	assert.match(w.originFile('topics/git.md'), /^# Topic page/)
})

test('a topic reply must cite only what it was given', () => {
	assert.equal(checkTopicReply('{"markdown":"# T\\n\\nfact [abcdef12]"}', ['abcdef12']).ok, true)
	assert.equal(checkTopicReply('{"markdown":"# T no citations"}', ['abcdef12']).ok, false)
	assert.equal(checkTopicReply('{"markdown":"# T [99999999]"}', ['abcdef12']).ok, false)
	assert.equal(checkTopicReply('{"markdown":"x [abcdef12]","run":"rm"}', ['abcdef12']).ok, false)
	assert.equal(checkTopicReply('no', ['abcdef12']).ok, false)
	assert.equal(topicSlug('git-rebase'), 'git-rebase')
	assert.match(topicSlug('संपादन'), /^topic-[0-9a-f]{8}$/)
})

test('launchd-plist prints a plist for watch, installs nothing', (t) => {
	const w = makeWorld(t)
	w.setup()
	const res = w.worker('launchd-plist', '--every', '600', '--workpulse')
	assert.equal(res.code, 0, res.all)
	assert.match(res.out, /<key>Label<\/key>\s*<string>com\.myind\.worker<\/string>/)
	assert.match(res.out, /<string>watch<\/string>\s*<string>--every<\/string>\s*<string>600<\/string>\s*<string>--workpulse<\/string>/)
	assert.ok(res.out.includes(`<string>${process.execPath}</string>`))
	assert.ok(res.out.includes(w.bin), 'PATH finds the tools under launchd')
	assert.ok(!existsSync(join(w.home, 'Library', 'LaunchAgents')))
	if (process.platform === 'darwin') {
		const plist = join(w.root, 'a.plist')
		writeFileSync(plist, res.out)
		assert.equal(spawnSync('plutil', ['-lint', plist]).status, 0)
	}
})

test('watch loops, and stops on a signal', async (t) => {
	const w = makeWorld(t)
	w.setup()
	const id = w.addLink('https://youtu.be/watched')
	const { spawn } = await import('node:child_process')
	const { WORKER } = await import('./test-helpers.mjs')
	const child = spawn(process.execPath, [WORKER, 'watch', '--every', '1'], { env: w.env, stdio: 'ignore' })
	const closed = new Promise((r) => child.on('close', r))
	for (let i = 0; i < 240 && w.originFile(`inbox/${id}.json`) !== null; i++) await new Promise((r) => setTimeout(r, 500))
	assert.equal(w.originFile(`inbox/${id}.json`), null, 'a pass ran')
	child.kill('SIGTERM')
	assert.equal(await closed, 0)
})

test('the SessionStart hook prints one line only when jobs wait, and never fails', (t) => {
	const w = makeWorld(t)
	const hook = (extra = {}) => spawnSync(process.execPath, [NUDGE], { env: { ...w.env, ...extra }, encoding: 'utf8' })
	let r = hook() // not set up
	assert.equal(r.status, 0)
	assert.equal(r.stdout, '')
	w.setup()
	r = hook()
	assert.equal(r.stdout, '', 'an empty inbox says nothing')
	mkdirSync(join(w.clone, 'inbox'), { recursive: true })
	writeFileSync(join(w.clone, 'inbox', `${'a'.repeat(16)}.json`), '{}')
	writeFileSync(join(w.clone, 'inbox', 'notes.txt'), 'not a job')
	r = hook()
	assert.equal(r.status, 0)
	assert.equal(r.stdout.trim().split('\n').length, 1)
	assert.match(r.stdout, /1 Myind job/)
	writeFileSync(join(w.env.MYIND_HOME, 'worker.json'), '{ broken')
	r = hook()
	assert.equal(r.status, 0)
	assert.equal(r.stdout, '')
})

test('learning output is validated strictly', () => {
	const check = (o) => validateLearning(o).ok
	assert.equal(check(good), true)
	assert.equal(check({ ...good, extra: 1 }), false)
	for (const key of Object.keys(good)) {
		const copy = { ...good }
		delete copy[key]
		assert.equal(check(copy), false, key)
	}
	assert.equal(check({ ...good, lessons: [] }), false)
	assert.equal(check({ ...good, lessons: [{ text: 'two\nlines' }] }), false)
	assert.equal(check({ ...good, lessons: [{ text: 't', at: 'soon' }] }), false)
	assert.equal(check({ ...good, lessons: [{ text: 't', run: 'x' }] }), false)
	assert.equal(check({ ...good, tags: ['has space!'] }), false)
	assert.equal(check({ ...good, links: ['javascript:alert(1)'] }), false)
	assert.equal(check({ ...good, terms: [{ term: 'x' }] }), false)
	assert.equal(check([]), false)
	assert.equal(check(null), false)
	assert.deepEqual(validateLearning({ ...good, tags: ['Machine Learning'] }).value.tags, ['machine-learning'])
	assert.deepEqual(validateLearning({ ...good, tags: ['संपादन'] }).value.tags, ['संपादन'])
	assert.deepEqual(validateLearning({ ...good, lessons: [{ text: 't', at: 9999 }] }, { duration: 100 }).value.lessons, [{ text: 't' }], 'a moment past the end is dropped')
	assert.equal(parseJsonReply('```json\n{"a":1}\n```').a, 1)
	assert.equal(parseJsonReply('here you go {"a":1} done').a, 1)
	assert.equal(parseJsonReply('nope'), undefined)
})

test('long text is split with nothing dropped, and every chunk reaches Claude', async (t) => {
	const parts = Array.from({ length: 400 }, (_, i) => `paragraph ${i} हिंदी 😀 end`)
	const text = parts.join('\n\n')
	const chunks = chunkText(text, 1000)
	assert.ok(chunks.length > 5)
	assert.equal(chunks.join(''), text, 'they join back to the input exactly')
	assert.ok(chunks.every((c) => c.length <= 1000))
	const noBreaks = '😀'.repeat(3000)
	assert.equal(chunkText(noBreaks, 1001).join(''), noBreaks)
	assert.ok(chunkText(noBreaks, 1001).every((c) => !/[\ud800-\udbff]$/.test(c)), 'no pair is cut')

	const w = makeWorld(t)
	w.setup()
	w.env.MYIND_CHUNK_CHARS = '1500'
	const transcript = Array.from({ length: 120 }, (_, i) => `[00:${String(i % 60).padStart(2, '0')}](https://x) sentence number marker${i}x of the long transcript.`).join('\n\n')
	w.setFake('words', { transcript })
	const id = w.addLink('https://youtu.be/long')
	assert.equal(w.worker('once').code, 0)
	const calls = w.log('claude')
	const everything = calls.map((c) => c.input).join('\n')
	for (let i = 0; i < 120; i++) assert.ok(everything.includes(`marker${i}x`), `marker${i}x reached Claude`)
	assert.ok(calls.length >= 3, 'several parts')
	assert.match(calls[0].input, /part 1 of \d+/)
	assert.match(calls[calls.length - 1].input, /notes on consecutive parts/, 'then merged')
	assert.equal(w.learning(id, 'youtube').quality, 'full')

	w.setFake('claude', { mode: 'fail' })
	const second = w.addLink('https://youtu.be/long2')
	w.worker('once')
	assert.equal(w.learning(second, 'youtube').quality, 'basic', 'full only means the whole text was read')
})

test('a chunk that fails makes the whole read fail; only a failed merge is done by hand', (t) => {
	const w = makeWorld(t)
	w.setup()
	w.env.MYIND_CHUNK_CHARS = '1500'
	const transcript = Array.from({ length: 120 }, (_, i) => `[00:01](https://x) sentence ${i} of a transcript long enough to need several parts.`).join('\n\n')
	w.setFake('words', { transcript })

	w.setFake('claude', { mode: 'fail-after', after: 1 })
	const a = w.addLink('https://youtu.be/chunkfail')
	assert.equal(w.worker('once').code, 0)
	assert.equal(w.learning(a, 'youtube').quality, 'basic', 'one unread part means it was not all read')

	w.setFake('claude', { mode: 'bad-merge' })
	const b = w.addLink('https://youtu.be/mergefail')
	assert.equal(w.worker('once').code, 0)
	const merged = w.learning(b, 'youtube')
	assert.equal(merged.quality, 'full', 'every part was read')
	assert.match(w.originFile(`${w.itemDir(b, 'youtube')}/notes.md`), /# Part 1[\s\S]*# Part 2/)
})

test('small helpers', () => {
	assert.deepEqual(secretsIn('nothing here, task-management-system-design-patterns'), [])
	for (const s of [`ghp_${'a'.repeat(30)}`, `github_pat_${'a'.repeat(30)}`, `sk-${'a'.repeat(30)}`, `sk-ant-${'a'.repeat(30)}`, `sbp_${'a'.repeat(30)}`, `nvapi-${'a'.repeat(30)}`, 'AKIAABCDEFGHIJKLMNOP', '-----BEGIN RSA PRIVATE KEY-----']) assert.equal(secretsIn(`x ${s} y`).length, 1, s)
	assert.equal(oneLine(`a\nb ${`ghp_${'a'.repeat(30)}`}`), 'a b [GitHub token removed]')
	assert.equal(commitSubject('learn', 'Git basics', 'abcdef0123'), 'learn: Git basics')
	assert.equal(commitSubject('learn', 'Rails tips', 'abcdef0123'), 'learn: Rails tips', 'ai inside a word is fine')
	assert.equal(commitSubject('learn', 'AI for all', 'abcdef0123'), 'learn: item abcdef01')
	assert.equal(commitSubject('learn', '', 'abcdef0123'), 'learn: item abcdef01')
	const basic = extractiveSummary('# heading\n\n[00:10] First sentence about testing things here. Second sentence about testing again today.\n\nhttps://a.example/x and https://a.example/x', { tags: ['Some Tag', 'bad tag!'] })
	assert.deepEqual(basic.links, ['https://a.example/x'])
	assert.deepEqual(basic.tags, ['some-tag'])
	assert.equal(basic.lessons[0].at, 10)
	assert.equal(validateLearning(basic).ok, true, 'the fallback passes the same check')
})
