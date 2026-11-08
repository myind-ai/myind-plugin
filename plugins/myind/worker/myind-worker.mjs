#!/usr/bin/env node
// Myind PC worker. Pulls the user's private repo, processes inbox jobs with wp-brain / Whisper / claude, pushes results.
// It never fetches a video's content: a video link is read from words the owner brings (`words`, or pasted on the phone).
// Node >= 22, no npm dependencies. See README.md and docs/myind/storage-format.md.
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configPath, defaultDevice, homeDir, loadConfig, resolveTools, saveConfig } from './config.mjs'
import { checkBranch, cloneOrSwitch, listBranches } from './connect.mjs'
import { doctor, missingNames, printDoctor } from './doctor.mjs'
import { CPP_MODELS, runInstall } from './install.mjs'
import { runEvolve } from './evolve.mjs'
import { runIndex } from './index.mjs'
import { hasCommits, pullRebase, syncAndPush } from './gitops.mjs'
import { writeHeartbeat } from './heartbeat.mjs'
import { installReminder, installService, launchdPlist, uninstallReminder, uninstallService } from './service.mjs'
import { localDate, readUsage, reportMarkdown, summarise } from './usage.mjs'
import { VERSION } from './version.mjs'
import { findRepos } from './repos.mjs'
import { runOnce, statusReport } from './run.mjs'
import { lastLine, oneLine, run, sleep } from './util.mjs'
import { chaptersOf, readWords, runWords, wordsJobs } from './words.mjs'

const USAGE = `myind-worker <command>

  setup --repo owner/name [--branch NAME] [--dir PATH] [--remote URL] [--device NAME] [--language English]
  branches --repo owner/name [--remote URL]   the repository's branches and its default (reads only)
  once [--force] [--limit N] [--workpulse]
  needs-words [--json]               video links waiting for you to bring their words (id, title, link, saved)
  words <id> <file|-> [--chapters FILE] [--title T] [--by B] [--force]
                                     learn from the words you give (text, or .vtt / .srt with times), push
  add <url> --words <file|-> [--chapters FILE] [--title T] [--by B]   the same for a link added here
  watch [--every 300] [--workpulse]
  index                              uploads a snapshot of the small text files for a new phone (release myind-index)
  status [--json]
  evolve [--limit N] [--min-items 2]
  launchd-plist [--every 300] [--workpulse]          prints a launchd plist; installs nothing
  install-service [--every 300] [--workpulse] [--no-load]   macOS launchd / Linux systemd user unit
  uninstall-service [--no-load]
  report [--days 7] [--json] [--write] [--notify]   where the Claude tokens went, and what waits for you
                                     (--write: ~/.myind/reports/week-<date>.md; --notify: a macOS notification)
  install-reminder [--weekday 1] [--hour 10] [--no-load]   the report once a week (0 = Sunday); uninstall-reminder stops it
  doctor [--json]                    node, git, gh signed in, claude, ffmpeg, whisper; prints install lines, installs nothing
  install <tool...> | --missing [--yes] [--model small]   runs the install lines; without --yes only prints
  find-repos [--json]                your private repositories that look like a Myind brain (reads only)
  version
`

function parseArgs(argv, { positional = false } = {}) {
	const flags = { _: [] }
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (!a.startsWith('--') && positional) {
			flags._.push(a)
			continue
		}
		if (!a.startsWith('--')) throw new Error(`unexpected argument: ${oneLine(a, 60)}`)
		const next = argv[i + 1]
		if (next === undefined || next.startsWith('--')) flags[a.slice(2)] = true
		else {
			flags[a.slice(2)] = next
			i++
		}
	}
	return flags
}

