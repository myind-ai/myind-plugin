// One-line computer setup: the worker ships in the plugin, checks in to devices/<computer>.json, and installs a
// background service only when asked. Services are written under the test's own HOME and loaded with fake launchctl /
// systemctl, so nothing on this machine changes.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { devicePath, heartbeatBody, heartbeatDue, safeHost } from '../../plugins/myind/worker/heartbeat.mjs'
import { VERSION } from '../../plugins/myind/worker/version.mjs'
import { makeWorld } from './test-helpers.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REL = devicePath()

function fakeTool(w, name) {
	const path = join(w.bin, `fake-${name}`)
	writeFileSync(path, `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(join(w.fake, `${name}.log`))}, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n')\n`)
	chmodSync(path, 0o755)
	return path
}

// A launchctl that behaves like the real one: `bootout` returns at once but the job takes two more `print`s to stop;
// `bootstrap` fails (exit 5) while it is still there; `load -w` exits 0 and does nothing (what was seen 2026-11-09).
function launchdLike(w) {
	const path = join(w.bin, 'fake-launchd')
	const state = join(w.fake, 'launchd.json')
	writeFileSync(path, `#!/usr/bin/env node
const fs = require('fs')
const file = ${JSON.stringify(state)}
const s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { loaded: true, stopping: 0 }
const [cmd] = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(join(w.fake, 'launchctl.log'))}, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n')
let code = 0
if (cmd === 'bootout') { if (s.loaded) { s.loaded = false; s.stopping = 2 } else code = 3 }
else if (cmd === 'print') { if (s.stopping > 0) s.stopping--; else if (!s.loaded) code = 113 }
else if (cmd === 'bootstrap') { if (s.loaded || s.stopping > 0) code = 5; else s.loaded = true }
fs.writeFileSync(file, JSON.stringify(s))
process.exit(code)
`)
	chmodSync(path, 0o755)
	return { path, loaded: () => JSON.parse(readFileSync(state, 'utf8')).loaded }
}

test('install-service again while the worker runs waits for it to stop, then loads it and checks', (t) => {
	const w = makeWorld(t)
	w.setup()
	const fake = launchdLike(w)
	w.env.MYIND_LAUNCHCTL = fake.path
	const res = w.worker('install-service', '--platform', 'darwin')
	assert.equal(res.code, 0, res.all)
	assert.equal(fake.loaded(), true, 'launchd has the worker after a reinstall')
	const again = w.worker('install-reminder', '--platform', 'darwin')
	assert.equal(again.code, 0, again.all)
})

test('the worker has one copy: in the plugin, with tools/worker holding only tests and the forwarder', () => {
	const runtime = readdirSync(join(ROOT, 'tools', 'worker')).filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs'))
	assert.deepEqual(runtime.sort(), ['myind-worker.mjs', 'test-helpers.mjs'])
	assert.match(readFileSync(join(ROOT, 'tools', 'worker', 'myind-worker.mjs'), 'utf8'), /import '\.\.\/\.\.\/plugins\/myind\/worker\/myind-worker\.mjs'/)
	for (const n of ['myind-worker.mjs', 'run.mjs', 'heartbeat.mjs', 'service.mjs']) assert.ok(existsSync(join(ROOT, 'plugins', 'myind', 'worker', n)), n)
})

test('the marketplace lists the plugin, and the worker version is the plugin version', () => {
	const market = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'))
	const plugin = JSON.parse(readFileSync(join(ROOT, 'plugins', 'myind', '.claude-plugin', 'plugin.json'), 'utf8'))
	assert.equal(market.name, 'myind', 'installed as myind@myind')
	assert.deepEqual(market.plugins.map((p) => [p.name, p.source]), [['myind', './plugins/myind']])
	assert.equal(plugin.name, 'myind')
	assert.equal(plugin.version, VERSION)
})

test('the file name is a safe short host name', () => {
	assert.equal(safeHost('Shantanus-MacBook-Pro.local'), 'shantanus-macbook-pro')
	assert.equal(safeHost('my box (2).lan'), 'my-box-2')
	assert.equal(safeHost('..'), 'computer')
	assert.equal(devicePath('PC.example.com'), 'devices/pc.json')
	const body = heartbeatBody({ host: 'PC.example.com', tools: { gh: '/x/gh', claude: null, whisper: '/y', wpBrain: undefined }, pending: 2, failed: 1, now: new Date('2026-11-02T10:00:00Z') })
	assert.deepEqual(body, { schema: 'myind.device/1', name: 'PC', kind: 'computer', lastRun: '2026-11-02T10:00:00.000Z', version: VERSION, tools: { gh: true, claude: false, whisper: true, wpBrain: false }, pending: 2, failed: 1 })
})

