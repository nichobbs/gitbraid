import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { log } from './channelLogger'
import type { ConfigService } from './configService'
import type { BranchStackService } from './branchStackService'
import { IGitRunner, getDefaultGitRunner } from './gitRunner'

export interface BranchHealth {
	/** Commits on this branch not yet on its base (ahead). */
	aheadCount: number
	/** Commits on the base not yet on this branch (behind). */
	behindCount: number
	/** Whether the branch's worktree has uncommitted changes. */
	dirty: boolean
	/** Whether a rebase is currently in progress in the worktree. */
	rebasing: boolean
}

/**
 * Fetches and caches ahead/behind counts, dirty state, and rebase state for
 * every branch in the stack.  Data is refreshed on stack changes and via the
 * public `refresh()` method.
 *
 * Results are intentionally best-effort: a branch with no accessible worktree
 * or one that fails a git query simply has no entry in the cache; callers
 * treat `undefined` as "health unknown".
 */
export class WorktreeHealthService implements vscode.Disposable {

	private readonly _cache = new Map<string, BranchHealth>()
	private readonly _onDidChange = new vscode.EventEmitter<void>()
	readonly onDidChange: vscode.Event<void> = this._onDidChange.event

	private readonly _disposables: vscode.Disposable[] = []
	private _refreshPending = false

	constructor(
		private readonly _config: ConfigService,
		private readonly _branchStack: BranchStackService,
		private readonly _root: vscode.Uri,
		private readonly _runner: IGitRunner = getDefaultGitRunner(),
	) {
		this._disposables.push(
			this._onDidChange,
			this._config.onDidChangeStack(() => this._scheduleRefresh()),
		)
		this._scheduleRefresh()
	}

	/** Returns cached health for a branch, or `undefined` if not yet available. */
	getHealth(branch: string): BranchHealth | undefined {
		return this._cache.get(branch)
	}

	/** Trigger a full refresh of health data for all stack branches. */
	async refresh(): Promise<void> {
		const stack = this._config.getStack()
		const newCache = new Map<string, BranchHealth>()

		await Promise.allSettled(stack.map(async (entry) => {
			try {
				const worktreeExists = this._branchStack.worktreeExists(entry.name)
				const cwd = worktreeExists
					? this._branchStack.getWorktreePath(entry.name).fsPath
					: this._root.fsPath

				const [ahead, behind, dirty] = await Promise.all([
					this._countRevs(cwd, `${entry.base}..${entry.name}`),
					this._countRevs(cwd, `${entry.name}..${entry.base}`),
					this._isDirty(cwd),
				])

				const rebasing = worktreeExists && _isMidRebase(cwd)

				newCache.set(entry.name, {
					aheadCount: ahead ?? 0,
					behindCount: behind ?? 0,
					dirty,
					rebasing,
				})
			} catch (e) {
				log.warn(`WorktreeHealthService: failed to fetch health for "${entry.name}": ${e instanceof Error ? e.message : String(e)}`)
			}
		}))

		this._cache.clear()
		for (const [k, v] of newCache) {
			this._cache.set(k, v)
		}
		this._onDidChange.fire()
	}

	dispose(): void {
		for (const d of this._disposables) {
			d.dispose()
		}
	}

	private _scheduleRefresh(): void {
		if (this._refreshPending) return
		this._refreshPending = true
		void Promise.resolve().then(async () => {
			this._refreshPending = false
			await this.refresh()
		})
	}

	private async _countRevs(cwd: string, range: string): Promise<number | undefined> {
		const { stdout, exitCode } = await this._runner.run(
			['rev-list', '--count', range],
			{ cwd },
		)
		if (exitCode !== 0) return undefined
		const n = parseInt(stdout.trim(), 10)
		return Number.isNaN(n) ? undefined : n
	}

	private async _isDirty(cwd: string): Promise<boolean> {
		const { stdout, exitCode } = await this._runner.run(
			['status', '--porcelain', '-z'],
			{ cwd },
		)
		return exitCode === 0 && stdout.trim().length > 0
	}
}

/** Check whether a worktree directory has a rebase in progress. */
function _isMidRebase(worktreeDir: string): boolean {
	let gitdir = path.join(worktreeDir, '.git')
	try {
		const st = fs.statSync(gitdir, { throwIfNoEntry: false })
		if (st?.isFile()) {
			const m = /^gitdir:\s*(.+)$/.exec(fs.readFileSync(gitdir, 'utf-8').trim())
			if (m) gitdir = path.resolve(worktreeDir, m[1])
		}
	} catch {
		return false
	}
	return fs.existsSync(path.join(gitdir, 'rebase-merge')) ||
		fs.existsSync(path.join(gitdir, 'rebase-apply'))
}
