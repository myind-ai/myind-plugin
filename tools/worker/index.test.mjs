// The index snapshot (storage-format.md, "Index snapshot (2026-11-05)"): what goes in, the sha on every line, keep the
// newest two, and when the worker makes one by itself.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'
import { buildIndex, gitBlobSha, indexable, indexDue, indexName, INDEX_NAME, toPrune } from '../../plugins/myind/worker/index.mjs'
import { makeWorld } from './test-helpers.mjs'

const sha64 = (i) => i.toString(16).padStart(64, '0')
const manifest = (i) => `${JSON.stringify({ schema: 'myind.file/1', sha256: sha64(i), size: 10 + i, name: `IMG_${i}.jpg`, mime: 'image/jpeg', kind: 'photo', folder: '/Photos', addedAt: '2026-11-04T10:00:00Z', parts: [] })}\n`
const manifests = (from, n) => Object.fromEntries(Array.from({ length: n }, (_, k) => [`files/manifests/${sha64(from + k).slice(62)}/${sha64(from + k)}.json`, manifest(from + k)]))
const lines = (gz) => gunzipSync(gz).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const ghState = (w) => JSON.parse(readFileSync(join(w.fake, 'gh-state.json'), 'utf8'))
const setCfg = (w, extra) => {
	const p = join(w.home, '.myind', 'worker.json')
	writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), ...extra }))
}

test('every small text file the phone reads goes in, with its git blob sha; nothing else does', async (t) => {
	const w = makeWorld(t)
	w.fromOther({
		...manifests(1, 3),
		'files/thumbs/01/x.jpg': Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]),
		'mail/2026/11/a.json': '{"schema":"myind.mail/1","id":"a"}',
		'mail/2026/11/big.json': `{"pad":"${'x'.repeat(70 * 1024)}"}`,
		'mail/2026/11/a.eml': 'From: x',
		'library/site/2026-11-01_page_aaaaaaaa/learning.json': '{"schema":"myind.learning/1","id":"aaaaaaaa00000000"}',
		'library/site/2026-11-01_page_aaaaaaaa/notes.md': '# Page — ünïcode ✓',
		'library/site/2026-11-01_page_aaaaaaaa/cover.png': 'not text the pull reads',
		'inbox/abc.json': '{"schema":"myind.inbox/1","id":"abc"}',
		'topics/git.md': '# Git',
		'devices/pc.json': '{"schema":"myind.device/1"}',
		'storage.json': '{"schema":"myind.storage/3"}',
		'settings.json': '{"schema":"myind.settings/1"}',
		'failed/leak.json': '{"error":"ghp_abcdefghijklmnopqrstuvwxyz0123456789"}',
		'README.md': '# memory',
	})
	w.setup()
	const now = new Date('2026-11-05T09:08:07Z')
	const built = await buildIndex(w.clone, { now })
	const head = w.sh(w.clone, 'rev-parse', 'HEAD')
	assert.equal(built.commit, head)
	assert.match(built.name, INDEX_NAME)
	assert.equal(built.name, `index-20261105T090807Z-${head.slice(0, 12)}.ndjson.gz`)
	const [header, ...rows] = lines(built.gz)
	assert.deepEqual({ ...header, writer: undefined }, { schema: 'myind.index/1', commit: head, made: '2026-11-05T09:08:07.000Z', files: rows.length, writer: undefined })
	const paths = rows.map((r) => r.p)
	assert.deepEqual(paths, [...paths].sort(), 'sorted by path')
	for (const want of [...Object.keys(manifests(1, 3)), 'mail/2026/11/a.json', 'library/site/2026-11-01_page_aaaaaaaa/learning.json', 'library/site/2026-11-01_page_aaaaaaaa/notes.md', 'inbox/abc.json', 'topics/git.md', 'devices/pc.json', 'storage.json', 'settings.json']) {
		assert.ok(paths.includes(want), `${want} is in the snapshot`)
	}
	for (const out of ['files/thumbs/01/x.jpg', 'mail/2026/11/big.json', 'mail/2026/11/a.eml', 'library/site/2026-11-01_page_aaaaaaaa/cover.png', 'README.md', 'myind.json', 'failed/leak.json']) {
		assert.ok(!paths.includes(out), `${out} is left out`)
	}
	assert.equal(built.left, 1, 'the file with a secret shape is left out and counted')
	for (const r of rows) {
		assert.equal(r.s, gitBlobSha(Buffer.from(r.c, 'utf8')), `${r.p}: the line's sha is git's blob sha of its text`)
		assert.equal(r.s, w.sh(w.clone, 'rev-parse', `HEAD:${r.p}`), `${r.p}: the same sha git has`)
	}
	assert.equal(rows.find((r) => r.p.endsWith('notes.md')).c, '# Page — ünïcode ✓')
})

