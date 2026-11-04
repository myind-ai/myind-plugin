// ~/.myind/worker.json, the run state, the single-run lock and where each tool lives. No token is ever stored here:
// git and gh use the user's own login.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { which } from './util.mjs'

export const homeDir = () => process.env.MYIND_HOME || join(homedir(), '.myind')
export const configPath = () => join(homeDir(), 'worker.json')
const statePath = () => join(homeDir(), 'state.json')
const lockPath = () => join(homeDir(), 'worker.lock')

export function loadConfig() {
	if (!existsSync(configPath())) throw new Error('Not set up. Run: myind-worker setup --repo owner/name')
	const cfg = JSON.parse(readFileSync(configPath(), 'utf8'))
	if (!cfg.dir || !cfg.repo) throw new Error('worker.json has no repo or dir. Run setup again.')
	return cfg
}

function writeJsonAtomic(path, value) {
	mkdirSync(dirname(path), { recursive: true })
	const tmp = `${path}.${process.pid}.tmp`
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
	renameSync(tmp, path)
}

export const saveConfig = (cfg) => writeJsonAtomic(configPath(), cfg)
export const saveState = (state) => writeJsonAtomic(statePath(), state)
export function loadState() {
	try {
		return JSON.parse(readFileSync(statePath(), 'utf8'))
	} catch {
		return {}
	}
}

export const defaultDevice = () => `pc-${hostname().split('.')[0].toLowerCase().replace(/[^a-z0-9-]+/g, '-') || 'worker'}`

const candidates = {
	wpBrain: () => [
		join(homedir(), 'Documents/GitHub/workpluse/workpulse-main/cli/wp-brain.mjs'),
		join(homedir(), 'workpulse-extension/cli/wp-brain.mjs'),
	],
}

const present = (path) => (path && existsSync(path) ? path : null)

/** Environment first, then worker.json, then a default that exists. Null when none does. */
export function resolveTools(cfg = {}) {
	const env = process.env
	const program = (envName, cfgKey, name) => env[envName] || cfg[cfgKey] || which(name)
	return {
		wpBrain: present(env.MYIND_WP_BRAIN) ?? present(cfg.wpBrain) ?? present(env.WP_CLI) ?? candidates.wpBrain().find((p) => existsSync(p)) ?? null,
		claude: program('MYIND_CLAUDE', 'claude', 'claude'),
		gh: program('MYIND_GH', 'gh', 'gh'),
		whisper: program('MYIND_WHISPER', 'whisper', 'whisper'),
		whisperCpp: program('MYIND_WHISPER_CPP', 'whisperCpp', 'whisper-cli'),
		codex: program('MYIND_CODEX', 'codex', 'codex'),
		gemini: program('MYIND_GEMINI', 'gemini', 'gemini'),
		ffmpeg: which('ffmpeg'),
		ffprobe: which('ffprobe'),
		sips: which('sips'),
	}
}

/** How to start a tool at this path: Python and Node scripts need their interpreter, anything else runs itself. */
export function commandFor(path) {
	if (path.endsWith('.py')) return { cmd: which('python3') ?? 'python3', args: [path] }
	if (path.endsWith('.mjs') || path.endsWith('.js')) return { cmd: process.execPath, args: [path] }
	return { cmd: path, args: [] }
}

function pidAlive(pid) {
	try {
		process.kill(pid, 0)
		return true
	} catch (e) {
		return e.code === 'EPERM'
	}
}

/** Only one run at a time, so `watch` and a manual `once` can't race on one clone. Returns a release function, or null when busy. */
export function takeLock() {
	mkdirSync(homeDir(), { recursive: true })
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(lockPath(), 'wx')
			writeSync(fd, String(process.pid))
			closeSync(fd)
			return () => rmSync(lockPath(), { force: true })
		} catch (e) {
			if (e.code !== 'EEXIST') throw e
			const pid = Number(readFileSync(lockPath(), 'utf8'))
			if (pid && pidAlive(pid)) return null
			rmSync(lockPath(), { force: true }) // left by a run that died
		}
	}
	return null
}
