#!/usr/bin/env node
// SessionStart hook: one line, only when the local clone has jobs waiting. It reads two local things and never touches
// the network, so it is fast, and any problem at all means saying nothing: it must never fail a session.
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

try {
	const home = process.env.MYIND_HOME || join(homedir(), '.myind')
	const { dir } = JSON.parse(readFileSync(join(home, 'worker.json'), 'utf8'))
	const pending = readdirSync(join(dir, 'inbox')).filter((n) => n.endsWith('.json')).length
	if (pending > 0) console.log(`${pending} Myind job${pending === 1 ? '' : 's'} waiting in the inbox: say "process my Myind inbox" to run them.`)
} catch {
	// not set up, or no inbox yet
}
