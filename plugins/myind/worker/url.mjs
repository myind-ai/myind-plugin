// Item identity, per docs/myind/storage-format.md: one link is one item.
// The query string is split as written (on `&`, the key is what comes before `=`), and each pair, path segment and
// path is put in one spelling by `canonPart`, the same as the phone's lib/core/url_canon.dart, so both give the same
// id. `URL.search` is never used because its re-encoding differs from Dart's.
import { createHash } from 'node:crypto'

const DROP_KEYS = new Set(['fbclid', 'gclid', 'igsh', 'igshid', 'si', 'ref', 'feature'])
const dropKey = (key) => key.startsWith('utm_') || DROP_KEYS.has(key)
const INSTAGRAM_KINDS = new Set(['reel', 'p', 'tv'])
const keyOf = (pair) => {
	const eq = pair.indexOf('=')
	return eq < 0 ? pair : pair.slice(0, eq)
}

const SAFE = /[A-Za-z0-9\-._~!$'()*,;:@]/ // an escape of these is undone; `& + = / ? #` stay escaped
const PLAIN = /[A-Za-z0-9\-._~!$&'()*+,;=:@/?]/ // kept as written
const HEX = '0123456789ABCDEF'

/**
 * A path, a query or one part of either in one spelling, the same as the phone's `canonPart` (lib/core/url_canon.dart):
 * escapes in upper case, an escaped safe character written plainly, and anything else (spaces, non-ASCII, quotes,
 * braces, a stray `%`) escaped as UTF-8.
 */
export function canonPart(text) {
	const bytes = Buffer.from(String(text), 'utf8')
	let out = ''
	for (let i = 0; i < bytes.length; i++) {
		const c = bytes[i]
		if (c === 0x25 && i + 2 < bytes.length) {
			const pair = String.fromCharCode(bytes[i + 1], bytes[i + 2])
			if (/^[0-9A-Fa-f]{2}$/.test(pair)) {
				const v = parseInt(pair, 16)
				out += SAFE.test(String.fromCharCode(v)) && v < 0x80 ? String.fromCharCode(v) : `%${pair.toUpperCase()}`
				i += 2
				continue
			}
		}
		out += c < 0x80 && PLAIN.test(String.fromCharCode(c)) ? String.fromCharCode(c) : `%${HEX[c >> 4]}${HEX[c & 15]}`
	}
	return out
}

/** The text between the first `?` and the `#`, as written. Empty when there is none. */
function rawQueryOf(input) {
	const hash = input.indexOf('#')
	const noFragment = hash < 0 ? input : input.slice(0, hash)
	const q = noFragment.indexOf('?')
	return q < 0 ? '' : noFragment.slice(q + 1)
}

export function parseHttp(input) {
	let u
	try {
		u = new URL(String(input).trim())
	} catch {
		throw new Error('not a web address')
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http and https links can be processed')
	return u
}

export function normaliseUrl(input) {
	const text = String(input).trim()
	const u = parseHttp(text)
	const host = u.host.toLowerCase().replace(/^(www\.|m\.)/, '')
	const auth = u.username ? `${u.username}${u.password ? `:${u.password}` : ''}@` : ''
	const base = `https://${auth}${host}`
	const segments = u.pathname.split('/').filter(Boolean).map(canonPart)
	const pairs = rawQueryOf(text) === '' ? [] : rawQueryOf(text).split('&').map(canonPart)

	if (host === 'youtu.be' && segments[0]) return `https://youtube.com/watch?v=${segments[0]}`
	if (host === 'youtube.com') {
		if ((segments[0] === 'shorts' || segments[0] === 'live') && segments[1]) return `https://youtube.com/watch?v=${segments[1]}`
		if (segments.length === 1 && segments[0] === 'watch') {
			const v = pairs.find((p) => keyOf(p) === 'v')
			return v === undefined ? 'https://youtube.com/watch' : `https://youtube.com/watch?v=${v.slice(keyOf(v).length + 1)}`
		}
	}
	if (host === 'instagram.com') {
		const kinds = segments.map((s) => (s === 'reels' ? 'reel' : s))
		if (INSTAGRAM_KINDS.has(kinds[0]) && kinds[1]) return `${base}/${kinds[0]}/${kinds[1]}`
		if (INSTAGRAM_KINDS.has(kinds[1]) && kinds[2]) return `${base}/${kinds[1]}/${kinds[2]}`
		return base + stripSlash(canonPart(u.pathname))
	}
	const kept = pairs.filter((p) => !dropKey(keyOf(p)))
	// A stable sort by UTF-16 code unit, the same order Dart's String.compareTo gives; never localeCompare.
	const sorted = kept.map((pair, i) => ({ pair, i, key: keyOf(pair) })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.i - b.i)).map((x) => x.pair)
	return base + stripSlash(canonPart(u.pathname)) + (sorted.length ? `?${sorted.join('&')}` : '')
}

const stripSlash = (path) => path.replace(/\/+$/, '')
const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

export const itemIdForUrl = (normalised) => sha256Hex(normalised).slice(0, 16)
export const itemIdForFile = (fileSha) => sha256Hex(fileSha).slice(0, 16)

/** Lower-case ASCII a-z0-9-, at most 50 characters, `item` when nothing is left (a Devanagari title, say). */
export function slugify(text) {
	const slug = String(text ?? '')
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 50)
		.replace(/-+$/, '')
	return slug || 'item'
}

export const folderName = (savedAt, title, id) => `${String(savedAt).slice(0, 10)}_${slugify(title)}_${id.slice(0, 8)}`

// Links that hold one video or post. Profile and channel pages fall through to the web reader.
const VIDEO_LINKS = [
	/^https:\/\/(music\.)?youtube\.com\/watch\?/,
	/^https:\/\/instagram\.com\/(reel|p|tv)\//,
	/^https:\/\/(vm\.|vt\.)?tiktok\.com\/(@[\w.-]+\/video\/|t\/|\w)/,
	/^https:\/\/vimeo\.com\/\d/,
	/^https:\/\/(x|twitter)\.com\/\w+\/status\//,
	/^https:\/\/facebook\.com\/(reel\/|watch|share\/[vr]\/|[\w.]+\/videos\/)/,
	/^https:\/\/fb\.watch\//,
	/^https:\/\/linkedin\.com\/(posts\/|feed\/update\/)/,
	/^https:\/\/loom\.com\/share\//,
	/^https:\/\/dailymotion\.com\/video\//,
	/\.(mp4|m4a|mp3|webm|mov|mkv|wav|ogg)(\?|$)/i,
]

/** How to read a normalised link: `how` is video or page, `type` is the library folder type. */
export function routeLink(normalised) {
	if (/^https:\/\/(music\.)?youtube\.com\/watch\?/.test(normalised)) return { how: 'video', type: 'youtube' }
	if (/^https:\/\/instagram\.com\/(reel|p|tv)\//.test(normalised)) return { how: 'video', type: 'instagram' }
	if (VIDEO_LINKS.some((re) => re.test(normalised))) return { how: 'video', type: 'video' }
	return { how: 'page', type: 'site' }
}
