// Which of the user's private repositories is their Myind brain. Uses their own gh login and only reads: the list of
// repositories and the top-level names in each private one. A brain has myind.json (the phone writes it on connect),
// or the folders the phone and worker write.
import { lastLine, oneLine, run } from './util.mjs'

const MARKERS = ['myind.json', 'inbox', 'library', 'devices']
// Mail year repos (storage-format.md, "Mail in year repos") hold only email bodies for the phone. Never a brain, even
// if one somehow has a myind.json, so they are not even read.
const MAIL_YEAR = /\/myind-mail-\d{4}$/i
// File shelves (storage-format.md, storage.json v2) hold only file bodies and thumbnails: myind-photos-2026,
// myind-videos-2026b, myind-files. Never a brain either, so they are not read.
const SHELF = /\/myind-(photos|videos|audio|documents|files|media|other)(-\d{4}[b-z]?)?(-\d{1,3})?$/i

async function topLevel(gh, repo) {
	const res = await run(gh, ['api', `repos/${repo}/contents/`])
	if (res.code !== 0) return [] // empty, or not readable
	try {
		const rows = JSON.parse(res.stdout)
		return Array.isArray(rows) ? rows.map((r) => r?.name).filter((n) => typeof n === 'string') : []
	} catch {
		return []
	}
}

/** Resolves with { matches: [{ repo, markers }], privateRepos, publicLookalikes }. */
export async function findRepos(gh, { concurrency = 8, limit = 200 } = {}) {
	if (!gh) throw new Error('gh is missing. Install it and run: gh auth login')
	const list = await run(gh, ['repo', 'list', '--json', 'nameWithOwner,isPrivate', '--limit', String(limit)])
	if (list.code !== 0) throw new Error(`gh repo list failed: ${oneLine(lastLine(list.stderr || list.stdout))}. Is gh signed in? Run: gh auth login`)
	let repos
	try {
		repos = JSON.parse(list.stdout)
	} catch {
		throw new Error('gh repo list gave something that is not JSON')
	}
	const named = repos.filter((r) => typeof r?.nameWithOwner === 'string' && /^[\w.-]+\/[\w.-]+$/.test(r.nameWithOwner))
	const priv = named.filter((r) => r.isPrivate === true && !MAIL_YEAR.test(r.nameWithOwner) && !SHELF.test(r.nameWithOwner))
	const matches = []
	for (let i = 0; i < priv.length; i += concurrency) {
		const batch = priv.slice(i, i + concurrency)
		const tops = await Promise.all(batch.map((r) => topLevel(gh, r.nameWithOwner)))
		batch.forEach((r, j) => {
			const markers = MARKERS.filter((m) => tops[j].includes(m))
			if (markers.length) matches.push({ repo: r.nameWithOwner, markers })
		})
	}
	// A public repo named like a brain is never used, but it is worth saying: it should be private.
	const publicLookalikes = named.filter((r) => r.isPrivate !== true && /myind/i.test(r.nameWithOwner)).map((r) => r.nameWithOwner)
	matches.sort((a, b) => b.markers.includes('myind.json') - a.markers.includes('myind.json') || a.repo.localeCompare(b.repo))
	return { matches, privateRepos: priv.length, publicLookalikes }
}