// Myind never fetches a video's content (YouTube's and Instagram's terms), so there are no video or cookie options.
const onceOptions = (f) => {
	for (const gone of ['with-video', 'cookies-from-browser']) {
		if (f[gone]) throw new Error(`--${gone} was removed: Myind doesn't download videos from links. Bring the words instead: myind-worker needs-words, then myind-worker words <id> <file>`)
	}
	return { force: !!f.force, limit: f.limit ? Number(f.limit) : undefined, workpulse: !!f.workpulse }
}

async function setup(f) {
	const repo = f.repo
	if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('setup needs --repo owner/name')
	if (typeof f.remote === 'string' && /:\/\/[^/@]*:[^/@]*@/.test(f.remote)) throw new Error('--remote must not hold a password or token; git and gh use your own login')
	if (f.video !== undefined) throw new Error('--video was removed: Myind never fetches a video; bring its words with myind-worker words')
	const branch = checkBranch(f.branch)
	const dir = typeof f.dir === 'string' ? f.dir : join(homeDir(), 'repo')
	const tools = resolveTools({})
	const got = await cloneOrSwitch({ repo, dir, branch, remote: f.remote, gh: tools.gh })
	console.log(got.cloned ? `cloned ${repo} to ${dir}` : `using the clone at ${dir}`)
	if (got.switchedFrom) console.log(`switched the clone from ${got.switchedFrom} to ${got.branch}`)
	if (tools.gh && !f.remote) {
		const res = await run(tools.gh, ['api', `repos/${repo}`, '--jq', '.private'])
		if (res.code === 0 && res.stdout.trim() !== 'true') console.log('warning: this repository is not private. It should be: your notes and transcripts go here, and file uploads are refused.')
	}
	const previous = existsSync(configPath()) ? loadConfig() : {}
	const { videoLinks: _gone, ...kept } = previous // the 2026-11-04 opt-in was removed
	const cfg = {
		...kept,
		repo,
		dir,
		...(got.branch ? { branch: got.branch } : {}),
		device: typeof f.device === 'string' ? f.device : (previous.device ?? defaultDevice()),
		language: typeof f.language === 'string' ? f.language : (previous.language ?? 'English'),
		workerPath: fileURLToPath(import.meta.url),
	}
	saveConfig(cfg)
	console.log(`set up: ${repo}${got.branch ? ` (branch ${got.branch})` : ''} at ${dir}${(await hasCommits(dir)) ? '' : ' (no commits yet)'}`)
	console.log(`settings: ${configPath()}. No token is stored; git and gh use your own login.`)
	await checkIn(dir)
}

async function installCommandTools(f) {
	const platform = typeof f.platform === 'string' ? f.platform : process.platform
	if (f.model !== undefined && !CPP_MODELS.includes(f.model)) throw new Error(`--model must be one of ${CPP_MODELS.join(', ')}`)
	let names = f._
	const rows = await doctor({ platform })
	if (f.missing) names = missingNames(rows)
	if (!names.length) {
		console.log(f.missing ? 'nothing is missing' : 'name the tools: myind-worker install whisper ffmpeg [--yes]')
		return 0
	}
	if (!f.force) {
		const fine = rows.filter((r) => r.ok && names.includes(r.name))
		for (const r of fine) console.log(`${r.name} is already fine: ${r.detail} (--force to run its steps anyway)`)
		names = names.filter((n) => !fine.some((r) => r.name === n))
		if (!names.length) return 0
	}
	const tools = resolveTools(existsSync(configPath()) ? loadConfig() : {})
	if (names.includes('gh') && tools.gh) {
		names = names.filter((n) => n !== 'gh')
		console.log('gh is installed; sign in yourself (it opens a browser): gh auth login')
	}
	const results = await runInstall(names, { platform, yes: !!f.yes, model: f.model })
	if (f.yes) console.log('now run: myind-worker doctor')
	return results.every((r) => r.ok) || !f.yes ? 0 : 1
}

