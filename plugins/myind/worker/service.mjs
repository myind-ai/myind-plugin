// Keeping the worker running: a launchd agent on macOS, a systemd user unit on Linux. `launchd-plist` only prints;
// `install-service` writes and loads, and is only ever run after the user said yes. Nothing here needs sudo.
import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configPath, homeDir, loadConfig, resolveTools } from './config.mjs'
import { oneLine, run, sleep, which } from './util.mjs'

export const LABEL = 'com.myind.worker'
export const UNIT = 'myind-worker.service'
const HERE = dirname(fileURLToPath(import.meta.url))

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Folders the service needs on PATH: today's Node and wherever each tool was found. */
export function servicePath() {
	const tools = resolveTools(existsSync(configPath()) ? loadConfig() : {})
	const found = [tools.claude, tools.gh, tools.whisper, tools.ffmpeg, which('git'), which('python3')].filter(Boolean).map((p) => dirname(p))
	return [...new Set([dirname(process.execPath), ...found, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])].join(':')
}

const watchArgs = (workerPath, { every = 300, workpulse = false } = {}) => [process.execPath, workerPath, 'watch', '--every', String(every), ...(workpulse ? ['--workpulse'] : [])]

export function launchdPlist(workerPath, opts = {}) {
	const log = join(homeDir(), 'worker.log')
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array>
${watchArgs(workerPath, opts).map((a) => `		<string>${xml(a)}</string>`).join('\n')}
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>${xml(opts.path ?? servicePath())}</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>60</integer>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>${xml(log)}</string>
	<key>StandardErrorPath</key>
	<string>${xml(log)}</string>
</dict>
</plist>
`
}

// systemd splits ExecStart on spaces and treats % and \ specially, so every argument is quoted and escaped.
const sdQuote = (a) => `"${String(a).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`

export function systemdUnit(workerPath, opts = {}) {
	const log = join(homeDir(), 'worker.log')
	return `[Unit]
Description=Myind worker: processes what your phone queued in your private Myind repository
After=network-online.target

[Service]
Type=simple
ExecStart=${watchArgs(workerPath, opts).map(sdQuote).join(' ')}
Environment=${sdQuote(`PATH=${opts.path ?? servicePath()}`)}
Restart=always
RestartSec=60
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`
}

export function serviceFile(platform = process.platform) {
	if (platform === 'darwin') return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
	if (platform === 'linux') return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', UNIT)
	throw new Error(`running in the background is set up for macOS and Linux only; on ${platform}, keep "myind-worker watch" running yourself`)
}

/**
 * The plugin's own folder moves on every plugin update, so the service runs a copy in ~/.myind/worker/ instead.
 * Run /myind:setup (or install-service) again after an update to refresh it.
 */
export function copyWorker(dest = join(homeDir(), 'worker')) {
	mkdirSync(dest, { recursive: true })
	if (realpathSync(dest) === realpathSync(HERE)) return join(dest, 'myind-worker.mjs') // already running from the copy
	for (const n of readdirSync(dest)) if (n.endsWith('.mjs')) rmSync(join(dest, n))
	for (const n of readdirSync(HERE)) if (n.endsWith('.mjs') && !n.endsWith('.test.mjs')) copyFileSync(join(HERE, n), join(dest, n))
	return join(dest, 'myind-worker.mjs')
}

const launchctl = () => process.env.MYIND_LAUNCHCTL || 'launchctl'
const systemctl = () => process.env.MYIND_SYSTEMCTL || 'systemctl'

async function must(cmd, args) {
	const res = await run(cmd, args)
	if (res.code !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${oneLine(res.stderr || res.stdout || 'could not start')}`)
	return res
}

/**
 * (Re)loads a launch agent and proves launchd has it. `bootout` returns before a running job has stopped; a `bootstrap`
 * sent then fails, and the old `load -w` fallback exits 0 doing nothing, so a reinstall left the worker unloaded
 * (seen 2026-11-09). So: wait until `print` no longer finds the old job, bootstrap, then `print` must find the new one.
 */
async function reloadAgent(label, file) {
	const target = `gui/${process.getuid()}/${label}`
	await run(launchctl(), ['bootout', target]) // fine when none is loaded
	const until = Date.now() + 15_000
	while ((await run(launchctl(), ['print', target])).code === 0 && Date.now() < until) await sleep(250)
	let res = { code: 1 }
	for (let attempt = 0; attempt < 5 && res.code !== 0; attempt++) {
		if (attempt) await sleep(1000)
		res = await run(launchctl(), ['bootstrap', `gui/${process.getuid()}`, file])
	}
	if ((await run(launchctl(), ['print', target])).code !== 0) throw new Error(`launchd did not load ${label}: ${oneLine(res.stderr || res.stdout || `bootstrap exit ${res.code}`)}. Try: launchctl bootstrap gui/${process.getuid()} ${file}`)
}

/** Writes the service file and, unless `load` is false, loads it. Resolves with what was done. */
export async function installService({ platform = process.platform, every = 300, workpulse = false, load = true } = {}) {
	const file = serviceFile(platform)
	const workerPath = copyWorker()
	mkdirSync(dirname(file), { recursive: true })
	writeFileSync(file, platform === 'darwin' ? launchdPlist(workerPath, { every, workpulse }) : systemdUnit(workerPath, { every, workpulse }))
	if (load && platform === 'darwin') await reloadAgent(LABEL, file)
	else if (load) {
		await must(systemctl(), ['--user', 'daemon-reload'])
		await must(systemctl(), ['--user', 'enable', '--now', UNIT])
	}
	return { file, workerPath, loaded: load }
}

/** Unloads and removes the service file and the copied worker. Resolves with whether there was one. */
export async function uninstallService({ platform = process.platform, load = true } = {}) {
	const file = serviceFile(platform)
	const had = existsSync(file)
	if (load && platform === 'darwin') await run(launchctl(), ['bootout', `gui/${process.getuid()}/${LABEL}`])
	else if (load) await run(systemctl(), ['--user', 'disable', '--now', UNIT])
	rmSync(file, { force: true })
	if (load && platform === 'linux') await run(systemctl(), ['--user', 'daemon-reload'])
	const reminderOn = (() => {
		try {
			return reminderFiles(platform).some((f) => existsSync(f))
		} catch {
			return false
		}
	})()
	if (!reminderOn) rmSync(join(homeDir(), 'worker'), { recursive: true, force: true }) // the weekly reminder runs that copy too
	return { file, removed: had }
}

// The weekly reminder: once a week it runs `report --write --notify` (where the tokens went, what waits for words).
// A calendar job, not a daemon: nothing runs between reminders. Only installed after the user said yes.
export const REMINDER_LABEL = 'com.myind.weekly'
export const REMINDER_UNIT = 'myind-weekly'
const reportArgs = (workerPath) => [process.execPath, workerPath, 'report', '--days', '7', '--write', '--notify']

export function reminderPlist(workerPath, { weekday = 1, hour = 10, path } = {}) {
	const log = join(homeDir(), 'worker.log')
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${REMINDER_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
${reportArgs(workerPath).map((a) => `		<string>${xml(a)}</string>`).join('\n')}
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>${xml(path ?? servicePath())}</string>
	</dict>
	<key>StartCalendarInterval</key>
	<dict>
		<key>Weekday</key>
		<integer>${Number(weekday)}</integer>
		<key>Hour</key>
		<integer>${Number(hour)}</integer>
		<key>Minute</key>
		<integer>0</integer>
	</dict>
	<key>StandardOutPath</key>
	<string>${xml(log)}</string>
	<key>StandardErrorPath</key>
	<string>${xml(log)}</string>
</dict>
</plist>
`
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export function reminderUnits(workerPath, { weekday = 1, hour = 10, path } = {}) {
	return {
		service: `[Unit]\nDescription=Myind weekly report\n\n[Service]\nType=oneshot\nExecStart=${reportArgs(workerPath).map(sdQuote).join(' ')}\nEnvironment=${sdQuote(`PATH=${path ?? servicePath()}`)}\n`,
		timer: `[Unit]\nDescription=Myind weekly report\n\n[Timer]\nOnCalendar=${DAYS[Number(weekday) % 7]} *-*-* ${String(Number(hour)).padStart(2, '0')}:00:00\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`,
	}
}

function reminderFiles(platform) {
	if (platform === 'darwin') return [join(homedir(), 'Library', 'LaunchAgents', `${REMINDER_LABEL}.plist`)]
	if (platform === 'linux') {
		const dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user')
		return [join(dir, `${REMINDER_UNIT}.service`), join(dir, `${REMINDER_UNIT}.timer`)]
	}
	throw new Error(`the weekly reminder is set up for macOS and Linux only; on ${platform}, run "myind-worker report" yourself`)
}

export async function installReminder({ platform = process.platform, weekday = 1, hour = 10, load = true } = {}) {
	if (!(weekday >= 0 && weekday <= 6) || !(hour >= 0 && hour <= 23)) throw new Error('--weekday is 0-6 (0 = Sunday), --hour is 0-23')
	const files = reminderFiles(platform)
	const workerPath = copyWorker()
	mkdirSync(dirname(files[0]), { recursive: true })
	if (platform === 'darwin') {
		writeFileSync(files[0], reminderPlist(workerPath, { weekday, hour }))
		if (load) await reloadAgent(REMINDER_LABEL, files[0])
	} else {
		const u = reminderUnits(workerPath, { weekday, hour })
		writeFileSync(files[0], u.service)
		writeFileSync(files[1], u.timer)
		if (load) {
			await must(systemctl(), ['--user', 'daemon-reload'])
			await must(systemctl(), ['--user', 'enable', '--now', `${REMINDER_UNIT}.timer`])
		}
	}
	return { files, workerPath, loaded: load, when: `${DAYS[weekday]} ${String(hour).padStart(2, '0')}:00` }
}

export async function uninstallReminder({ platform = process.platform, load = true } = {}) {
	const files = reminderFiles(platform)
	const had = files.some((f) => existsSync(f))
	if (load && platform === 'darwin') await run(launchctl(), ['bootout', `gui/${process.getuid()}/${REMINDER_LABEL}`])
	else if (load) await run(systemctl(), ['--user', 'disable', '--now', `${REMINDER_UNIT}.timer`])
	for (const f of files) rmSync(f, { force: true })
	return { files, removed: had }
}
