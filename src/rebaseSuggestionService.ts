import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { log } from './channelLogger'
import { ConfigService } from './configService'
import { BranchStackService, worktreePath } from './branchStackService'
import { IGitRunner, getDefaultGitRunner } from './gitRunner'
import type { RebaseRecovery } from './rebaseRecovery'

/**
 * Detect whether `worktreeDir` is currently in the middle of a rebase.
 * Inlined (not imported from `rebaseRecovery`) to avoid a circular import
 * — `rebaseSuggestionService` already has a terminal position in the
 * dependency graph, and both consumers work out of the same git state.
 */
function isMidRebase(worktreeDir: string): boolean {
	let gitdir = path.join(worktreeDir, '.git')
	try {
		const st = fs.statSync(gitdir, { throwIfNoEntry: false })
		if (st && st.isFile()) {
			const content = fs.readFileSync(gitdir, 'utf-8').trim()
			const m = /^gitdir:\s*(.+)$/.exec(content)
			if (m) gitdir = path.resolve(worktreeDir, m[1])
		}
	} catch {
		return false
	}
	return fs.existsSync(path.join(gitdir, 'rebase-merge')) ||
		fs.existsSync(path.join(gitdir, 'rebase-apply'))
}

/**
 * Result of a conflict-prediction dry run (see {@link RebaseSuggestionService.predictConflict}).
 */
export interface ConflictPrediction {
	/**
	 * `false` when the installed git doesn't support `merge-tree --write-tree`
	 * (added in git 2.38) — callers should treat this as "prediction
	 * unavailable" and skip the warning rather than reporting a false
	 * "no conflicts".
	 */
	supported: boolean
	conflicted: boolean
	/** Best-effort list of conflicting paths, parsed from `merge-tree`'s output. */
	files: string[]
}

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
		private readonly _rebaseRecovery?: RebaseRecovery,
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

	/**
	 * Dry-run whether rebasing `branch` onto `base` is likely to conflict,
	 * without touching the working tree, the index, or any ref — via
	 * `git merge-tree --write-tree` (git ≥ 2.38), which performs the merge
	 * entirely on tree objects. This is a proxy, not an exact simulation:
	 * a merge of the two tips can conflict in different places than a
	 * commit-by-commit rebase would, but it catches the common case (the
	 * branch's own edits diverging from its base) cheaply and up front,
	 * rather than the user discovering it mid-rebase with a half-applied
	 * working tree to clean up.
	 */
	async predictConflict(cwd: string, branch: string, base: string): Promise<ConflictPrediction> {
		// Verify both refs actually resolve before asking merge-tree to
		// evaluate them — a nonexistent ref makes merge-tree exit non-zero
		// with wording that isn't worth trying to distinguish from a real
		// conflict by parsing stderr, so check explicitly instead.
		const branchOk = await this._refExists(cwd, branch)
		const baseOk = branchOk && await this._refExists(cwd, base)
		if (!branchOk || !baseOk) {
			return { supported: false, conflicted: false, files: [] }
		}

		const { stdout, stderr, exitCode } = await this._runner.run(
			['merge-tree', '--write-tree', base, branch],
			{ cwd },
		)
		if (exitCode === 0) {
			return { supported: true, conflicted: false, files: [] }
		}
		if (/unknown option|usage:/i.test(stderr)) {
			// Older git (pre-2.38) doesn't support `--write-tree` at all —
			// prediction isn't available; proceed without a warning rather
			// than surface a false one.
			return { supported: false, conflicted: false, files: [] }
		}
		const files = [...stdout.matchAll(/CONFLICT \([^)]*\):.*? in (.+)$/gm)].map((m) => m[1].trim())
		return { supported: true, conflicted: true, files }
	}

	/** Does `ref` resolve to a real commit in `cwd`'s repository? */
	private async _refExists(cwd: string, ref: string): Promise<boolean> {
		const { exitCode } = await this._runner.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd })
		return exitCode === 0
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

		const prediction = await this.predictConflict(cwd, entry.name, entry.base)
		if (prediction.supported && prediction.conflicted) {
			const fileList = prediction.files.length > 0
				? ` in ${prediction.files.slice(0, 5).join(', ')}${prediction.files.length > 5 ? `, +${String(prediction.files.length - 5)} more` : ''}`
				: ''
			const choice = await vscode.window.showWarningMessage(
				`Rebasing "${entry.name}" onto "${entry.base}" is predicted to conflict${fileList}. Continue anyway?`,
				{ modal: true },
				'Continue Anyway',
			)
			if (choice !== 'Continue Anyway') {
				log.info(`RebaseSuggestionService: user declined predicted-conflict rebase of "${entry.name}"`)
				return
			}
		}

		const { exitCode, stderr } = await this._runner.run(
			['rebase', '--autostash', entry.base],
			{ cwd },
		)
		if (exitCode === 0) {
			this._notified.delete(`${entry.name}←${entry.base}`)
			log.info(`RebaseSuggestionService: rebased "${entry.name}" onto "${entry.base}"`)
			await vscode.window.showInformationMessage(`"${entry.name}" rebased onto "${entry.base}" successfully.`)
		} else {
			log.error(`RebaseSuggestionService: rebase failed for "${entry.name}": ${stderr}`)
			// If the worktree is in mid-rebase state the `RebaseRecovery`
			// watcher will surface the conflict resolution prompt.  Point the
			// user at it rather than duplicating the "resolve manually" popup.
			const paused = isMidRebase(cwd)
			if (paused) {
				await vscode.window.showWarningMessage(
					`Rebase of "${entry.name}" paused — resolve the conflicts then run "GitBraid: Continue Rebase".`,
					{ modal: false },
				)
			} else if (stderr.includes('autostash')) {
				// Rebase succeeded but restoring the stashed changes hit conflicts.
				// The stash entry is still intact — resolve the conflict markers in the
				// working tree, stage the files, then `git stash drop` to clean up.
				const pick = await vscode.window.showWarningMessage(
					`Rebase of "${entry.name}" succeeded but restoring stashed changes hit conflicts — ` +
					`resolve them in the editor, then run \`git stash drop\` in the worktree.`,
					{ modal: false },
					'Open Conflicts',
				)
				if (pick === 'Open Conflicts' && this._rebaseRecovery) {
					await this._rebaseRecovery.openConflicts(cwd)
				}
			} else {
				await vscode.window.showErrorMessage(
					`Rebase of "${entry.name}" failed.\n${stderr}`,
				)
			}
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