async function branchesCommand(f) {
	if (typeof f.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(f.repo)) throw new Error('branches needs --repo owner/name')
	const { default: def, branches } = await listBranches({ repo: f.repo, remote: f.remote })
	if (f.json) return console.log(JSON.stringify({ default: def, branches }, null, 2))
	for (const b of branches) console.log(`${b}${b === def ? ' (default)' : ''}`)
	if (!branches.length) console.log('no branches yet: the repository is empty; the phone or setup makes the first commit')
}

function needsWordsCommand(f) {
	const jobs = wordsJobs(loadConfig().dir)
	if (f.json) return console.log(JSON.stringify(jobs, null, 2))
	for (const j of jobs) console.log(`${j.id}  ${(j.savedAt ?? '').slice(0, 10)}  ${oneLine(j.title ?? '(no title)', 70)}\n    ${j.url ?? ''}`)
	console.log(jobs.length ? `${jobs.length} waiting for your words. Give them with: myind-worker words <id> <file>  (or - to paste)` : 'nothing is waiting for words')
	console.log('Myind never fetches a video. Bring words you may use: the transcript the site itself shows, the creator\'s captions, or your own notes.')
}

async function wordsCommand(f, { add = false } = {}) {
	const [target, file] = f._
	const source = add ? f.words : file
	if (!target || typeof source !== 'string') throw new Error(add ? 'add needs <url> --words <file|->' : 'words needs <id> <file|->')
	const opts = { text: readWords(source), title: typeof f.title === 'string' ? f.title : undefined, by: typeof f.by === 'string' ? f.by : undefined, chapters: typeof f.chapters === 'string' ? chaptersOf(readWords(f.chapters)) : [], force: !!f.force }
	const res = await runWords(add ? { url: target, ...opts } : { id: target, ...opts })
	if (res.code === 0 && f.evolve !== false && !f['no-evolve']) await runEvolve({})
	return res.code
}

/** The first heartbeat, so the phone shows this computer straight away. A failure only warns. */
async function checkIn(dir) {
	const cfg = loadConfig()
	if (cfg.heartbeat === false || !(await hasCommits(dir))) return
	try {
		const pulled = await pullRebase(dir)
		if (!pulled.ok) return console.log(`warning: could not pull, so this computer did not check in yet: ${pulled.error}`)
		const { rel } = await writeHeartbeat(dir, { tools: resolveTools(cfg), everyMinutes: 0 })
		const pushed = await syncAndPush(dir)
		console.log(pushed.ok ? `checked in: ${rel} (the phone shows this computer in Settings)` : `warning: ${rel} written but not pushed yet: ${pushed.error}`)
	} catch (e) {
		console.log(`warning: could not check in: ${oneLine(e.message)}`)
	}
}

async function watch(f) {
	const every = Number(f.every ?? 300)
	if (!(every > 0)) throw new Error('--every must be a number of seconds')
	let stop = false
	for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => (stop = true))
	while (!stop) {
		try {
			await runOnce(onceOptions(f))
		} catch (e) {
			console.log(`warning: ${oneLine(e.message)}`) // a watch outlives one bad pass
		}
		for (let waited = 0; waited < every && !stop; waited++) await sleep(1000)
	}
}

function printStatus(f) {
	const s = statusReport()
	if (f.json) return console.log(JSON.stringify(s, null, 2))
	if (!s.setUp) console.log('not set up: run myind-worker setup --repo owner/name')
	else console.log(`repo ${s.repo}${s.branch ? ` (branch ${s.branch})` : ''}\nclone ${s.dir}`)
	console.log(`pending ${s.pending}\nneeds your words ${s.needsWords}${s.needsWords ? ' (myind-worker needs-words)' : ''}\nfailed ${s.failed}`)
	for (const row of s.failures) console.log(`  ${row.id}: ${row.error}`)
	const r = s.lastRun
	console.log(r ? `last run ${r.finishedAt ?? r.startedAt}: done ${r.done}, kept ${r.kept}, failed ${r.failed}, left ${r.skipped}${r.pushed ? '' : ', NOT PUSHED'}` : 'last run: never')
	for (const w of r?.warnings ?? []) console.log(`  ${w}`)
	console.log('tools')
	for (const [name, path] of Object.entries(s.tools)) console.log(`  ${path ? 'ok' : '--'} ${name}${path ? ` ${path.split(homedir()).join('~')}` : ' missing'}`)
}

