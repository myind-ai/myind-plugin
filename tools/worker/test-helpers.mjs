// A throwaway world for the tests: a local bare origin, a seeded clone, the worker's clone, and fake gh / claude /
// wp-brain / whisper on PATH. There is no video downloader at all: Myind never fetches a video's content. No test touches
// the network or the real tools.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { folderName, itemIdForUrl, normaliseUrl, routeLink } from '../../plugins/myind/worker/url.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const WORKER = join(HERE, '..', '..', 'plugins', 'myind', 'worker', 'myind-worker.mjs')

const logTo = `const fs = require('fs'); const path = require('path'); const D = process.env.FAKE_DIR;
const log = (name, row) => fs.appendFileSync(path.join(D, name + '.log'), JSON.stringify(row) + '\\n');
const conf = (name, dflt) => { try { return JSON.parse(fs.readFileSync(path.join(D, name + '.json'), 'utf8')) } catch { return dflt } };
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i < 0 ? undefined : argv[i + 1] };`

const FAKE_CLAUDE = `#!/usr/bin/env node
${logTo}
const input = fs.readFileSync(0, 'utf8');
const c = conf('claude', { mode: 'good' });
const calls = (() => { try { return fs.readFileSync(path.join(D, 'claude.log'), 'utf8').split('\\n').filter(Boolean).length } catch { return 0 } })();
log('claude', { argv, input });
const good = { summary: 'A real summary from the model.', lessons: [{ text: 'Lesson one from the model', at: 12 }, { text: 'Lesson two without a moment' }], tags: c.tags ?? ['testing', 'git'], terms: [{ term: 'rebase', meaning: 'replay commits' }], links: ['https://example.com/doc'], notes_markdown: '## Key points\\n\\n- The first point [00:12]' };
let reply = JSON.stringify(good);
if (c.reply !== undefined) reply = typeof c.reply === 'string' ? c.reply : JSON.stringify(c.reply);
if (input.includes('Write the page on the subject')) { const ref = input.match(/"ref": "([0-9a-f]{8})"/)?.[1]; reply = JSON.stringify({ markdown: '# Topic page\\n\\nA fact [' + ref + '].' }) }
if (argv.includes('stream-json')) reply = JSON.stringify({ description: 'A photo of a whiteboard.', text: 'Words on the whiteboard about rebasing commits carefully.' });
if (c.mode === 'invalid') reply = 'I will not give JSON.';
if (c.mode === 'invalid-once' && calls === 0) reply = '{"summary": "missing fields"}';
if (c.mode === 'bad-merge' && input.includes('notes on consecutive parts')) reply = 'not json';
if (c.mode === 'fail' || (c.mode === 'fail-after' && calls >= c.after)) { process.stderr.write('not logged in'); process.exit(1) }
const row = { type: 'result', subtype: 'success', is_error: false, result: reply };
process.stdout.write(argv.includes('stream-json') ? JSON.stringify({ type: 'system' }) + '\\n' + JSON.stringify(row) + '\\n' : JSON.stringify(row));
`

const FAKE_WP = `#!/usr/bin/env node
${logTo}
const input = argv[0] === 'add' ? fs.readFileSync(0, 'utf8') : undefined;
log('wp', { argv, input });
const c = conf('wp', {});
if (argv[0] === 'learn') {
  if (c.learnError) { process.stderr.write(c.learnError + '\\n'); process.exit(1) }
  const folder = path.join(opt('--root'), '2026-01-01_page_aa');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'article.md'), c.article ?? '# Page\\n\\nSource: x\\n\\nA page of useful words about testing software with care and patience.');
  fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify({ title: c.title ?? 'A web page', channel: 'example.com', source_type: 'site', subtitles: { kind: 'none' } }));
  fs.writeFileSync(path.join(folder, 'notes.md'), 'pending');
  process.stdout.write(JSON.stringify({ folder, title: c.title ?? 'A web page', words: 200, problems: [] }) + '\\n');
  process.exit(0);
}
if (c.fail) { process.stderr.write('wp failed\\n'); process.exit(1) }
if (argv[0] === 'library') process.stdout.write('library: bridge/library/' + opt('--type') + '/' + path.basename(argv[2]) + '\\n');
`

