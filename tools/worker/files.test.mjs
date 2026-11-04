import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { makeWorld } from './test-helpers.mjs'
import { itemIdForFile } from '../../plugins/myind/worker/url.mjs'
import { which } from '../../plugins/myind/worker/util.mjs'

const sha = (data) => createHash('sha256').update(data).digest('hex')

/** A file the phone already stored: its asset parts in the fake GitHub, its manifest on origin, and a job for it. */
function addFile(w, body, { name, mime, kind, parts = [body], speechLang = null, repo = undefined, thumb = null }) {
	const fileSha = sha(body)
	const id = itemIdForFile(fileSha)
	const assets = join(w.fake, 'assets')
	mkdirSync(assets, { recursive: true })
	const rows = parts.map((data, n) => {
		const part = `${fileSha}.part${String(n).padStart(3, '0')}`
		writeFileSync(join(assets, part), data)
		return { release: 'myind-blobs-0001', assetId: n + 1, name: part, size: data.length, ...(repo === undefined ? {} : { repo }) }
	})
	const manifest = { schema: 'myind.file/1', sha256: fileSha, size: body.length, name, mime, kind, folder: '/Docs', takenAt: null, addedAt: '2026-11-01T00:00:00Z', width: null, height: null, durationSec: null, thumb, item: null, description: null, tags: [], device: 'pixel-6', parts: rows }
	const job = { schema: 'myind.inbox/1', id, kind: 'file', url: null, fileSha, title: null, note: null, speechLang, createdAt: '2026-11-02T10:00:00Z', device: 'pixel-6', reason: 'test' }
	w.fromOther({ [`files/manifests/${fileSha.slice(0, 2)}/${fileSha}.json`]: `${JSON.stringify(manifest)}\n`, [`inbox/${id}.json`]: `${JSON.stringify(job)}\n` })
	return { id, fileSha }
}

test('a text file in parts is downloaded, joined, checked, read and linked', (t) => {
	const w = makeWorld(t)
	w.setup()
	const body = Buffer.from('# My notes\n\nSome long enough words about careful testing of workers. And more words.\n')
	const { id, fileSha } = addFile(w, body, { name: 'notes.md', mime: 'text/markdown', kind: 'document', parts: [body.subarray(0, 10), body.subarray(10)] })
	const res = w.worker('once')
	assert.equal(res.code, 0, res.all)
	const learning = w.learning(id, 'file')
	assert.equal(learning.quality, 'full')
	assert.equal(learning.sourceUrl, null)
	assert.equal(learning.sourceType, 'file')
	assert.deepEqual(learning.files, [{ sha256: fileSha, role: 'file' }])
	assert.ok(w.originFile(`${w.itemDir(id, 'file')}/article.md`).includes('careful testing'))
	assert.ok(w.log('claude')[0].input.includes('careful testing'))
	const downloads = w.log('gh').filter((c) => c.argv[1] === 'download')
	assert.equal(downloads.length, 2, 'both parts')
	assert.equal(JSON.parse(w.originFile(`files/manifests/${fileSha.slice(0, 2)}/${fileSha}.json`)).item, id, 'the manifest now names its item')
	assert.equal(w.originFile(`inbox/${id}.json`), null)
})

test('a part with the wrong bytes fails the job on its checksum', (t) => {
	const w = makeWorld(t)
	w.setup()
	const body = Buffer.from('real bytes of a text file for testing')
	const { id } = addFile(w, body, { name: 'a.txt', mime: 'text/plain', kind: 'document', parts: [Buffer.from('fake bytes of a text file for testing')] })
	w.worker('once')
	assert.match(JSON.parse(w.originFile(`failed/${id}.json`)).error, /wrong sha256/)
})

