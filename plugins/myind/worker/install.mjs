// The exact install steps for each tool, per system, and `myind-worker install`, which runs them only with
// --yes (the setup skill asks the user first). Steps are argv lists run with no shell; a step that needs a shell
// (`curl … | bash`) is only ever printed, for the user to run.
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homeDir } from './config.mjs'
import { lastLine, oneLine, run } from './util.mjs'

const CPP_MODEL_URL = (name) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`
export const CPP_MODELS = ['base', 'small', 'large-v3-turbo']

const shell = (line) => ({ shell: line })

/** One plan per tool and system: a list of argv steps (or { shell } lines to print). */
export function plans(platform, { model = 'small' } = {}) {
	const modelFile = join(homeDir(), 'models', `ggml-${model}.bin`)
	const fetchModel = ['curl', '-L', '--fail', '-o', modelFile, CPP_MODEL_URL(model)]
	const all = {
		darwin: {
			node: [['brew', 'install', 'node']],
			git: [['xcode-select', '--install']],
			gh: [['brew', 'install', 'gh']],
			claude: [shell('curl -fsSL https://claude.ai/install.sh | bash')],
			ffmpeg: [['brew', 'install', 'ffmpeg']],
			whisper: [['brew', 'install', 'whisper-cpp', 'ffmpeg'], fetchModel],
			'openai-whisper': [['brew', 'install', 'ffmpeg', 'pipx'], ['pipx', 'install', 'openai-whisper']],
		},
		linux: {
			node: [shell('curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && nvm install 22')],
			git: [['sudo', 'apt', 'install', '-y', 'git']],
			gh: [shell('sudo apt install gh    # or see https://github.com/cli/cli/blob/trunk/docs/install_linux.md')],
			claude: [shell('curl -fsSL https://claude.ai/install.sh | bash')],
			ffmpeg: [['sudo', 'apt', 'install', '-y', 'ffmpeg']],
			whisper: [['sudo', 'apt', 'install', '-y', 'ffmpeg', 'pipx'], ['pipx', 'install', 'openai-whisper']],
			'openai-whisper': [['sudo', 'apt', 'install', '-y', 'ffmpeg', 'pipx'], ['pipx', 'install', 'openai-whisper']],
		},
		win32: {
			node: [['winget', 'install', '-e', '--id', 'OpenJS.NodeJS.LTS']],
			git: [['winget', 'install', '-e', '--id', 'Git.Git']],
			gh: [['winget', 'install', '-e', '--id', 'GitHub.cli']],
			claude: [shell('irm https://claude.ai/install.ps1 | iex    # in PowerShell')],
			ffmpeg: [['winget', 'install', '-e', '--id', 'Gyan.FFmpeg']],
			whisper: [['winget', 'install', '-e', '--id', 'Gyan.FFmpeg'], ['winget', 'install', '-e', '--id', 'Python.Python.3.12'], ['py', '-m', 'pip', 'install', '-U', 'openai-whisper']],
			'openai-whisper': [['winget', 'install', '-e', '--id', 'Python.Python.3.12'], ['py', '-m', 'pip', 'install', '-U', 'openai-whisper']],
		},
	}
	return all[platform] ?? all.linux
}

export const stepLine = (step) => (step.shell ? step.shell : step.map((a) => (/[\s"'$`\\]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a)).join(' '))
export const planLines = (steps) => steps.map(stepLine).join('\n')

/**
 * Runs the steps for each named tool, in order, and stops a tool's plan at its first failing step.
 * Without `yes` it only prints what it would run. Shell lines are always printed, never run.
 */
export async function runInstall(names, { platform = process.platform, yes = false, model, log = console.log, runner = run, updates = {} } = {}) {
	const table = plans(platform, { model })
	const results = []
	for (const name of names) {
		const steps = updates[name] ?? table[name]
		if (!steps) {
			log(`unknown tool ${oneLine(name, 30)}: one of ${Object.keys(table).join(', ')}`)
			results.push({ name, ok: false })
			continue
		}
		log(`${yes ? 'installing' : 'would run, for'} ${name}:`)
		let ok = true
		for (const step of steps) {
			if (step.shell) {
				log(`    run this yourself: ${step.shell}`)
				ok = false
				continue
			}
			log(`    ${stepLine(step)}`)
			if (!yes) continue
			if (step[0] === 'curl') mkdirSync(dirname(step[step.indexOf('-o') + 1]), { recursive: true })
			const res = await runner(step[0], step.slice(1), { timeoutMs: 30 * 60 * 1000 })
			if (res.code !== 0) {
				log(`    failed: ${oneLine(lastLine(res.stderr) || lastLine(res.stdout) || 'could not start', 200)}`)
				ok = false
				break
			}
		}
		results.push({ name, ok: yes && ok })
	}
	if (!yes) log('nothing was run. Add --yes to run the steps above.')
	return results
}