test('the check-in is written on a change, every 30 min while jobs wait, and only twice a day when idle', () => {
	const at = (iso, pending = 0) => heartbeatBody({ host: 'pc', tools: { gh: true }, pending, now: new Date(iso) })
	const old = at('2026-11-04T00:00:00Z')
	const now = (iso) => ({ now: new Date(iso) })
	assert.equal(heartbeatDue(null, old, now('2026-11-04T00:00:00Z')), true, 'first run')
	assert.equal(heartbeatDue(old, at('2026-11-04T01:00:00Z'), now('2026-11-04T01:00:00Z')), false, 'idle, one hour: no commit')
	assert.equal(heartbeatDue(old, at('2026-11-04T11:59:00Z'), now('2026-11-04T11:59:00Z')), false, 'idle, under 12 h')
	assert.equal(heartbeatDue(old, at('2026-11-04T12:00:00Z'), now('2026-11-04T12:00:00Z')), true, 'idle, 12 h: one check-in')
	const waiting = at('2026-11-04T00:00:00Z', 2)
	assert.equal(heartbeatDue(waiting, at('2026-11-04T00:20:00Z', 2), now('2026-11-04T00:20:00Z')), false)
	assert.equal(heartbeatDue(waiting, at('2026-11-04T00:30:00Z', 2), now('2026-11-04T00:30:00Z')), true, 'jobs wait: every 30 min')
	assert.equal(heartbeatDue(old, at('2026-11-04T00:05:00Z', 1), now('2026-11-04T00:05:00Z')), true, 'a change is written at once')
	assert.equal(heartbeatDue(old, at('2026-11-04T00:05:00Z'), { now: new Date('2026-11-04T00:05:00Z'), everyMinutes: 0 }), true, 'setup always writes')
	assert.equal(heartbeatDue(old, at('2026-11-04T05:00:00Z'), { now: new Date('2026-11-04T05:00:00Z'), idleMinutes: 240 }), true, 'heartbeatIdleMinutes')
	// Over a quiet day a watch loop every 5 minutes commits twice, not 48 times.
	let last = old
	let commits = 0
	for (let m = 5; m <= 24 * 60; m += 5) {
		const t = new Date(Date.parse('2026-11-04T00:00:00Z') + m * 60_000)
		const body = heartbeatBody({ host: 'pc', tools: { gh: true }, now: t })
		if (heartbeatDue(last, body, { now: t })) {
			last = body
			commits++
		}
	}
	assert.equal(commits, 2)
})

test('setup checks in, and each run updates the check-in without paths, user names or a commit every pass', (t) => {
	const w = makeWorld(t)
	const res = w.setup()
	assert.match(res.out, /checked in: devices\//)
	const first = JSON.parse(w.originFile(REL))
	assert.equal(first.kind, 'computer')
	assert.equal(first.name, hostname().split('.')[0])
	assert.equal(first.version, VERSION)
	assert.deepEqual(first.tools, { gh: true, claude: true, whisper: true, wpBrain: true })
	assert.equal(first.pending, 0)
	const raw = w.originFile(REL)
	assert.ok(!raw.includes(w.home) && !raw.includes(homedir()) && !raw.replace('myind.device/1', '').includes('/'), 'no paths at all')
	assert.deepEqual(w.commitFiles(`checked in`), [REL], 'committed by explicit path, alone')

	const id = w.addLink('https://youtu.be/beat')
	const before = w.originLog().length
	assert.equal(w.worker('once').code, 0)
	const after = JSON.parse(w.originFile(REL))
	assert.equal(after.pending, 0)
	assert.ok(after.lastRun > first.lastRun || after.lastRun === first.lastRun)
	assert.ok(w.learning(id, 'youtube'))
	assert.equal(w.originLog().length, before + 1, 'the job commit only: nothing changed in the check-in, and it is fresh')

	w.fromOther({ [`failed/${'f'.repeat(16)}.json`]: '{"id":"ffffffffffffffff","error":"x"}\n' })
	assert.equal(w.worker('once').code, 0)
	assert.equal(JSON.parse(w.originFile(REL)).failed, 1, 'a change is written straight away')
})

test('"heartbeat": false in worker.json turns the check-in off', (t) => {
	const w = makeWorld(t)
	w.setup()
	w.sh(w.other, 'pull', '-q', 'origin', 'main')
	const cfgPath = join(w.home, '.myind', 'worker.json')
	writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(readFileSync(cfgPath, 'utf8')), heartbeat: false }))
	w.fromOther({ [`failed/${'e'.repeat(16)}.json`]: '{"id":"eeeeeeeeeeeeeeee","error":"x"}\n' })
	assert.equal(w.worker('once').code, 0)
	assert.equal(JSON.parse(w.originFile(REL)).failed, 0, 'not rewritten')
})