test('audio goes through Whisper with the job language and comes out timed', (t) => {
	const w = makeWorld(t)
	w.setup()
	const { id } = addFile(w, Buffer.from('audio-bytes'), { name: 'memo.m4a', mime: 'audio/mp4', kind: 'audio', speechLang: 'mr' })
	const res = w.worker('once')
	assert.equal(res.code, 0, res.all)
	const argv = w.log('whisper')[0].argv
	assert.equal(argv[argv.indexOf('--language') + 1], 'mr')
	const learning = w.learning(id, 'file')
	assert.equal(learning.transcriptKind, 'whisper')
	assert.deepEqual(learning.files.map((f) => f.role), ['audio'])
	const dir = w.itemDir(id, 'file')
	assert.match(w.originFile(`${dir}/transcript.md`), /\[01:05\] More words spoken/)
	assert.match(w.originFile(`${dir}/transcript.txt`), /Words from the audio file/)
})

test('a small image is sent to Claude as an attachment with no tools', (t) => {
	const w = makeWorld(t)
	w.setup()
	const { id } = addFile(w, Buffer.from('tiny-png-bytes'), { name: 'board.png', mime: 'image/png', kind: 'photo' })
	assert.equal(w.worker('once').code, 0)
	const calls = w.log('claude')
	assert.ok(calls[0].argv.includes('stream-json'))
	assert.equal(calls[0].argv[calls[0].argv.indexOf('--tools') + 1], '')
	const sent = JSON.parse(calls[0].input.trim())
	assert.equal(sent.message.content[0].type, 'image')
	assert.equal(sent.message.content[0].source.media_type, 'image/png')
	assert.equal(Buffer.from(sent.message.content[0].source.data, 'base64').toString(), 'tiny-png-bytes')
	assert.equal(w.learning(id, 'file').quality, 'full', 'its words were then read like any other text')
	assert.match(w.originFile(`${w.itemDir(id, 'file')}/article.md`), /whiteboard about rebasing/)
})

test('a file nothing can read is recorded as such, not failed', (t) => {
	const w = makeWorld(t)
	w.setup()
	const { id } = addFile(w, Buffer.from('PK-zip-bytes'), { name: 'a.zip', mime: 'application/zip', kind: 'other' })
	assert.equal(w.worker('once').code, 0)
	const learning = w.learning(id, 'file')
	assert.equal(learning.quality, 'basic')
	assert.equal(learning.processedBy, 'pc-local')
	assert.match(learning.summary, /stored, but this worker has no reader/)
	assert.equal(w.log('claude').length, 0)
	assert.equal(w.originFile(`failed/${id}.json`), null)
})

test('archived mail (mail/<yyyy>/<mm>/) is left exactly as the phone wrote it, even next to a job', (t) => {
	const w = makeWorld(t)
	w.setup()
	const eml = 'From: Bank <alerts@bank.example>\r\nSubject: Statement\r\n\r\nTotal due 4,250\r\n'
	const record = { schema: 'myind.mail/1', gmailId: '18c2ab', threadId: 't1', subject: 'Statement', from: 'Bank', to: 'me', date: '2024-03-04T10:00:00.000Z', size: eml.length, labels: ['INBOX'], sha256: sha(eml), eml: 'mail/2024/03/18c2ab.eml', parts: [], archivedAt: '2026-11-03T10:00:00.000Z', device: 'pixel-6' }
	const big = { ...record, gmailId: '18c2ac', eml: null, parts: [{ release: 'myind-blobs-0001', assetId: 9, name: `${'b'.repeat(64)}.part000`, size: 2000000 }] }
	// In a year repo: only the record is here, its body is in me/myind-mail-2019.
	const inYear = { ...record, gmailId: '18c2ad', date: '2019-05-02T10:00:00.000Z', eml: 'mail/2019/05/18c2ad.eml', repo: 'me/myind-mail-2019' }
	w.fromOther({
		'mail/2024/03/18c2ab.eml': eml,
		'mail/2024/03/18c2ab.json': `${JSON.stringify(record, null, 2)}\n`,
		'mail/2023/11/18c2ac.json': `${JSON.stringify(big, null, 2)}\n`,
		'mail/2019/05/18c2ad.json': `${JSON.stringify(inYear, null, 2)}\n`,
	}, 'mail: keep 3 emails from Gmail')
	w.addLink('https://youtu.be/abc?si=zzz')
	const res = w.worker('once')
	assert.equal(res.code, 0, res.all)
	assert.equal(w.originFile('mail/2024/03/18c2ab.eml'), eml)
	assert.deepEqual(JSON.parse(w.originFile('mail/2024/03/18c2ab.json')), record)
	assert.deepEqual(JSON.parse(w.originFile('mail/2023/11/18c2ac.json')), big)
	assert.deepEqual(JSON.parse(w.originFile('mail/2019/05/18c2ad.json')), inYear, 'a record naming a year repo is left as it is')
	assert.equal(w.originFile('mail/2019/05/18c2ad.eml'), null, 'the worker never fetches a body into the main repo')
	assert.ok(!w.originFiles().some((f) => f.startsWith('library/') && f.includes('18c2a')), 'mail never becomes a library item')
	assert.ok(!w.log('claude').some((c) => c.input.includes('Total due 4,250')), 'mail text is never sent to the model')
})

