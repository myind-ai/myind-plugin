// Small shared helpers: running programs without a shell, secret shapes, one-line errors.
import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/**
 * Runs a program with no shell, so nothing in its arguments is ever interpreted.
 * Resolves with { code, stdout, stderr }; `code` is null when it could not start or was timed out.
 */
export function run(cmd, args, { input, cwd, env, timeoutMs } = {}) {
	return new Promise((resolve) => {
		let child
		try {
			child = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] })
		} catch (e) {
			resolve({ code: null, stdout: '', stderr: String(e.message) })
			return
		}
		const out = []
		const err = []
		let timedOut = false
		const timer = timeoutMs ? setTimeout(() => ((timedOut = true), child.kill('SIGKILL')), timeoutMs) : null
		child.stdout.on('data', (d) => out.push(d))
		child.stderr.on('data', (d) => err.push(d))
		child.stdin.on('error', () => {}) // a program that exits without reading its input is not our failure
		child.on('error', (e) => {
			if (timer) clearTimeout(timer)
			resolve({ code: null, stdout: '', stderr: String(e.message) })
		})
		child.on('close', (code) => {
			if (timer) clearTimeout(timer)
			const stderr = Buffer.concat(err).toString('utf8')
			resolve({ code: timedOut ? null : code, stdout: Buffer.concat(out).toString('utf8'), stderr: timedOut ? `timed out after ${Math.round(timeoutMs / 1000)} s` : stderr })
		})
		child.stdin.end(input ?? '')
	})
}

/** The full path of a program on PATH, or null. */
export function which(name) {
	for (const dir of (process.env.PATH ?? '').split(delimiter)) {
		if (!dir) continue
		const path = join(dir, name)
		try {
			accessSync(path, constants.X_OK)
			return path
		} catch {
			// not here
		}
	}
	return null
}

// The list in storage-format.md, plus WorkPulse's other shapes. Names only ever get reported, never values.
export const SECRET_SHAPES = [
	['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g],
	['API key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|\bsk_(?:live|test)_[A-Za-z0-9]{16,}/g],
	['Supabase token', /\bsbp_[A-Za-z0-9]{20,}/g],
	['NVIDIA key', /\bnvapi-[\w-]{20,}/g],
	['AWS key', /\bAKIA[0-9A-Z]{16}\b/g],
	['Slack token', /\bxox[abpr]-[A-Za-z0-9-]{10,}/g],
	['Google key', /\bAIza[0-9A-Za-z_-]{30,}|\bya29\.[\w-]{20,}/g],
	['Private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
	['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
]

/** The names of the secret shapes in this text, never the values. */
export function secretsIn(text) {
	return SECRET_SHAPES.filter(([, re]) => {
		re.lastIndex = 0
		return re.test(text)
	}).map(([name]) => name)
}

export function redact(text) {
	let out = String(text ?? '')
	for (const [name, re] of SECRET_SHAPES) out = out.replace(re, `[${name} removed]`)
	return out
}

/** One line, no secrets, no home path, short: fit for an error field or a log. */
export function oneLine(text, max = 300) {
	const clean = redact(text).split(homedir()).join('~').replace(/\s+/g, ' ').trim()
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

export const lastLine = (text) => {
	// A crashed Node program ends its stack trace with its own version, which says nothing.
	const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !/^Node\.js v\d/.test(l))
	return lines[lines.length - 1] ?? ''
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A job could not run on this machine as it is now (a tool is missing). The job stays in the inbox. */
export class NeedsTool extends Error {}

/** Not now, but likely later (a tool missing, no network). The job stays in the inbox and
 * its `reason` says why, so the phone shows it. `code` is a short word the phone may use. */
export class Later extends NeedsTool {
	constructor(message, code) {
		super(message)
		this.code = code
	}
}

/** The job can't be done (a private or removed video): it moves to failed/ with `error` and `errorCode`. */
export class JobError extends Error {
	constructor(message, code) {
		super(message)
		this.code = code
	}
}

const ATTRIBUTION = /\b(claude|anthropic|ai|a\.i\.|assistant|chatgpt|gpt|llm|co-?authored)\b/i

/** `learn: <title>` on one line. A title that names an AI tool (it's somebody else's text) gives way to the item's id. */
export function commitSubject(verb, title, id) {
	const line = String(title ?? '').replace(/\s+/g, ' ').trim()
	const short = [...line].slice(0, 72).join('')
	return !short || ATTRIBUTION.test(short) || secretsIn(short).length ? `${verb}: item ${String(id).slice(0, 8)}` : `${verb}: ${short}`
}
