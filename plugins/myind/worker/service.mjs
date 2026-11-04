// Keeping the worker running: a launchd agent on macOS, a systemd user unit on Linux. `launchd-plist` only prints;
// `install-service` writes and loads, and is only ever run after the user said yes. Nothing here needs sudo.
import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configPath, homeDir, loadConfig, resolveTools } from './config.mjs'
import { oneLine, run, which } from './util.mjs'

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

/** Writes the service file and, unless `load` is false, loads it. Resolves with what was done. */
export async function installService({ platform = process.platform, every = 300, workpulse = false, load = true } = {}) {
	const file = serviceFile(platform)
	const workerPath = copyWorker()
	mkdirSync(dirname(file), { recursive: true })
	writeFileSync(file, platform === 'darwin' ? launchdPlist(workerPath, { every, workpulse }) : systemdUnit(workerPath, { every, workpulse }))
	if (load && platform === 'darwin') {
		const domain = `gui/${process.getuid()}`
		await run(launchctl(), ['bootout', `${domain}/${LABEL}`]) // an older copy, if one is loaded; fine when none is
		const res = await run(launchctl(), ['bootstrap', domain, file])
		if (res.code !== 0) await must(launchctl(), ['load', '-w', file])
	} else if (load) {
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
	rmSync(join(homeDir(), 'worker'), { recursive: true, force: true })
	return { file, removed: had }
}
