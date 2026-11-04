// Which command-line AI reads the text: `"llm"` in worker.json. `claude` (the default) is the strictest: no tools at
// all. `codex` runs `codex exec` in its read-only sandbox, `gemini` runs `gemini` in its default approval mode, both
// with no user config or extensions where the CLI allows it and in an empty folder. Source text is untrusted either
// way: the system words and the random markers go in the prompt, and every reply is validated as data and never run.
// Flags checked against `codex exec --help` 0.166.0 and `gemini --help` 0.25.2 (2026-11-04), not against a live model.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parseJsonReply } from './schema.mjs'
import { oneLine, run } from './util.mjs'

export const LLMS = ['claude', 'codex', 'gemini']
const TIMEOUT_MS = 20 * 60 * 1000

/** The configured reader, `claude` when unset or unknown. */
export const llmName = (cfg = {}) => (LLMS.includes(cfg.llm) ? cfg.llm : 'claude')

/** `processedBy` for an item this reader wrote in full: `pc-claude`, `pc-codex`, `pc-gemini`. */
export const processedByFor = (cfg) => `pc-${llmName(cfg)}`

/** The program for the configured reader, or null when it isn't installed. */
export const llmTool = (tools, cfg) => tools[llmName(cfg)] ?? null

export function codexArgs(cfg, { cwd, out }) {
	return ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--color', 'never', '-C', cwd, '-o', out, ...(cfg.codexModel ? ['-m', cfg.codexModel] : []), '-']
}

export const geminiArgs = (cfg) => ['--approval-mode', 'default', '-e', 'none', '-o', 'json', ...(cfg.geminiModel ? ['-m', cfg.geminiModel] : [])]

/** One text call to codex or gemini. { ok, text } or { ok: false, error }. [system] goes first in the prompt. */
export async function askOther(tools, cfg, { system, prompt, cwd, env }) {
	const name = llmName(cfg)
	const cmd = tools[name]
	if (!cmd) return { ok: false, error: `${name} is not installed` }
	const input = `${system}\n\n${prompt}`
	if (name === 'codex') {
		const dir = mkdtempSync(join(cwd, 'codex-'))
		try {
			const out = join(dir, 'reply.txt')
			const res = await run(cmd, codexArgs(cfg, { cwd: dir, out }), { input, cwd: dir, env, timeoutMs: TIMEOUT_MS })
			if (res.code !== 0) return { ok: false, error: oneLine(res.stderr || res.stdout || 'codex failed') }
			let text = ''
			try {
				text = readFileSync(out, 'utf8')
			} catch {
				// no last message written
			}
			return text.trim() ? { ok: true, text } : { ok: false, error: 'codex gave no result' }
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	}
	const res = await run(cmd, geminiArgs(cfg), { input, cwd, env, timeoutMs: TIMEOUT_MS })
	if (res.code !== 0) return { ok: false, error: oneLine(res.stderr || res.stdout || 'gemini failed') }
	const outer = parseJsonReply(res.stdout)
	if (!outer || outer.error || typeof outer.response !== 'string') return { ok: false, error: oneLine(outer?.error?.message ?? 'gemini gave no result') }
	return { ok: true, text: outer.response }
}
