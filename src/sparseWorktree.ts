import * as path from 'node:path'
import { log } from './channelLogger'
import { IGitRunner, getDefaultGitRunner } from './gitRunner'

/** `gitbraid.sparseWorktrees` values. */
export type SparseMode = 'off' | 'auto' | 'always'

export interface SparseSettings {
	mode: SparseMode
	/** Tracked-file count above which `auto` switches sparse mode on. */
	threshold: number
	/** Directories every sparse worktree always contains. */
	alwaysInclude: string[]
}

/** Minimum git version with `sparse-checkout --cone`. */
const MIN_GIT: readonly [number, number] = [2, 25]

/** Parse `git version 2.43.0` (also `2.39.3 (Apple Git-146)`, `2.44.0.windows.1`). */
export function parseGitVersion(text: string): [number, number] | undefined {
	const m = /(\d+)\.(\d+)/.exec(text)
	return m ? [Number(m[1]), Number(m[2])] : undefined
}

export function versionAtLeast(v: readonly [number, number], min: readonly [number, number]): boolean {
	return v[0] > min[0] || (v[0] === min[0] && v[1] >= min[1])
}

/** Directory a file lives in, as a cone entry; `undefined` for root-level files (always present in a cone). */
export function coneDirFor(relativePath: string): string | undefined {
	const dir = path.posix.dirname(relativePath.replaceAll('\\', '/'))
	return dir === '.' || dir === '' ? undefined : dir
}

/** True when `dir` is one of the cone entries or lives beneath one. */
export function coneCovers(cone: readonly string[], dir: string): boolean {
	return cone.some((c) => dir === c || dir.startsWith(c + '/'))
}

/** Minimal set of directories covering `files` (a directory subsumes its descendants). */
export function dirsForFiles(files: readonly string[], extra: readonly string[] = []): string[] {
	const dirs = new Set<string>(extra.map((d) => d.replaceAll('\\', '/').replace(/\/+$/, '')).filter(Boolean))
	for (const f of files) {
		const d = coneDirFor(f)
		if (d) dirs.add(d)
	}
	const sorted = [...dirs].sort()
	return sorted.filter((d) => !sorted.some((o) => o !== d && d.startsWith(o + '/')))
}

/**
 * Sparse-checkout management for branch worktrees (plan 16).
 *
 * All git access goes through the injected {@link IGitRunner}.  Cone changes
 * for one worktree are serialised so concurrent saves cannot interleave
 * `sparse-checkout add` calls.
 */
export class SparseWorktreeService {

	private _gitOk: boolean | undefined
	private readonly _cones = new Map<string, string[]>()
	private readonly _chains = new Map<string, Promise<unknown>>()
	private readonly _fileCounts = new Map<string, number>()

	constructor(private readonly _runner: IGitRunner = getDefaultGitRunner()) {}

	/** Whether this git can do cone sparse-checkout.  Warns once when it cannot. */
	async gitSupportsSparse(cwd: string): Promise<boolean> {
		if (this._gitOk !== undefined) return this._gitOk
		const r = await this._runner.run(['--version'], { cwd })
		const v = r.exitCode === 0 ? parseGitVersion(r.stdout) : undefined
		this._gitOk = v !== undefined && versionAtLeast(v, MIN_GIT)
		if (!this._gitOk) {
			log.warn(`SparseWorktree: git ${r.stdout.trim() || 'version unknown'} lacks cone sparse-checkout (needs ${MIN_GIT.join('.')}); using full worktrees`)
		}
		return this._gitOk
	}

	/** Decide whether a new worktree off `base` should be sparse. */
	async shouldUseSparse(repoRoot: string, base: string, s: SparseSettings): Promise<boolean> {
		if (s.mode === 'off') return false
		if (!await this.gitSupportsSparse(repoRoot)) return false
		if (s.mode === 'always') return true
		return (await this._trackedFileCount(repoRoot, base)) > s.threshold
	}

