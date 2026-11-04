import assert from 'node:assert/strict'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { makeWorld } from './test-helpers.mjs'

/** A pre-push hook in the worker's clone: another clone commits to origin in the gap between pull and push. */
function raceOnce(w, times = 1) {
	const count = join(w.fake, 'race-count')
	writeFileSync(count, '0')
	const hook = join(w.clone, '.git', 'hooks', 'pre-push')
	writeFileSync(
		hook,
		`#!/bin/sh
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX
n=$(cat "${count}")
if [ "$n" -lt ${times} ]; then
  echo $((n+1)) > "${count}"
  cd "${w.other}" && git pull -q --rebase origin main && echo "$n" > "race-${times}-$n.txt" && git add "race-${times}-$n.txt" && git commit -q -m "chore: race $n" && git push -q origin main
fi
exit 0
`,
	)
	chmodSync(hook, 0o755)
	return count
}

test('another clone commits between pull and push: the push is retried and everything lands', (t) => {
	const w = makeWorld(t)
	w.setup()
	const id = w.addLink('https://youtu.be/race')
	const count = raceOnce(w, 1)
	const res = w.worker('once')
	assert.equal(res.code, 0, res.all)
	assert.equal(readFileSync(count, 'utf8').trim(), '1', 'the race really happened')
	assert.ok(w.originFile('race-1-0.txt'), "the other device's commit is on origin")
	assert.equal(w.learning(id, 'youtube').quality, 'full', 'ours is too')
	assert.equal(w.originFile(`inbox/${id}.json`), null)
	assert.equal(w.sh(w.clone, 'rev-list', '--count', 'origin/main..HEAD'), '0')
})

test('three lost races in a row still get there; a fourth is reported, with the commit kept', (t) => {
	const w = makeWorld(t)
	w.setup()
	const id = w.addLink('https://youtu.be/race3')
	raceOnce(w, 3)
	assert.equal(w.worker('once').code, 0)
	assert.equal(w.learning(id, 'youtube').quality, 'full')

	const id2 = w.addLink('https://youtu.be/race9')
	raceOnce(w, 99)
	const res = w.worker('once')
	assert.equal(res.code, 1, 'the pass says it could not push')
	assert.match(res.out, /commit\(s\) not pushed/)
	assert.equal(w.originFile(`inbox/${id2}.json`) !== null, true, 'origin still has the job')
	assert.ok(Number(w.sh(w.clone, 'rev-list', '--count', 'origin/main..HEAD')) >= 1, 'the commit is safe locally')

	writeFileSync(join(w.clone, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 0\n')
	assert.equal(w.worker('once').code, 0, 'the next pass delivers it')
	assert.equal(w.learning(id2, 'youtube').quality, 'full')
})

test('another device wrote the same file: our commit is pinned on a branch and the clone recovers', (t) => {
	const w = makeWorld(t)
	w.setup()
	const id = w.addLink('https://youtu.be/conflict')
	const hook = join(w.clone, '.git', 'hooks', 'pre-push')
	const folder = `library/youtube/2026-11-02_a-test-video_${id.slice(0, 8)}`
	// The other device writes the very same path in the gap, so our commit can't be replayed on top.
	writeFileSync(
		hook,
		`#!/bin/sh
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX
cd "${w.other}" && git pull -q --rebase origin main && mkdir -p "${folder}" && echo '{"id":"${id}","quality":"basic"}' > "${folder}/learning.json" && git add "${folder}/learning.json" && git commit -q -m "chore: phone wrote it" && git push -q origin main
rm -f "${hook}"
exit 0
`,
	)
	chmodSync(hook, 0o755)
	const res = w.worker('once')
	assert.match(res.out, /another device changed the same files; the commit was kept on myind-conflict\//)
	const pins = w.sh(w.clone, 'branch', '--list', 'myind-conflict/*')
	assert.ok(pins.includes('myind-conflict/'), 'nothing is lost')
	assert.equal(w.sh(w.clone, 'status', '--short'), '', 'the clone is clean')
	assert.equal(w.sh(w.clone, 'rev-list', '--count', 'origin/main..HEAD'), '0')

	// The job is still in the inbox on origin, so the next pass finishes it over the basic item.
	const again = w.worker('once')
	assert.equal(again.code, 0, again.all)
	assert.equal(w.learning(id, 'youtube').quality, 'full')
	assert.equal(w.originFile(`inbox/${id}.json`), null)
})

test('explicit paths: stray files in the clone never reach a commit', (t) => {
	const w = makeWorld(t)
	w.setup()
	writeFileSync(join(w.clone, 'stray.env'), 'TOKEN=abc\n')
	const id = w.addLink('https://youtu.be/stray')
	assert.equal(w.worker('once').code, 0)
	assert.equal(w.learning(id, 'youtube').quality, 'full')
	assert.equal(w.originFile('stray.env'), null)
})

test('two runs cannot overlap on one clone', (t) => {
	const w = makeWorld(t)
	w.setup()
	writeFileSync(join(w.env.MYIND_HOME, 'worker.lock'), String(process.pid))
	const id = w.addLink('https://youtu.be/locked')
	const res = w.worker('once')
	assert.match(res.out, /another run is in progress/)
	assert.ok(w.originFile(`inbox/${id}.json`))
	writeFileSync(join(w.env.MYIND_HOME, 'worker.lock'), '999999') // a dead run's lock doesn't count
	assert.equal(w.worker('once').code, 0)
	assert.equal(w.originFile(`inbox/${id}.json`), null)
})

test('an empty repository is not an error', (t) => {
	const w = makeWorld(t)
	const empty = join(w.root, 'empty.git')
	w.sh(w.root, 'init', '-q', '--bare', '-b', 'main', empty)
	assert.equal(w.worker('setup', '--repo', 'me/empty', '--remote', empty).code, 0)
	const res = w.worker('once')
	assert.equal(res.code, 0, res.all)
	assert.match(res.out, /no commits yet/)
})

test('every worker commit says who, on which computer, when and which worker', (t) => {
	const w = makeWorld(t)
	w.setup()
	const id = w.addLink('https://youtu.be/stamp')
	assert.equal(w.worker('once').code, 0)
	assert.ok(w.learning(id, 'youtube'))
	const body = w.sh(w.bare, 'log', '-1', '--format=%B')
	const lines = String(body).trim().split('\n')
	assert.match(lines[0], /^[a-z]+: /, 'a typed subject first')
	assert.equal(lines[1], '')
	assert.match(lines[2], /^By: Test User on .+ \(Myind worker\)$/)
	assert.match(lines[3], /^When: \d{4}-\d\d-\d\d \d\d:\d\d \([+-]\d\d:\d\d\)$/)
	assert.match(lines[4], /^App: Myind worker \d+\.\d+\.\d+$/)
})