function printPlist(f) {
	const every = Number(f.every ?? 300)
	if (!(every > 0)) throw new Error('--every must be a number of seconds')
	process.stdout.write(launchdPlist(realpathSync(fileURLToPath(import.meta.url)), { every, workpulse: !!f.workpulse }))
}

async function installCommand(f) {
	const every = Number(f.every ?? 300)
	if (!(every > 0)) throw new Error('--every must be a number of seconds')
	if (!existsSync(configPath())) throw new Error('Not set up. Run: myind-worker setup --repo owner/name')
	const r = await installService({ platform: typeof f.platform === 'string' ? f.platform : process.platform, every, workpulse: !!f.workpulse, load: !f['no-load'] })
	console.log(`service: ${r.file.split(homedir()).join('~')}`)
	console.log(`runs: ${r.workerPath.split(homedir()).join('~')} watch --every ${every}`)
	console.log(r.loaded ? 'running in the background now; it starts again when you log in' : 'written, not loaded (--no-load)')
	console.log('after a plugin update, run this again so the background copy is the new one. To stop it: myind-worker uninstall-service')
}

async function uninstallCommand(f) {
	const r = await uninstallService({ platform: typeof f.platform === 'string' ? f.platform : process.platform, load: !f['no-load'] })
	console.log(r.removed ? `stopped and removed ${r.file.split(homedir()).join('~')}` : 'no background service was installed')
}

const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

/** Where the tokens went in the last N days, and what waits. Reads only local files; never pulls or pushes. */
async function reportCommand(f) {
	const days = Number(f.days ?? 7)
	if (!(days > 0)) throw new Error('--days must be a number')
	const s = summarise(readUsage(), { days })
	const st = existsSync(configPath()) ? statusReport() : { needsWords: 0, failed: 0, pending: 0 }
	const waiting = { needsWords: st.needsWords, failed: st.failed, pending: Math.max(0, st.pending - st.needsWords) }
	if (f.json) return console.log(JSON.stringify({ ...s, waiting }, null, 2))
	const md = reportMarkdown(s, waiting)
	let file = null
	if (f.write) {
		const dir = join(homeDir(), 'reports')
		mkdirSync(dir, { recursive: true })
		file = join(dir, `week-${localDate()}.md`)
		writeFileSync(file, md)
	}
	process.stdout.write(md)
	if (file) console.log(`\nwritten: ${file.split(homedir()).join('~')}`)
	if (f.notify && process.platform === 'darwin') {
		const text = `${s.calls} Claude calls, ${k(s.input + s.output)} tokens, $${s.cost.toFixed(2)}. ${st.needsWords} reels wait for your words.`
		const q = (x) => `"${String(x).replace(/["\\]/g, '')}"`
		// A notification banner, never a dialog. Clicking it does nothing; the report is the file.
		const shown = await run('/usr/bin/osascript', ['-e', `display notification ${q(text)} with title "Myind weekly report" subtitle ${q(file ? 'Report in ~/.myind/reports' : '')}`])
		if (shown.code !== 0) console.log(`warning: the notification was not shown: ${oneLine(shown.stderr || 'osascript failed')}`)
		if (file) {
			const opened = await run('/usr/bin/open', ['-g', '-a', 'TextEdit', file])
			if (opened.code !== 0) console.log(`warning: could not open the report: ${oneLine(opened.stderr || 'open failed')}`)
			else console.log('notified and opened the report')
		}
	}
}