test('launchd-plist only prints', (t) => {
	const w = makeWorld(t)
	w.setup()
	const res = w.worker('launchd-plist')
	assert.equal(res.code, 0)
	assert.match(res.out, /<string>com\.myind\.worker<\/string>/)
	assert.ok(!existsSync(join(w.home, 'Library', 'LaunchAgents')))
})

test('install-service on macOS writes a launch agent that runs a stable copy, and loads it; uninstall removes both', (t) => {
	const w = makeWorld(t)
	w.setup()
	w.env.MYIND_LAUNCHCTL = launchdLike(w).path
	const res = w.worker('install-service', '--platform', 'darwin', '--every', '120')
	assert.equal(res.code, 0, res.all)
	const plist = join(w.home, 'Library', 'LaunchAgents', 'com.myind.worker.plist')
	const body = readFileSync(plist, 'utf8')
	const copy = join(w.home, '.myind', 'worker', 'myind-worker.mjs')
	assert.ok(existsSync(copy) && existsSync(join(w.home, '.myind', 'worker', 'heartbeat.mjs')))
	assert.ok(!readdirSync(join(w.home, '.myind', 'worker')).some((n) => n.endsWith('.test.mjs')))
	assert.ok(body.includes(`<string>${copy}</string>`), 'runs the copy, not the plugin folder that moves on update')
	assert.match(body, /<string>watch<\/string>\s*<string>--every<\/string>\s*<string>120<\/string>/)
	const calls = w.log('launchctl').map((r) => r.argv)
	const steps = calls.map((a) => a[0]).filter((c) => c !== 'print')
	assert.deepEqual(steps, ['bootout', 'bootstrap'])
	assert.deepEqual(calls.find((a) => a[0] === 'bootstrap').slice(2), [plist])

	const off = w.worker('uninstall-service', '--platform', 'darwin')
	assert.equal(off.code, 0, off.all)
	assert.match(off.out, /stopped and removed/)
	assert.ok(!existsSync(plist) && !existsSync(copy))
})

test('install-service on Linux writes a systemd user unit and enables it', (t) => {
	const w = makeWorld(t)
	w.setup()
	w.env.MYIND_SYSTEMCTL = fakeTool(w, 'systemctl')
	w.env.XDG_CONFIG_HOME = join(w.home, 'xdg')
	const res = w.worker('install-service', '--platform', 'linux', '--workpulse')
	assert.equal(res.code, 0, res.all)
	const unit = readFileSync(join(w.home, 'xdg', 'systemd', 'user', 'myind-worker.service'), 'utf8')
	assert.match(unit, /^ExecStart=".+node[^"]*" ".+\/\.myind\/worker\/myind-worker\.mjs" "watch" "--every" "300" "--workpulse"$/m)
	assert.match(unit, /^Restart=always$/m)
	assert.match(unit, /^WantedBy=default\.target$/m)
	assert.deepEqual(w.log('systemctl').map((r) => r.argv), [['--user', 'daemon-reload'], ['--user', 'enable', '--now', 'myind-worker.service']])
	const off = w.worker('uninstall-service', '--platform', 'linux')
	assert.equal(off.code, 0, off.all)
	assert.ok(!existsSync(join(w.home, 'xdg', 'systemd', 'user', 'myind-worker.service')))
})

test('install-service refuses before setup and on other systems, and --no-load only writes', (t) => {
	const w = makeWorld(t)
	assert.match(w.worker('install-service', '--platform', 'darwin').err, /Not set up/)
	w.setup()
	assert.match(w.worker('install-service', '--platform', 'win32').err, /macOS and Linux only/)
	const res = w.worker('install-service', '--platform', 'darwin', '--no-load')
	assert.equal(res.code, 0, res.all)
	assert.match(res.out, /not loaded/)
	assert.ok(existsSync(join(w.home, 'Library', 'LaunchAgents', 'com.myind.worker.plist')))
})
