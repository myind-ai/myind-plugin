// Reading file bodies the phone stored in GitHub release assets ("Big files" in storage-format.md), through the
// user's own `gh` login. The worker never uploads: it doesn't download videos, and the phone stores your files.
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homeDir } from './config.mjs'
import { NeedsTool, oneLine, run } from './util.mjs'

const TAG = /^myind-blobs-(\d{4})$/
const PART_NAME = /^[0-9a-f]{64}\.part\d{3}$/
// A part in a storage repository names it ("owner/name"); no name means the main repository.
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export function sha256File(path) {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256')
		createReadStream(path)
			.on('data', (d) => hash.update(d))
			.on('error', reject)
			.on('end', () => resolve(hash.digest('hex')))
	})
}

export class BlobStore {
	constructor(tools, cfg) {
		this.gh = tools.gh
		this.repo = cfg.repo
	}

	async call(args, what) {
		if (!this.gh) throw new NeedsTool('gh is not installed')
		const res = await run(this.gh, args)
		if (res.code !== 0) throw new Error(`${what} failed: ${oneLine(res.stderr || res.stdout)}`)
		return res.stdout
	}

	/** Downloads a manifest's parts, joins them in order and checks the result against the manifest. */
	async get(manifest, dest) {
		const tmp = mkdtempSync(join(tempRoot(), 'get-'))
		const joined = join(tmp, 'joined')
		try {
			const out = createWriteStream(joined)
			const parts = Array.isArray(manifest.parts) ? manifest.parts : []
			if (!parts.length) throw new Error('the manifest lists no parts')
			for (const part of parts) {
				if (!PART_NAME.test(String(part.name)) || !TAG.test(String(part.release))) throw new Error('the manifest has an invalid part name')
				if (part.repo !== undefined && (!REPO.test(String(part.repo)) || String(part.repo).split('/').some((x) => x === '.' || x === '..'))) throw new Error('the manifest names an invalid repository')
				const repo = part.repo ?? this.repo
				await this.call(['release', 'download', part.release, '--repo', repo, '--pattern', part.name, '--dir', tmp, '--clobber'], `downloading ${part.name}`)
				await new Promise((resolve, reject) => {
					createReadStream(join(tmp, part.name)).on('error', reject).on('end', resolve).pipe(out, { end: false })
				})
				rmSync(join(tmp, part.name), { force: true })
			}
			await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())))
			if (statSync(joined).size !== manifest.size) throw new Error('the downloaded file has the wrong size')
			if ((await sha256File(joined)) !== manifest.sha256) throw new Error('the downloaded file has the wrong sha256')
			renameSync(joined, dest)
		} finally {
			rmSync(tmp, { recursive: true, force: true })
		}
	}
}

function tempRoot() {
	const dir = join(homeDir(), 'work')
	mkdirSync(dir, { recursive: true })
	return dir
}