export const FAKE_GH = `#!/usr/bin/env node
${logTo}
log('gh', { argv });
const file = path.join(D, 'gh-state.json');
const s = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return { releases: [], next: 100, private: true } } })();
const save = () => fs.writeFileSync(file, JSON.stringify(s));
const assets = path.join(D, 'assets'); fs.mkdirSync(assets, { recursive: true });
const out = (v) => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v));
if (conf('gh', {}).failUpload && argv[1] === 'upload') { process.stderr.write('upload refused'); process.exit(1) }
if (argv[0] === 'auth' && argv[1] === 'status') { if (conf('gh', {}).authFail) { process.stderr.write('You are not logged into any GitHub hosts. To log in, run: gh auth login'); process.exit(1) } out('Logged in'); process.exit(0) }
if (argv[0] === 'repo' && argv[1] === 'list') { out(conf('gh', {}).repos ?? []); process.exit(0) }
if (argv[0] === 'api' && /\\/contents\\/$/.test(argv[1])) { const c = (conf('gh', {}).contents ?? {})[argv[1].slice(6, -10)]; if (!c) { process.stderr.write('Not Found'); process.exit(1) } out(c.map((name) => ({ name }))); process.exit(0) }
if (argv[0] === 'api') {
  const [p, q] = argv[1].split('?');
  const page = Number(new URLSearchParams(q ?? '').get('page') ?? 1);
  let m;
  if (argv.includes('--jq')) out(String(s.private));
  else if (/\\/releases$/.test(p)) out(page > 1 ? [] : s.releases.map((r) => ({ id: r.id, tag_name: r.tag })));
  else if ((m = p.match(/\\/releases\\/tags\\/(.+)$/))) { const r = s.releases.find((x) => x.tag === m[1]); if (!r) process.exit(1); out({ id: r.id, tag_name: r.tag }) }
  else if ((m = p.match(/\\/releases\\/(\\d+)\\/assets$/))) out(page > 1 ? [] : s.releases.find((x) => x.id === Number(m[1])).assets);
  else process.exit(1);
} else if (argv[0] === 'release' && argv[1] === 'create') { s.releases.push({ id: s.next++, tag: argv[2], assets: [] }); save() }
else if (argv[0] === 'release' && argv[1] === 'upload') { const r = s.releases.find((x) => x.tag === argv[2]); const f = argv[3]; const name = path.basename(f); fs.copyFileSync(f, path.join(assets, name)); r.assets.push({ id: s.next++, name, size: fs.statSync(f).size }); save() }
else if (argv[0] === 'release' && argv[1] === 'delete-asset') { const r = s.releases.find((x) => x.tag === argv[2]); r.assets = r.assets.filter((a) => a.name !== argv[3]); save() }
else if (argv[0] === 'release' && argv[1] === 'download') { const name = opt('--pattern'); fs.copyFileSync(path.join(assets, name), path.join(opt('--dir'), name)) }
else process.exit(1);
`

const FAKE_WHISPER = `#!/usr/bin/env node
${logTo}
log('whisper', { argv });
const stem = path.basename(argv[0]).replace(/\\.[^.]*$/, '');
fs.writeFileSync(path.join(opt('--output_dir'), stem + '.vtt'), 'WEBVTT\\n\\n00:00:01.000 --> 00:00:03.000\\nWords from the audio file about careful testing.\\n\\n00:01:05.000 --> 00:01:08.000\\nMore words spoken later in the recording.\\n');
`