test('a part in a storage repository is downloaded from that repository', (t) => {
	const w = makeWorld(t)
	w.setup()
	const body = Buffer.from('# Trip notes\n\nEnough words about the storage repository that holds this file, and more.\n')
	const { id } = addFile(w, body, { name: 'trip.md', mime: 'text/markdown', kind: 'document', repo: 'me/myind-media' })
	assert.equal(w.worker('once').code, 0)
	assert.equal(w.learning(id, 'file').quality, 'full')
	const downloads = w.log('gh').filter((c) => c.argv[1] === 'download')
	assert.equal(downloads.length, 1)
	assert.equal(downloads[0].argv[downloads[0].argv.indexOf('--repo') + 1], 'me/myind-media')
})

test('a part naming a strange repository is refused, not passed to gh', (t) => {
	const w = makeWorld(t)
	w.setup()
	const body = Buffer.from('# Odd\n\nWords enough to be read if it were ever downloaded, which it must not be.\n')
	addFile(w, body, { name: 'odd.md', mime: 'text/markdown', kind: 'document', repo: '--help; rm -rf' })
	w.worker('once')
	assert.equal(w.log('gh').filter((c) => c.argv[1] === 'download').length, 0)
})

test('a manifest whose thumbnail is on a shelf ({repo, path}) is read and rewritten with the thumbnail unchanged', (t) => {
	const w = makeWorld(t)
	w.setup()
	const body = Buffer.from('# Shelf notes\n\nEnough words about a file whose thumbnail lives on its year shelf, and more.\n')
	const thumb = { repo: 'me/myind-photos-2026', path: `files/thumbs/${sha(body).slice(0, 2)}/${sha(body)}.jpg` }
	const { id, fileSha } = addFile(w, body, { name: 'shelf.md', mime: 'text/markdown', kind: 'document', repo: 'me/myind-photos-2026', thumb })
	assert.equal(w.worker('once').code, 0)
	const manifest = JSON.parse(w.originFile(`files/manifests/${fileSha.slice(0, 2)}/${fileSha}.json`))
	assert.equal(manifest.item, id)
	assert.deepEqual(manifest.thumb, thumb, 'the shelf thumbnail is kept as the phone wrote it')
	assert.ok(!w.log('gh').some((c) => c.argv.join(' ').includes('files/thumbs')), 'the worker never fetches thumbnails')
})

test('a part naming a repository with .. is refused', (t) => {
	const w = makeWorld(t)
	w.setup()
	const body = Buffer.from('# Dots\n\nWords enough to be read if it were ever downloaded, which it must not be at all.\n')
	addFile(w, body, { name: 'dots.md', mime: 'text/markdown', kind: 'document', repo: '../etc' })
	w.worker('once')
	assert.equal(w.log('gh').filter((c) => c.argv[1] === 'download').length, 0)
})