test('git blob sha matches git itself', (t) => {
	const w = makeWorld(t)
	const bytes = Buffer.from('hello\n')
	writeFileSync(join(w.root, 'h.txt'), bytes)
	assert.equal(gitBlobSha(bytes), w.sh(w.root, 'hash-object', 'h.txt'))
	assert.equal(gitBlobSha(Buffer.alloc(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
})

test('names sort by time; only the newest two are kept', () => {
	const a = indexName(new Date('2026-11-01T00:00:00Z'), 'a'.repeat(40))
	const b = indexName(new Date('2026-11-03T00:00:00Z'), 'b'.repeat(40))
	const c = indexName(new Date('2026-11-05T00:00:00Z'), 'c'.repeat(40))
	assert.deepEqual(toPrune([b, c, a, 'notes.txt', 'abc.part000']), [a])
	assert.deepEqual(toPrune([c]), [])
	assert.equal(indexable('files/manifests/aa/x.json', 300 * 1024), false, 'too long: read normally')
})

test('`index` uploads to myind-index, makes the release once, and keeps the newest two', (t) => {
	const w = makeWorld(t)
	w.fromOther(manifests(1, 5))
	w.setup()
	for (let i = 0; i < 3; i++) {
		if (i) w.fromOther(manifests(100 + i, 1)) // a new commit, so a new name
		const r = w.worker('index')
		assert.equal(r.code, 0, r.all)
		assert.match(r.out, /index snapshot index-\d{8}T\d{6}Z-[0-9a-f]{12}\.ndjson\.gz: \d+ files/)
	}
	const state = ghState(w)
	assert.deepEqual(state.releases.map((r) => r.tag), ['myind-index'], 'one release, never a myind-blobs one')
	const names = state.releases[0].assets.map((a) => a.name)
	assert.equal(names.length, 2)
	const head = w.sh(w.clone, 'rev-parse', 'HEAD')
	assert.ok(names.some((n) => n.endsWith(`-${head.slice(0, 12)}.ndjson.gz`)), 'the newest is kept')
	const gh = w.log('gh').map((r) => r.argv)
	assert.equal(gh.filter((a) => a[0] === 'release' && a[1] === 'create').length, 1)
	assert.equal(gh.filter((a) => a[0] === 'release' && a[1] === 'delete-asset').length, 1)
	assert.ok(gh.every((a) => !a.join(' ').includes('myind-blobs')))
	// What went up is a snapshot of what the remote has.
	const newest = names.sort().at(-1)
	const [header, ...rows] = lines(readFileSync(join(w.fake, 'assets', newest)))
	assert.equal(header.commit, head)
	assert.equal(rows.length, w.originFiles().filter((p) => p.startsWith('files/manifests/') || p.startsWith('devices/')).length)
})

test('when a snapshot is due', () => {
	const now = new Date('2026-11-10T00:00:00Z')
	assert.equal(indexDue({ last: null, files: 499, changed: 0, now }), false, 'a small repo needs none')
	assert.equal(indexDue({ last: null, files: 500, changed: 0, now }), true)
	const last = { commit: 'c'.repeat(40), made: '2026-11-09T00:00:00Z' }
	assert.equal(indexDue({ last, changed: 499, now }), false)
	assert.equal(indexDue({ last, changed: 500, now }), true, '500 changes')
	const old = { ...last, made: '2026-11-02T00:00:00Z' }
	assert.equal(indexDue({ last: old, changed: 1, now }), true, 'over 7 days and something changed')
	assert.equal(indexDue({ last: old, changed: 0, now }), false, 'nothing changed: the old one is still right')
	assert.equal(indexDue({ last, changed: 3, now, every: 3 }), true, 'indexEvery in worker.json')
})

test('`once` makes a snapshot by itself only when one is due, and again after enough changes', (t) => {
	const w = makeWorld(t)
	w.fromOther(manifests(1, 4))
	w.setup()
	let r = w.worker('once')
	assert.equal(r.code, 0, r.all)
	assert.ok(!w.log('gh').some((x) => x.argv[1] === 'upload'), 'a 5-file repo is under 500: no snapshot')

	setCfg(w, { indexEvery: 3 })
	r = w.worker('once')
	assert.equal(r.code, 0, r.all)
	assert.match(r.all, /index snapshot index-/)
	const uploads = () => w.log('gh').filter((x) => x.argv[1] === 'upload').length
	assert.equal(uploads(), 1)

	r = w.worker('once')
	assert.equal(uploads(), 1, 'nothing changed: no new snapshot')
	w.fromOther(manifests(50, 2))
	w.worker('once')
	assert.equal(uploads(), 1, '2 changes is under indexEvery 3')
	w.fromOther(manifests(60, 1))
	w.worker('once')
	assert.equal(uploads(), 2, '3 changes since the last snapshot')

	setCfg(w, { index: false })
	w.fromOther(manifests(70, 5))
	w.worker('once')
	assert.equal(uploads(), 2, '"index": false turns it off')
})
