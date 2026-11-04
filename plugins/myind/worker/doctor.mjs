// What /myind:setup checks before anything else, and the exact line to install whatever is missing.
// It installs nothing: `myind-worker install <tool> --yes` does, after the user said yes.
import { configPath, loadConfig, resolveTools } from './config.mjs'
import { planLines, plans } from './install.mjs'
import { llmName } from './llm.mjs'
import { existsSync } from 'node:fs'
import { oneLine, run, which } from './util.mjs'
import { whisperEngine } from './whisper.mjs'

export const MIN_NODE = 22
/** One row per tool: { name, ok, required, detail, install }. `required` rows that aren't ok stop the setup. */
export async function doctor({ platform = process.platform, nodeVersion = process.versions.node } = {}) {
	const plan = plans(platform)
	const line = (name) => planLines(plan[name])
	const cfg = existsSync(configPath()) ? loadConfig() : {}
	const tools = resolveTools(cfg)
	const rows = []
	const major = Number(String(nodeVersion).split('.')[0])
	rows.push({ name: 'node', ok: major >= MIN_NODE, required: true, detail: `v${nodeVersion}${major >= MIN_NODE ? '' : `, needs ${MIN_NODE} or newer`}`, install: line('node') })
	const git = which('git')
	rows.push({ name: 'git', ok: !!git, required: true, detail: git ? 'present' : 'missing', install: line('git') })
	if (!tools.gh) rows.push({ name: 'gh', ok: false, required: true, detail: 'missing', install: `${line('gh')}\ngh auth login` })
	else {
		const auth = await run(tools.gh, ['auth', 'status'])
		rows.push({ name: 'gh', ok: auth.code === 0, required: true, detail: auth.code === 0 ? 'signed in' : `not signed in: ${oneLine(auth.stderr || auth.stdout, 120)}`, install: 'gh auth login' })
	}
	rows.push({ name: 'claude', ok: !!tools.claude, required: false, detail: tools.claude ? 'present' : 'missing: notes are saved with picked sentences instead', install: line('claude') })
	const llm = llmName(cfg)
	if (llm !== 'claude') rows.push({ name: llm, ok: !!tools[llm], required: false, detail: tools[llm] ? 'present: reads text ("llm" in worker.json); images and PDFs still need claude' : 'missing: notes are saved with picked sentences instead', install: llm === 'codex' ? 'npm install -g @openai/codex' : 'npm install -g @google/gemini-cli' })
	rows.push({ name: 'ffmpeg', ok: !!tools.ffmpeg, required: false, detail: tools.ffmpeg ? 'present' : 'missing: Whisper and some photo formats need it', install: line('ffmpeg') })
	const engine = whisperEngine(tools, cfg)
	const cppNoModel = !engine && tools.whisperCpp && tools.ffmpeg
	rows.push({
		name: 'whisper',
		ok: !!engine,
		required: false,
		detail: engine ? engine.detail : cppNoModel ? 'whisper.cpp is installed but has no model in ~/.myind/models' : 'missing: recordings and video files you share wait in the inbox',
		install: cppNoModel ? planLines(plan.whisper.slice(-1)) : line('whisper'),
	})
	return rows
}

export function printDoctor(rows) {
	for (const r of rows) {
		console.log(`${r.ok ? 'ok' : r.required ? 'MISSING' : 'optional'} ${r.name}: ${r.detail}`)
		if (!r.ok) for (const l of r.install.split('\n')) console.log(`    ${l}`)
	}
	const blocking = rows.filter((r) => r.required && !r.ok).map((r) => r.name)
	console.log(blocking.length ? `cannot set up yet: ${blocking.join(', ')}` : 'ready to set up')
	return blocking.length ? 1 : 0
}

/** Names `install --missing` would install: the optional tools that aren't ok, for what this computer is set to do. */
export function missingNames(rows) {
	return rows.filter((r) => !r.ok && ['git', 'gh', 'claude', 'ffmpeg', 'whisper', 'node'].includes(r.name)).map((r) => r.name)
}
