import { IGitRunner, getDefaultGitRunner } from './gitRunner'

/**
 * Plan 06 — data source for the "commits under each branch" view.
 *
 * Lists commits reachable from `<branch>` but not from `<parent>` via
 * `git log --format=...` in that branch's worktree.  Cached per-branch until
 * {@link invalidate} is called (consumers wire that to `FileChangeBus` /
 * explicit refresh).
 */

export interface CommitSummary {
	sha: string
	shortSha: string
	subject: string
	date: Date
	author: string
}

interface CacheEntry {
	commits: CommitSummary[]
	stampedAt: number
}

const FIELD_SEP = '\x1f'
const TTL_MS = 30_000

export class CommitListService {

	private readonly _cache = new Map<string, CacheEntry>()

	constructor(private readonly _runner: IGitRunner = getDefaultGitRunner()) {}

	async listCommits(
		worktreeDir: string,
		branch: string,
		base: string,
	): Promise<CommitSummary[]> {
		const key = `${worktreeDir}::${branch}::${base}`
		const now = Date.now()
		const cached = this._cache.get(key)
		if (cached && now - cached.stampedAt < TTL_MS) return cached.commits

		const range = `${base}..${branch}`
		const r = await this._runner.run(
			['log', '--first-parent', `--format=%H${FIELD_SEP}%s${FIELD_SEP}%aI${FIELD_SEP}%an`, range],
			{ cwd: worktreeDir },
		)
		if (r.exitCode !== 0) {
			this._cache.set(key, { commits: [], stampedAt: now })
			return []
		}
		const commits = parseLogOutput(r.stdout)
		this._cache.set(key, { commits, stampedAt: now })
		return commits
	}

	invalidate(worktreeDir?: string, branch?: string): void {
		if (!worktreeDir) {
			this._cache.clear()
			return
		}
		for (const key of [...this._cache.keys()]) {
			if (!key.startsWith(worktreeDir + '::')) continue
			if (branch && !key.startsWith(`${worktreeDir}::${branch}::`)) continue
			this._cache.delete(key)
		}
	}
}

export function parseLogOutput(stdout: string): CommitSummary[] {
	const out: CommitSummary[] = []
	for (const line of stdout.split('\n')) {
		if (!line) continue
		const parts = line.split(FIELD_SEP)
		if (parts.length < 4) continue
		const [sha, subject, iso, author] = parts
		out.push({
			sha,
			shortSha: sha.slice(0, 7),
			subject,
			date: new Date(iso),
			author,
		})
	}
	return out
}