	private async _trackedFileCount(repoRoot: string, base: string): Promise<number> {
		// Counted once per base oid: the oid is cheap, the tree walk is not.
		const oid = await this._runner.run(['rev-parse', '--verify', `${base}^{commit}`], { cwd: repoRoot })
		const key = oid.exitCode === 0 ? oid.stdout.trim() : base
		const cached = this._fileCounts.get(key)
		if (cached !== undefined) return cached
		const r = await this._runner.run(['ls-tree', '-r', '--name-only', base], { cwd: repoRoot, maxBuffer: 512 * 1024 * 1024 })
		const n = r.exitCode === 0 ? r.stdout.split('\n').filter(Boolean).length : 0
		this._fileCounts.set(key, n)
		return n
	}

	/** Is this worktree currently sparse? */
	async isSparse(wt: string): Promise<boolean> {
		const r = await this._runner.run(['config', '--get', 'core.sparseCheckout'], { cwd: wt })
		return r.exitCode === 0 && r.stdout.trim() === 'true'
	}

	/** Current cone for `wt`, from git (and cached). */
	async listCone(wt: string): Promise<string[]> {
		const r = await this._runner.run(['sparse-checkout', 'list'], { cwd: wt })
		const cone = r.exitCode === 0 ? r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : []
		this._cones.set(wt, cone)
		return cone
	}

	/**
	 * Turn a freshly added `--no-checkout` worktree into a sparse one and
	 * populate it.  `ref` is the branch the worktree has checked out.
	 */
	async initCone(wt: string, dirs: readonly string[], ref: string): Promise<void> {
		await this._must(wt, ['sparse-checkout', 'init', '--cone'])
		await this._must(wt, ['sparse-checkout', 'set', '--', ...dirs])
		await this._must(wt, ['checkout', ref])
		this._cones.set(wt, [...dirs])
	}

	/** Make `relativePath` present in the worktree before a file is copied there. */
	ensureInCone(wt: string, relativePath: string): Promise<void> {
		const dir = coneDirFor(relativePath)
		if (!dir) return Promise.resolve()
		return this._serialise(wt, async () => {
			if (!await this.isSparse(wt)) return
			let cone = this._cones.get(wt)
			cone ??= await this.listCone(wt)
			if (coneCovers(cone, dir)) return
			await this._must(wt, ['sparse-checkout', 'add', '--', dir])
			this._cones.set(wt, [...cone, dir])
			log.info(`SparseWorktree: added "${dir}" to the cone of ${wt}`)
		})
	}

	/** Cone-membership for resolvers: a non-sparse worktree contains everything. */
	async isInCone(wt: string, relativePath: string): Promise<boolean> {
		const dir = coneDirFor(relativePath)
		if (!dir) return true
		if (!await this.isSparse(wt)) return true
		const cone = this._cones.get(wt) ?? await this.listCone(wt)
		return coneCovers(cone, dir)
	}

	/** Convert an existing worktree to sparse (limited to `dirs`) or back to full. */
	convert(wt: string, to: 'sparse' | 'full', dirs: readonly string[] = []): Promise<void> {
		return this._serialise(wt, async () => {
			this._cones.delete(wt)
			if (to === 'full') {
				if (await this.isSparse(wt)) await this._must(wt, ['sparse-checkout', 'disable'])
				return
			}
			if (!await this.isSparse(wt)) await this._must(wt, ['sparse-checkout', 'init', '--cone'])
			await this._must(wt, ['sparse-checkout', 'set', '--', ...dirs])
			this._cones.set(wt, [...dirs])
		})
	}

	forget(wt: string): void {
		this._cones.delete(wt)
		this._chains.delete(wt)
	}

	private _serialise<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const prev = this._chains.get(key) ?? Promise.resolve()
		const next = prev.then(fn, fn)
		this._chains.set(key, next.catch(() => undefined))
		return next
	}

	private async _must(cwd: string, args: string[]): Promise<void> {
		const r = await this._runner.run(args, { cwd })
		if (r.exitCode !== 0) {
			throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim() || `exit ${String(r.exitCode)}`}`)
		}
	}
}
