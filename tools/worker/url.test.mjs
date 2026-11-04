import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { canonPart, folderName, itemIdForFile, itemIdForUrl, normaliseUrl, routeLink, slugify } from '../../plugins/myind/worker/url.mjs'

const VECTORS = [
	['https://youtu.be/Ad7VTVeREOk?si=abc', 'https://youtube.com/watch?v=Ad7VTVeREOk'],
	['https://m.youtube.com/watch?v=Ad7VTVeREOk&t=30s&feature=share', 'https://youtube.com/watch?v=Ad7VTVeREOk'],
	['https://www.youtube.com/shorts/xyz_123', 'https://youtube.com/watch?v=xyz_123'],
	['https://www.instagram.com/reels/C8abc/?igsh=zzz', 'https://instagram.com/reel/C8abc'],
	['https://www.instagram.com/someuser/reel/C8abc/', 'https://instagram.com/reel/C8abc'],
	['http://Example.com/a/b/?b=2&utm_source=x&a=1#top', 'https://example.com/a/b?a=1&b=2'],
	['https://example.com/', 'https://example.com'],
]

test('the storage-format test vectors', () => {
	for (const [input, want] of VECTORS) assert.equal(normaliseUrl(input), want, input)
})

test('more shapes from the rules', () => {
	assert.equal(normaliseUrl('https://www.youtube.com/live/abc?feature=x'), 'https://youtube.com/watch?v=abc')
	assert.equal(normaliseUrl('https://youtube.com/watch/?t=3&v=abc'), 'https://youtube.com/watch?v=abc')
	assert.equal(normaliseUrl('https://instagram.com/p/XY/?hl=en'), 'https://instagram.com/p/XY')
	assert.equal(normaliseUrl('https://instagram.com/someone/tv/XY'), 'https://instagram.com/tv/XY')
	assert.equal(normaliseUrl('https://instagram.com/someone/?hl=en'), 'https://instagram.com/someone')
	assert.equal(normaliseUrl('https://example.com/?a=1'), 'https://example.com?a=1')
	assert.equal(normaliseUrl('https://example.com/x?gclid=1&fbclid=2&ref=3&si=4&igsh=5&igshid=6&feature=7&utm_x=8'), 'https://example.com/x')
})

test('the query is split as written, each pair in one spelling, and equal keys keep their order', () => {
	// Until 2026-11-04 the pairs were kept raw, and the phone (Dart's Uri) escaped them: two ids for one link.
	assert.equal(normaliseUrl('https://example.com/x?q=a+b%20c&q=%E0%A4%B9&a=हिं"दी|'), 'https://example.com/x?a=%E0%A4%B9%E0%A4%BF%E0%A4%82%22%E0%A4%A6%E0%A5%80%7C&q=a+b%20c&q=%E0%A4%B9')
	assert.equal(normaliseUrl('https://example.com/x?b=2=3&flag&a'), 'https://example.com/x?a&b=2=3&flag')
	assert.equal(normaliseUrl('https://www.youtube.com/watch?v=a%2Db_c+d&t=1'), 'https://youtube.com/watch?v=a-b_c+d')
	assert.equal(normaliseUrl('https://example.com/x?a=1#frag?b=2'), 'https://example.com/x?a=1')
})

test('keys sort by code unit, not by locale', () => {
	assert.equal(normaliseUrl('https://example.com/x?b=1&B=2&a=3&ä=4'), 'https://example.com/x?%C3%A4=4&B=2&a=3&b=1', 'sorted after escaping, so both sides sort the same text')
})

test('only http and https are accepted', () => {
	for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'not a url', '']) assert.throws(() => normaliseUrl(bad))
})

test('id is the first 16 hex of sha256 of the normalised link, or of the file sha as a string', () => {
	const norm = 'https://youtube.com/watch?v=Ad7VTVeREOk'
	assert.equal(itemIdForUrl(norm), createHash('sha256').update(norm).digest('hex').slice(0, 16))
	assert.match(itemIdForUrl(norm), /^[0-9a-f]{16}$/)
	const sha = 'a'.repeat(64)
	assert.equal(itemIdForFile(sha), createHash('sha256').update(sha).digest('hex').slice(0, 16))
})

test('slugs are ascii, at most 50 characters, item when nothing is left', () => {
	assert.equal(slugify('Hello, World! 123'), 'hello-world-123')
	assert.equal(slugify('हिंदी में सीखें'), 'item')
	assert.equal(slugify('!!!'), 'item')
	assert.equal(slugify(null), 'item')
	const long = slugify('word-'.repeat(40))
	assert.ok(long.length <= 50 && !long.endsWith('-'))
	assert.equal(slugify('Café déjà vu'), 'cafe-deja-vu')
	assert.equal(folderName('2026-11-02T10:00:00Z', 'हिंदी', 'abcdef0123456789'), '2026-11-02_item_abcdef01')
})

test('links route to the right reader', () => {
	assert.deepEqual(routeLink('https://youtube.com/watch?v=x'), { how: 'video', type: 'youtube' })
	assert.deepEqual(routeLink('https://instagram.com/reel/x'), { how: 'video', type: 'instagram' })
	assert.deepEqual(routeLink('https://instagram.com/someone'), { how: 'page', type: 'site' })
	assert.deepEqual(routeLink('https://vimeo.com/123'), { how: 'video', type: 'video' })
	assert.deepEqual(routeLink('https://example.com/a.mp4'), { how: 'video', type: 'video' })
	assert.deepEqual(routeLink('https://example.com/article'), { how: 'page', type: 'site' })
})

test('non-ASCII links and odd escapes have one spelling (the phone gives the same, test/url_parity_test.dart)', () => {
	assert.equal(canonPart('caf%c3%a9'), 'caf%C3%A9')
	assert.equal(canonPart('café'), 'caf%C3%A9')
	assert.equal(canonPart('%7Euser'), '~user')
	assert.equal(canonPart('a%2Fb'), 'a%2Fb', 'an escape that changes the meaning stays')
	assert.equal(canonPart('x=1%262'), 'x=1%262')
	assert.equal(canonPart('50%'), '50%25')
	assert.equal(normaliseUrl('https://मराठी.भारत/पान'), 'https://xn--d2b1ag0dl.xn--h2brj9c/%E0%A4%AA%E0%A4%BE%E0%A4%A8')
	assert.equal(normaliseUrl('https://example.com/a?b=1&a=ü'), 'https://example.com/a?a=%C3%BC&b=1')
	assert.equal(normaliseUrl('https://example.com/a?utm%5Fsource=x&q=1'), 'https://example.com/a?q=1')
	assert.equal(normaliseUrl('https://example.com/a//'), 'https://example.com/a')
})
