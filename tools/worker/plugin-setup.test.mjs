// /myind:setup: the worker is found without CLAUDE_PLUGIN_ROOT, the tools are checked, and the brain repository is
// found from the user's own list. Fake gh only; nothing touches the network or this machine's real ~/.claude.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { VERSION } from '../../plugins/myind/worker/version.mjs'
import { makeWorld } from './test-helpers.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PLUGIN = join(ROOT, 'plugins', 'myind')
const WORKER = join(PLUGIN, 'worker', 'myind-worker.mjs')
const SKILL = readFileSync(join(PLUGIN, 'skills', 'setup', 'SKILL.md'), 'utf8')
const LOCATE = SKILL.match(/```bash\n(# locate-worker\n[\s\S]*?)```/)[1]

function tempHome(t) {
	const home = mkdtempSync(join(tmpdir(), 'myind-home-'))
	t.after(() => rmSync(home, { recursive: true, force: true }))
	return home
}

/** Runs the skill's block the way Claude's shell would: CLAUDE_PLUGIN_ROOT empty, from an unrelated folder. */
function locate(home, { pluginRoot } = {}) {
	const script = pluginRoot === undefined ? LOCATE : LOCATE.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot)
	const cwd = join(home, 'somewhere')
	mkdirSync(cwd, { recursive: true })
	writeFileSync(join(cwd, 'myind-worker.mjs'), '// a decoy in the working folder')
	const env = { PATH: process.env.PATH, HOME: home }
	const r = spawnSync('bash', ['-c', script], { cwd, env, encoding: 'utf8' })
	assert.equal(r.status, 0, r.stderr)
	return r.stdout.trim().replace(/^worker: /, '')
}

function fakePlugin(dir) {
	mkdirSync(join(dir, 'worker'), { recursive: true })
	writeFileSync(join(dir, 'worker', 'myind-worker.mjs'), '')
	return join(dir, 'worker', 'myind-worker.mjs')
}

test('locate-worker: nothing installed says so, and a decoy in the working folder is never picked', (t) => {
	assert.equal(locate(tempHome(t)), 'not found')
})

test('locate-worker: the substituted plugin root wins', (t) => {
	const home = tempHome(t)
	assert.equal(locate(home, { pluginRoot: PLUGIN }), WORKER)
})

test('locate-worker: the path the SessionStart hook recorded, skipped when stale', (t) => {
	const home = tempHome(t)
	mkdirSync(join(home, '.myind'))
	writeFileSync(join(home, '.myind', 'plugin.json'), JSON.stringify({ workerPath: join(home, 'gone', 'myind-worker.mjs') }))
	assert.equal(locate(home), 'not found')
	writeFileSync(join(home, '.myind', 'plugin.json'), JSON.stringify({ workerPath: WORKER }))
	assert.equal(locate(home), WORKER)
})

test("locate-worker: Claude Code's installed_plugins.json, then a search of the plugin cache", (t) => {
	const home = tempHome(t)
	const installed = fakePlugin(join(home, 'elsewhere', 'myind-0.2.0'))
	mkdirSync(join(home, '.claude', 'plugins'), { recursive: true })
	const list = { version: 2, plugins: { 'other@x': [{ installPath: '/nope' }], 'myind@myind': [{ scope: 'user', installPath: dirname(dirname(installed)) }] } }
	writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify(list))
	assert.equal(locate(home), installed)
	rmSync(join(home, '.claude', 'plugins', 'installed_plugins.json'))
	fakePlugin(join(home, '.claude', 'plugins', 'cache', 'myind', 'myind', '0.1.0'))
	const newer = fakePlugin(join(home, '.claude', 'plugins', 'cache', 'myind', 'myind', '0.2.0'))
	assert.equal(locate(home), newer)
})

test('the SessionStart hook records the worker path once, and says when the background copy is older', (t) => {
	const home = tempHome(t)
	const hook = join(PLUGIN, 'scripts', 'myind-record.mjs')
	const env = { ...process.env, MYIND_HOME: join(home, '.myind') }
	const first = spawnSync(process.execPath, [hook], { env, encoding: 'utf8' })
	assert.equal(first.status, 0)
	assert.equal(first.stdout, '')
	assert.deepEqual(JSON.parse(readFileSync(join(home, '.myind', 'plugin.json'), 'utf8')), { workerPath: WORKER, version: VERSION })
	mkdirSync(join(home, '.myind', 'worker'))
	writeFileSync(join(home, '.myind', 'worker', 'version.mjs'), "export const VERSION = '0.0.1'\n")
	assert.match(spawnSync(process.execPath, [hook], { env, encoding: 'utf8' }).stdout, /background worker is older: say "\/myind:setup"/)
	writeFileSync(join(home, '.myind', 'worker', 'version.mjs'), `export const VERSION = '${VERSION}'\n`)
	assert.equal(spawnSync(process.execPath, [hook], { env, encoding: 'utf8' }).stdout, '')
	writeFileSync(join(home, '.myind', 'plugin.json'), '{ broken')
	assert.equal(spawnSync(process.execPath, [hook], { env, encoding: 'utf8' }).status, 0, 'a broken file never fails a session')
	const hooks = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf8')).hooks.SessionStart[0].hooks
	assert.ok(hooks.some((h) => h.command.includes('myind-record.mjs') && h.command.endsWith('|| true')))
})

