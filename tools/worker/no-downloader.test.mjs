// Guard: Myind never fetches a video's content, so no downloader is named, installed, prompted for or run anywhere in
// the plugin, the worker's tests, or the phone app (lib/). The names are built from parts so this file doesn't name them.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const NAMES = [['yt', 'dlp'], ['youtube', 'dl'], ['yt', 'dl', 'core'], ['youtube', 'explode'], ['py', 'tube'], ['insta', 'loader'], ['gallery', 'dl'], ['lux', 'downloader']]
// Each joined with -, _ or nothing, any case.
export const DOWNLOADER = new RegExp(NAMES.map((p) => p.join('[-_]?')).join('|'), 'i')

function* files(dir) {
	for (const name of readdirSync(dir)) {
		if (name === 'node_modules' || name.startsWith('.dart_tool')) continue
		const path = join(dir, name)
		if (statSync(path).isDirectory()) yield* files(path)
		else if (/\.(mjs|js|json|md|dart|sh|ya?ml|txt)$/.test(name)) yield path
	}
}

test('no downloader is named anywhere in the plugin, the worker tests or the phone app', () => {
	const hits = []
	for (const top of ['plugins', 'lib', 'tools/worker', 'tools/export-plugin', '.claude-plugin']) {
		if (!existsSync(join(ROOT, top))) continue
		for (const f of files(join(ROOT, top))) {
			const lines = readFileSync(f, 'utf8').split('\n')
			lines.forEach((l, i) => DOWNLOADER.test(l) && hits.push(`${relative(ROOT, f)}:${i + 1}`))
		}
	}
	assert.deepEqual(hits, [])
})

test('the guard does catch the names', () => {
	for (const p of NAMES) assert.ok(DOWNLOADER.test(p.join('-')) && DOWNLOADER.test(p.join('_').toUpperCase()))
	assert.ok(!DOWNLOADER.test('youtube link, downloads folder, Whisper'))
})
