// Speech to timed text on this computer, with either Whisper: openai-whisper (`whisper`, Python) or whisper.cpp
// (`whisper-cli`, needs a ggml model file and ffmpeg). Nothing here leaves the computer.
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { homeDir } from './config.mjs'
import { NeedsTool, lastLine, run } from './util.mjs'
import { parseVtt } from './vtt.mjs'

// Best first. "for-tests" models ship with Homebrew's whisper.cpp and only print noise.
const CPP_MODELS = ['large-v3-turbo', 'large-v3', 'medium', 'small', 'base', 'tiny']

export function openaiModel(cfg = {}) {
	if (process.env.YT_LEARN_WHISPER_MODEL) return process.env.YT_LEARN_WHISPER_MODEL
	if (cfg.whisperModel) return cfg.whisperModel
	return existsSync(join(homedir(), '.cache/whisper/large-v3-turbo.pt')) ? 'large-v3-turbo' : 'base'
}

/** The whisper.cpp model to use: `whisperCppModel` in worker.json, else the best ggml file in ~/.myind/models. */
export function cppModel(cfg = {}) {
	if (cfg.whisperCppModel) return existsSync(cfg.whisperCppModel) ? cfg.whisperCppModel : null
	const dir = join(homeDir(), 'models')
	if (!existsSync(dir)) return null
	const files = readdirSync(dir).filter((n) => /^ggml-.*\.bin$/.test(n) && !n.includes('for-tests'))
	for (const name of CPP_MODELS) {
		const hit = files.find((n) => n === `ggml-${name}.bin` || n.startsWith(`ggml-${name}.`) || n.startsWith(`ggml-${name}-`))
		if (hit) return join(dir, hit)
	}
	return files[0] ? join(dir, files[0]) : null
}

/** Which Whisper this computer can run: { engine: 'openai' | 'cpp', detail } or null. `whisperEngine` picks one. */
export function whisperEngine(tools, cfg = {}) {
	const want = cfg.whisperEngine
	const cpp = tools.whisperCpp && tools.ffmpeg && cppModel(cfg) ? { engine: 'cpp', detail: `whisper.cpp with ${cppModel(cfg).split('/').pop()}` } : null
	const openai = tools.whisper ? { engine: 'openai', detail: `openai-whisper, model ${openaiModel(cfg)}` } : null
	if (want === 'cpp') return cpp
	if (want === 'openai') return openai
	return openai ?? cpp
}

/** Audio or video file to cues ({ start, line }). Throws NeedsTool when no Whisper is set up here. */
export async function transcribeToCues(ctx, path, outDir, { lang } = {}) {
	const { tools, cfg } = ctx
	const engine = whisperEngine(tools, cfg)
	if (!engine) throw new NeedsTool('whisper is not installed (openai-whisper, or whisper.cpp with a model): run myind-worker doctor')
	mkdirSync(outDir, { recursive: true })
	let res
	if (engine.engine === 'openai') {
		res = await run(tools.whisper, [path, '--model', openaiModel(cfg), '--output_format', 'vtt', '--output_dir', outDir, ...(lang ? ['--language', lang] : [])])
	} else {
		const wav = join(outDir, 'speech.wav')
		const conv = await run(tools.ffmpeg, ['-y', '-v', 'error', '-i', path, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav])
		if (conv.code !== 0) throw new Error(`ffmpeg could not read the audio: ${lastLine(conv.stderr)}`)
		res = await run(tools.whisperCpp, ['-m', cppModel(cfg), '-f', wav, '-l', lang || 'auto', '-ovtt', '-of', join(outDir, 'speech'), '-np'])
	}
	const made = readdirSync(outDir).find((n) => n.endsWith('.vtt'))
	if (!made) throw new Error(`whisper failed: ${lastLine(res.stderr) || lastLine(res.stdout) || 'no transcript was written'}`)
	return parseVtt(readFileSync(join(outDir, made), 'utf8'))
}