test('doctor: everything present is ready; gh not signed in stops it with the line to run', (t) => {
	const w = makeWorld(t)
	const ok = w.worker('doctor')
	assert.equal(ok.code, 0, ok.all)
	assert.match(ok.out, /^ok node: v\d+/m)
	assert.match(ok.out, /^ok gh: signed in$/m)
	assert.match(ok.out, /ready to set up$/m)
	w.setFake('gh', { authFail: true })
	const bad = w.worker('doctor', '--platform', 'darwin')
	assert.equal(bad.code, 1)
	assert.match(bad.out, /^MISSING gh: not signed in/m)
	assert.match(bad.out, /^ {4}gh auth login$/m)
	assert.match(bad.out, /cannot set up yet: gh$/m)
	const json = JSON.parse(w.worker('doctor', '--json').out)
	assert.deepEqual(json.map((r) => r.name), ['node', 'git', 'gh', 'claude', 'ffmpeg', 'whisper'])
})

test('doctor: an old Node and a missing gh each get the exact install line for the system', async (t) => {
	const { doctor } = await import('../../plugins/myind/worker/doctor.mjs')
	const empty = mkdtempSync(join(tmpdir(), 'myind-nogh-'))
	t.after(() => rmSync(empty, { recursive: true, force: true }))
	const saved = { PATH: process.env.PATH, MYIND_GH: process.env.MYIND_GH, MYIND_HOME: process.env.MYIND_HOME }
	t.after(() => Object.assign(process.env, saved))
	process.env.MYIND_HOME = join(empty, '.myind')
	delete process.env.MYIND_GH
	const git = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()
	writeFileSync(join(empty, 'git'), `#!/bin/sh\nexec ${git} "$@"\n`)
	chmodSync(join(empty, 'git'), 0o755)
	process.env.PATH = empty // git only: no gh, claude or whisper
	const mac = await doctor({ platform: 'darwin', nodeVersion: '20.11.0' })
	const by = Object.fromEntries(mac.map((r) => [r.name, r]))
	assert.equal(by.node.ok, false)
	assert.match(by.node.detail, /needs 22 or newer/)
	assert.equal(by.node.install, 'brew install node')
	assert.equal(by.git.ok, true)
	assert.equal(by.gh.install, 'brew install gh\ngh auth login')
	assert.equal(by.whisper.required, false)
	const linux = Object.fromEntries((await doctor({ platform: 'linux', nodeVersion: '22.18.0' })).map((r) => [r.name, r]))
	assert.equal(linux.node.ok, true)
	assert.match(linux.gh.install, /^sudo apt install gh/)
})

test('find-repos: private repos with the Myind layout, myind.json first; public lookalikes named, never matched', (t) => {
	const w = makeWorld(t)
	w.setFake('gh', {
		repos: [
			{ nameWithOwner: 'me/notes', isPrivate: true },
			{ nameWithOwner: 'me/brain-old', isPrivate: true },
			{ nameWithOwner: 'me/myind-brain', isPrivate: true },
			{ nameWithOwner: 'me/empty', isPrivate: true },
			{ nameWithOwner: 'me/myind-public', isPrivate: false },
			{ nameWithOwner: 'bad name;rm', isPrivate: true },
			{ nameWithOwner: 'me/myind-mail-2019', isPrivate: true },
			{ nameWithOwner: 'me/myind-photos-2026b', isPrivate: true },
			{ nameWithOwner: 'me/myind-files', isPrivate: true },
			// Parts the 2 GB rule opens (storage.json v3): never a brain either.
			{ nameWithOwner: 'me/myind-photos-2026-2', isPrivate: true },
			{ nameWithOwner: 'me/myind-files-3', isPrivate: true },
		],
		contents: { 'me/myind-photos-2026-2': ['README.md', 'myind.json'], 'me/myind-files-3': ['myind.json'], 'me/myind-photos-2026b': ['README.md', 'files', 'myind.json'], 'me/myind-files': ['myind.json'], 'me/myind-mail-2019': ['README.md', 'mail', 'myind.json'], 'me/notes': ['README.md', 'src'], 'me/brain-old': ['library', 'topics'], 'me/myind-brain': ['inbox', 'myind.json', 'library'], 'me/myind-public': ['myind.json'] },
	})
	const res = w.worker('find-repos', '--json')
	assert.equal(res.code, 0, res.all)
	const found = JSON.parse(res.out)
	assert.deepEqual(found.matches, [
		{ repo: 'me/myind-brain', markers: ['myind.json', 'inbox', 'library'] },
		{ repo: 'me/brain-old', markers: ['library'] },
	])
	assert.equal(found.privateRepos, 4)
	assert.deepEqual(found.publicLookalikes, ['me/myind-public'])
	const listed = w.log('gh').map((r) => r.argv)
	assert.deepEqual(listed[0], ['repo', 'list', '--json', 'nameWithOwner,isPrivate', '--limit', '200'])
	assert.ok(!listed.some((a) => a.join(' ').includes('myind-public/contents')), 'a public repository is never even read')
	assert.ok(!listed.some((a) => a.join(' ').includes('myind-mail-2019')), 'a mail year repo is never a brain, never read')
	assert.ok(!listed.some((a) => a.join(' ').includes('myind-photos-2026b') || a.join(' ').includes('myind-files/')), 'a file shelf is never a brain, never read')
	assert.ok(!listed.some((a) => a.join(' ').includes('myind-photos-2026-2') || a.join(' ').includes('myind-files-3')), 'a size part is never a brain, never read')
	const text = w.worker('find-repos')
	assert.match(text.out, /2 of 4 private repositories look like a Myind brain/)
	assert.match(text.out, /warning: me\/myind-public is public/)
})

test('find-repos: gh not signed in fails with what to do', (t) => {
	const w = makeWorld(t)
	w.setFake('gh', { repos: null })
	writeFileSync(join(w.bin, 'gh'), '#!/bin/sh\necho "To get started with GitHub CLI, please run: gh auth login" >&2\nexit 4\n')
	const res = w.worker('find-repos')
	assert.equal(res.code, 1)
	assert.match(res.err, /gh repo list failed: .*Run: gh auth login/)
})