async function main() {
	const [command, ...rest] = process.argv.slice(2)
	if (!command || command === 'help' || command === '--help') {
		process.stdout.write(USAGE)
		return 0
	}
	const flags = parseArgs(rest, { positional: ['install', 'words', 'add'].includes(command) })
	switch (command) {
		case 'setup':
			await setup(flags)
			return 0
		case 'once':
			return (await runOnce(onceOptions(flags))).code
		case 'index': {
			const cfg = loadConfig()
			const tools = resolveTools(cfg)
			if (!tools.gh) throw new Error('gh is not installed; the snapshot is uploaded with your own gh login')
			const pulled = await pullRebase(cfg.dir)
			if (!pulled.ok) throw new Error(`could not pull: ${pulled.error}`)
			await runIndex(cfg, tools)
			return 0
		}
		case 'watch':
			await watch(flags)
			return 0
		case 'status':
			printStatus(flags)
			return 0
		case 'evolve':
			return (await runEvolve({ limit: flags.limit ? Number(flags.limit) : undefined, minItems: flags['min-items'] ? Number(flags['min-items']) : undefined })).code
		case 'launchd-plist':
			printPlist(flags)
			return 0
		case 'install-service':
			await installCommand(flags)
			return 0
		case 'uninstall-service':
			await uninstallCommand(flags)
			return 0
		case 'report':
			await reportCommand(flags)
			return 0
		case 'install-reminder': {
			const r = await installReminder({ platform: typeof flags.platform === 'string' ? flags.platform : process.platform, weekday: Number(flags.weekday ?? 1), hour: Number(flags.hour ?? 10), load: !flags['no-load'] })
			console.log(`weekly report: every ${r.when}\nfiles: ${r.files.map((x) => x.split(homedir()).join('~')).join(', ')}`)
			console.log(r.loaded ? 'on. It writes ~/.myind/reports/week-<date>.md and shows a notification. Stop it: myind-worker uninstall-reminder' : 'written, not loaded (--no-load)')
			return 0
		}
		case 'uninstall-reminder': {
			const r = await uninstallReminder({ platform: typeof flags.platform === 'string' ? flags.platform : process.platform, load: !flags['no-load'] })
			console.log(r.removed ? 'weekly report stopped' : 'no weekly report was installed')
			return 0
		}
		case 'doctor': {
			const rows = await doctor({ platform: typeof flags.platform === 'string' ? flags.platform : process.platform })
			if (flags.json) {
				console.log(JSON.stringify(rows, null, 2))
				return rows.some((r) => r.required && !r.ok) ? 1 : 0
			}
			return printDoctor(rows)
		}
		case 'install':
			return installCommandTools(flags)
		case 'needs-words':
			needsWordsCommand(flags)
			return 0
		case 'words':
			return wordsCommand(flags)
		case 'add':
			return wordsCommand(flags, { add: true })
		case 'branches':
			await branchesCommand(flags)
			return 0
		case 'find-repos': {
			const found = await findRepos(resolveTools(existsSync(configPath()) ? loadConfig() : {}).gh)
			if (flags.json) console.log(JSON.stringify(found, null, 2))
			else {
				for (const m of found.matches) console.log(`${m.repo} (${m.markers.join(', ')})`)
				console.log(found.matches.length ? `${found.matches.length} of ${found.privateRepos} private repositories look like a Myind brain` : `none of ${found.privateRepos} private repositories looks like a Myind brain`)
				for (const r of found.publicLookalikes) console.log(`warning: ${r} is public; a brain must be private, so it is not used`)
			}
			return 0
		}
		case 'version':
			console.log(VERSION)
			return 0
		default:
			process.stderr.write(`unknown command: ${oneLine(command, 40)}\n\n${USAGE}`)
			return 2
	}
}

main().then(
	(code) => process.exit(code),
	(e) => {
		process.stderr.write(`error: ${oneLine(e.message)}\n`)
		process.exit(1)
	},
)
