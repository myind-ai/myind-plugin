#!/usr/bin/env node
// SessionStart hook: records where this plugin's worker is, in ~/.myind/plugin.json, because CLAUDE_PLUGIN_ROOT is set
// for hooks but empty in Claude's own shell. /myind:setup reads it. It also says one line when the background copy of
// the worker is older than the plugin. Any problem means saying nothing: it must never fail a session.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const versionIn = (file) => readFileSync(file, 'utf8').match(/VERSION = '([^']+)'/)?.[1] ?? null

try {
	const home = process.env.MYIND_HOME || join(homedir(), '.myind')
	const worker = join(dirname(fileURLToPath(import.meta.url)), '..', 'worker')
	const record = { workerPath: join(worker, 'myind-worker.mjs'), version: versionIn(join(worker, 'version.mjs')) }
	const file = join(home, 'plugin.json')
	let old = null
	try {
		old = JSON.parse(readFileSync(file, 'utf8'))
	} catch {
		// first session with the plugin
	}
	if (old?.workerPath !== record.workerPath || old?.version !== record.version) {
		mkdirSync(home, { recursive: true })
		writeFileSync(`${file}.${process.pid}.tmp`, `${JSON.stringify(record, null, 2)}\n`)
		renameSync(`${file}.${process.pid}.tmp`, file)
	}
	const copy = join(home, 'worker', 'version.mjs')
	if (existsSync(copy) && record.version && versionIn(copy) !== record.version) {
		console.log(`The Myind plugin was updated (${record.version}) but the background worker is older: say "/myind:setup" to refresh it.`)
	}
} catch {
	// nothing to record
}
