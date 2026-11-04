// First-run tools (doctor, install), connecting a repository and branch, and VTT parsing. No network, no real installs.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { planLines, plans, runInstall } from '../../plugins/myind/worker/install.mjs'
import { hms, paragraphs, parseVtt, renderTranscript, timeLink } from '../../plugins/myind/worker/vtt.mjs'
import { makeWorld } from './test-helpers.mjs'

test('vtt: tags and rolling repeats go, moments stay, paragraphs break at chapters', () => {
	const cues = parseVtt('WEBVTT\nKind: captions\nLanguage: en\n\n00:00:01.000 --> 00:00:02.000 align:start\n<00:00:01.200><c>hello</c><c> there</c>\n\n00:00:02.000 --> 00:00:03.000\nhello there\nnew words &amp; more\n\n1:02:03.500 --> 1:02:05.000\nlate line\n')
	assert.deepEqual(cues, [{ start: 1, line: 'hello there' }, { start: 2, line: 'new words & more' }, { start: 3723.5, line: 'late line' }])
	assert.equal(hms(3723.5), '1:02:03')
	assert.equal(hms(65), '01:05')
	const paras = paragraphs([{ start: 0, line: 'a' }, { start: 10, line: 'b' }, { start: 20, line: 'c' }], [{ start_time: 0, title: 'One' }, { start_time: 15, title: 'Two' }])
	assert.deepEqual(paras.map((p) => p.text), ['a b', 'c'])
	assert.equal(timeLink('https://youtube.com/watch?v=x', 72.9), 'https://youtube.com/watch?v=x&t=72s')
	assert.equal(timeLink('https://instagram.com/reel/x', 5), null)
	const md = renderTranscript({ title: 'T', url: 'https://instagram.com/reel/x', kind: 'auto', key: 'en', paras, chapters: [{ start_time: 0, title: 'One' }], machine: true })
	assert.match(md, /^## One · \[00:00\]$/m)
	assert.match(md, /^\[00:20\] c$/m)
})

test('install lines per system; nothing runs without --yes; shell lines are only printed', async () => {
	assert.equal(planLines(plans('darwin').ffmpeg), 'brew install ffmpeg')
	assert.equal(planLines(plans('linux').whisper), 'sudo apt install -y ffmpeg pipx\npipx install openai-whisper')
	for (const os of ['darwin', 'linux', 'win32']) assert.ok(!Object.keys(plans(os)).some((k) => /yt-?dl|deno/.test(k)), 'no downloader is ever installed')
	assert.equal(planLines(plans('win32').ffmpeg), 'winget install -e --id Gyan.FFmpeg')
	assert.match(planLines(plans('darwin', { model: 'base' }).whisper), /ggml-base\.bin https:\/\/huggingface\.co\/ggerganov\/whisper\.cpp\/resolve\/main\/ggml-base\.bin$/)
	const ran = []
	const runner = async (cmd, args) => (ran.push([cmd, ...args]), { code: 0, stdout: '', stderr: '' })
	const log = () => {}
	await runInstall(['gh', 'claude'], { platform: 'darwin', runner, log })
	assert.deepEqual(ran, [])
	const res = await runInstall(['gh', 'claude', 'ffmpeg'], { platform: 'darwin', yes: true, runner, log })
	assert.deepEqual(ran, [['brew', 'install', 'gh'], ['brew', 'install', 'ffmpeg']])
	assert.deepEqual(res.map((r) => r.ok), [true, false, true])
})

test('connect: branches lists the remote; setup --branch clones that branch, and the worker works on it', (t) => {
	const w = makeWorld(t)
	w.sh(w.other, 'switch', '-q', '-c', 'brain')
	w.sh(w.other, 'push', '-q', 'origin', 'brain')
	const listed = JSON.parse(w.worker('branches', '--repo', 'me/brain', '--remote', w.bare, '--json').out)
	assert.deepEqual(listed, { default: 'main', branches: ['brain', 'main'] })
	const res = w.worker('setup', '--repo', 'me/brain', '--remote', w.bare, '--branch', 'brain', '--device', 'test-pc')
	assert.equal(res.code, 0, res.all)
	assert.match(res.out, /\(branch brain\)/)
	const cfg = JSON.parse(readFileSync(join(w.env.MYIND_HOME, 'worker.json'), 'utf8'))
	assert.equal(cfg.branch, 'brain')
	assert.equal(cfg.videoLinks, undefined)
	assert.equal(w.sh(w.clone, 'symbolic-ref', '--short', 'HEAD'), 'brain')
	assert.match(w.worker('status').out, /repo me\/brain \(branch brain\)\n/)
	// back to main on the same clone, then a dirty clone refuses to switch
	assert.match(w.worker('setup', '--repo', 'me/brain', '--remote', w.bare, '--branch', 'main').out, /switched the clone from brain to main/)
	writeFileSync(join(w.clone, 'stray.txt'), 'uncommitted')
	const refused = w.worker('setup', '--repo', 'me/brain', '--remote', w.bare, '--branch', 'brain')
	assert.notEqual(refused.code, 0)
	assert.match(refused.all, /uncommitted changes/)
	assert.match(w.worker('setup', '--repo', 'me/brain', '--branch', '-bad').all, /--branch must be a branch name/)
	assert.match(w.worker('setup', '--repo', 'me/brain', '--video', 'subtitles').all, /--video was removed: Myind never fetches a video/)
})
