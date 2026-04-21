import * as vscode from 'vscode'
import { log } from './channelLogger'
import { ConfigService } from './configService'
import { BranchStackService, worktreePath } from './branchStackService'
import { IGitRunner, getDefaultGitRunner } from './gitRunner'

/** Default interval between automatic rebase checks (ms). */
const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1_000  // 5 minutes

function getCheckIntervalMs(): number {
	const minutes = vscode.workspace.getConfiguration('gitbraid').get<number>('rebaseCheckIntervalMinutes', 5)
	if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
		return DEFAULT_CHECK_INTERVAL_MS
	}
	return minutes * 60 * 1_000
}

/**
 * Watches the branch stack and notifies the user when a child branch is
 * behind its parent (i.e. the parent has commits the child hasn't incorporated
 * via rebase or merge).
 *
 * Detection uses `git rev-list --count <child>..<parent>` in the child's
 * worktree. A non-zero count means the child is behind.
 *
 * Checks run:
 * - Once at initialisation
 * - Every {@link getCheckIntervalMs} milliseconds (if > 0)
 * - Whenever the branch stack changes (branch added, removed, or reordered)
 *
 * Git is invoked through an injected {@link IGitRunner} (spawn, `shell: false`).
 */
export class RebaseSuggestionService implements vscode.Disposable {

	private _workspaceRoot: vscode.Uri | undefined
	private _intervalHandle: ReturnType<typeof setInterval> | undefined
	private readonly _disposables: vscode.Disposable[] = []

	/** Tracks which branch warnings have already been shown this session. */
	private readonly _notified = new Set<string>()

	constructor(
		private readonly _config: ConfigService,
		private readonly _branchStack: BranchStackService,
		private readonly _runner: IGitRunner = getDefaultGitRunner(),
	) {}

	dispose(): void {
		this._stopInterval()
		for (const d of this._disposables) {
			d.dispose()
		}
	}

	// ─── Lifecycle ────────────────────────────────────────────────────────────

	init(workspaceRoot: vscode.Uri): void {
		this._workspaceRoot = workspaceRoot

		// Check once at startup
		void this._checkAll()

		const intervalMs = getCheckIntervalMs()
		if (intervalMs > 0) {
			this._intervalHandle = setInterval(() => { void this._checkAll() }, intervalMs)
		}

		// Re-check whenever the stack changes
		this._disposables.push(
			this._config.onDidChangeStack(() => {
				this._notified.clear()
				void this._checkAll()
			}),
		)

		log.info('RebaseSuggestionService: initialised')
	}

	// ─── Public helpers ───────────────────────────────────────────────────────

	/**
	 * Returns the number of commits the parent branch has that the child
	 * branch doesn't. Zero means up-to-date.
	 *
	 * Returns `undefined` if the count cannot be determined (e.g. branches
	 * don't exist yet).
	 */
	async getCommitsBehind(
		workspaceRoot: string,
		childBranch: string,
		parentBranch: string,
	): Promise<number | undefined> {
		return this._countRevsBehind(workspaceRoot, childBranch, parentBranch)
	}

	// ─── Private ─────────────────────────────────────────────────────────────

	private _stopInterval(): void {
		if (this._intervalHandle !== undefined) {
			clearInterval(this._intervalHandle)
			this._intervalHandle = undefined
		}
	}

	private async _checkAll(): Promise<void> {
		try {
			await this._checkAllInner()
		} catch (e) {
			// Never let interval-triggered work become an unhandled rejection
			// on the extension host (reviews/02-bugs-and-correctness.md
			// "Rebase service has no timer cancellation on error").
			log.error('RebaseSuggestionService._checkAll failed: ' + (e instanceof Error ? e.message : String(e)))
		}
	}

	private async _checkAllInner(): Promise<void> {
		if (!this._workspaceRoot) {
			return
		}
		const stack = this._config.getStack()
		if (stack.length <= 1) {
			return
		}

		for (const entry of stack) {
			if (!entry.base || entry.base === entry.name) {
				continue
			}
			const cacheKey = `${entry.name}←${entry.base}`
			if (this._notified.has(cacheKey)) {
				continue
			}

			// Run git in the child's worktree so the refs are resolved in its context
			const wtDir = worktreePath(this._workspaceRoot, entry.name)
			const cwd = this._branchStack.worktreeExists(entry.name)
				? wtDir.fsPath
				: this._workspaceRoot.fsPath

			const behind = await this._countRevsBehind(cwd, entry.name, entry.base)
			if (behind === undefined || behind === 0) {
				continue
			}

			this._notified.add(cacheKey)
			log.info(`RebaseSuggestionService: "${entry.name}" is ${String(behind)} commit(s) behind "${entry.base}"`)

			const plural = behind === 1 ? 'commit' : 'commits'
			const msg = `"${entry.name}" is ${String(behind)} ${plural} behind "${entry.base}". Rebase now?`
			const choice = await vscode.window.showInformationMessage(msg, 'Rebase now', 'Dismiss')
			if (choice === 'Rebase now') {
				await this._rebaseBranch(entry.name)
			}
		}
	}

	async rebaseBranch(branchName: string): Promise<void> {
		return this._rebaseBranch(branchName)
	}

	private async _rebaseBranch(branchName: string): Promise<void> {
		if (!this._workspaceRoot) {
			return
		}
		const entry = this._config.getBranch(branchName)
		if (!entry) {
			return
		}

		const wtPath = worktreePath(this._workspaceRoot, branchName)
		const cwd = this._branchStack.worktreeExists(branchName)
			? wtPath.fsPath
			: this._workspaceRoot.fsPath

		const { exitCode, stderr } = await this._runner.run(
			['rebase', entry.base],
			{ cwd },
		)
		if (exitCode === 0) {
			this._notified.delete(`${entry.name}←${entry.base}`)
			log.info(`RebaseSuggestionService: rebased "${entry.name}" onto "${entry.base}"`)
			await vscode.window.showInformationMessage(`"${entry.name}" rebased onto "${entry.base}" successfully.`)
		} else {
			log.error(`RebaseSuggestionService: rebase failed for "${entry.name}": ${stderr}`)
			await vscode.window.showErrorMessage(
				`Rebase of "${entry.name}" failed. You may need to resolve conflicts manually.\n${stderr}`,
			)
		}
	}

	/**
	 * Count commits reachable from `parentBranch` but not `childBranch`, i.e.
	 * how far behind the child is.  Runs via spawn — no shell quoting needed.
	 */
	private async _countRevsBehind(
		cwd: string,
		childBranch: string,
		parentBranch: string,
	): Promise<number | undefined> {
		const { stdout, exitCode, stderr } = await this._runner.run(
			['rev-list', '--count', `${childBranch}..${parentBranch}`],
			{ cwd },
		)
		if (exitCode !== 0) {
			log.warn(`_countRevsBehind: ${childBranch}..${parentBranch} failed (exit=${String(exitCode)}): ${stderr}`)
			return undefined
		}
		const n = Number.parseInt(stdout.trim(), 10)
		return Number.isNaN(n) ? undefined : n
	}
}