export function makeWorld(t) {
	const root = mkdtempSync(join(tmpdir(), 'myind-worker-'))
	t.after(() => rmSync(root, { recursive: true, force: true }))
	const bin = join(root, 'bin')
	const fake = join(root, 'fake')
	const home = join(root, 'home')
	for (const d of [bin, fake, home]) mkdirSync(d, { recursive: true })
	for (const [name, body] of Object.entries({ claude: FAKE_CLAUDE, 'wp-brain': FAKE_WP, gh: FAKE_GH, whisper: FAKE_WHISPER })) {
		writeFileSync(join(bin, name), body)
		chmodSync(join(bin, name), 0o755)
	}
	const gitConfig = join(root, 'gitconfig')
	writeFileSync(gitConfig, '[user]\n\tname = Test User\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n')
	const env = {
		...process.env,
		PATH: `${bin}${delimiter}${process.env.PATH}`,
		HOME: home,
		FAKE_DIR: fake,
		MYIND_HOME: join(home, '.myind'),
		MYIND_WP_BRAIN: join(bin, 'wp-brain'),
		MYIND_RETRY_MS: '0',
		GIT_CONFIG_GLOBAL: gitConfig,
		GIT_CONFIG_NOSYSTEM: '1',
	}
	env.MYIND_WHISPER_CPP = join(bin, 'no-whisper-cli')
	for (const k of ['MYIND_GH', 'MYIND_CLAUDE', 'MYIND_WHISPER', 'WP_CLI', 'YT_LEARN_WHISPER_MODEL', 'MYIND_CHUNK_CHARS', 'MYIND_PART_BYTES', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k]
	const sh = (cwd, ...args) => {
		const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' })
		if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
		return r.stdout.trim()
	}
	const bare = join(root, 'origin.git')
	sh(root, 'init', '-q', '--bare', '-b', 'main', bare)
	const other = join(root, 'other')
	sh(root, 'clone', '-q', bare, other)
	writeFileSync(join(other, 'myind.json'), '{"schema":"myind.repo/1","createdAt":"2026-11-01T00:00:00Z"}\n')
	sh(other, 'add', 'myind.json')
	sh(other, 'commit', '-q', '-m', 'chore: start')
	sh(other, 'push', '-q', 'origin', 'main')

	const worker = (...args) => {
		const r = spawnSync(process.execPath, [WORKER, ...args], { env, encoding: 'utf8' })
		return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr }
	}
	const clone = join(home, '.myind', 'repo')
	const world = {
		root,
		bin,
		fake,
		home,
		bare,
		other,
		clone,
		env,
		sh,
		worker,
		setFake: (name, value) => writeFileSync(join(fake, `${name}.json`), JSON.stringify(value)),
		log: (name) => {
			const p = join(fake, `${name}.log`)
			return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
		},
		/** Commits files from the other device and pushes them. */
		fromOther(files, message = 'chore: from another device') {
			sh(other, 'pull', '-q', '--rebase', 'origin', 'main')
			for (const [rel, text] of Object.entries(files)) {
				mkdirSync(dirname(join(other, rel)), { recursive: true })
				writeFileSync(join(other, rel), text)
				sh(other, 'add', rel)
			}
			sh(other, 'commit', '-q', '-m', message)
			sh(other, 'push', '-q', 'origin', 'main')
		},
		/**
		 * Queues a link as the phone does. For a video link the phone first saves the words the owner pasted (or
		 * Gemini wrote) as a basic item; `setFake('words', {...})` shapes them, `{ none: true }` saves none.
		 */
		addLink(url, extra = {}) {
			const normal = normaliseUrl(url)
			const id = itemIdForUrl(normal)
			const job = { schema: 'myind.inbox/1', id, kind: 'link', url, fileSha: null, title: null, note: null, speechLang: null, createdAt: '2026-11-02T10:00:00.000Z', device: 'pixel-6', reason: 'test', ...extra }
			const files = { [`inbox/${id}.json`]: `${JSON.stringify(job)}\n` }
			const route = routeLink(normal)
			const c = (() => { try { return JSON.parse(readFileSync(join(fake, 'words.json'), 'utf8')) } catch { return {} } })()
			// Only the first time: a link shared again doesn't overwrite what the worker already wrote.
			if (route.how === 'video' && !c.none && !world.itemDir(id, route.type)) {
				const title = c.title ?? 'A test video'
				const dir = `library/${route.type}/${folderName('2026-11-02', title, id)}`
				const transcript = c.transcript ?? '# Transcript: x\n\n[00:12] This is the first thing that was said about git rebasing today. It is quite useful.\n\n[01:05] This is another thing about merging branches without any pain at all.'
				files[`${dir}/transcript.md`] = transcript
				files[`${dir}/transcript.txt`] = c.plain ?? transcript
				files[`${dir}/description.md`] = `# Description: ${title}\n\n${c.description ?? 'A caption about the video.'}\n`
				files[`${dir}/meta.json`] = JSON.stringify({ title, channel: c.channel ?? 'Test Channel', language: c.language ?? 'en', tags: c.tags ?? ['Git'] })
				files[`${dir}/learning.json`] = `${JSON.stringify({ schema: 'myind.learning/1', id, title, by: c.channel ?? 'Test Channel', sourceUrl: normal, sourceType: route.type, savedAt: '2026-11-02T10:00:00.000Z', language: c.language ?? 'en', summary: 'Picked sentences.', lessons: [], tags: [], terms: [], links: [], related: [], quality: 'basic', processedBy: 'phone-local', transcriptKind: c.kind ?? 'pasted', files: [] }, null, 2)}\n`
			}
			world.fromOther(files, `chore: queue ${id}`)
			return id
		},
		/** The state of origin, read through a fresh checkout of what was really pushed. */
		originFile(rel) {
			const r = spawnSync('git', ['--git-dir', bare, 'show', `main:${rel}`], { env, encoding: 'utf8' })
			return r.status === 0 ? r.stdout : null
		},
		originFiles() {
			return spawnSync('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main'], { env, encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
		},
		/** Commit subjects on origin, newest first. */
		originLog() {
			return this.originBodies().map((m) => m.split('\n')[0])
		},
		/** Whole commit messages on origin, newest first. */
		originBodies() {
			return spawnSync('git', ['--git-dir', bare, 'log', '--format=%B%x00', 'main'], { env, encoding: 'utf8' }).stdout.split('\0').map((s) => s.trim()).filter(Boolean)
		},
		/** Files changed by the newest commit on origin whose subject matches. */
		commitFiles(subject) {
			const r = spawnSync('git', ['--git-dir', bare, 'log', '-1', '--name-only', '--format=', `--grep=${subject}`, 'main'], { env, encoding: 'utf8' })
			return r.stdout.split('\n').filter(Boolean)
		},
		itemDir(id, type) {
			const hit = world.originFiles().find((f) => f.startsWith(`library/${type}/`) && f.includes(`_${id.slice(0, 8)}/`))
			return hit ? dirname(hit) : null
		},
		learning(id, type) {
			const dir = world.itemDir(id, type)
			return dir ? JSON.parse(world.originFile(`${dir}/learning.json`)) : null
		},
		setup() {
			const res = worker('setup', '--repo', 'me/brain', '--remote', bare, '--device', 'test-pc')
			if (res.code !== 0) throw new Error(res.all)
			return res
		},
	}
	return world
}
