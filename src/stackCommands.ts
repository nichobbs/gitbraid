import * as vscode from 'vscode'
import * as fs from 'node:fs'
import { log } from './channelLogger'
import { ConfigService } from './configService'
import { BranchStackService, worktreePath } from './branchStackService'
import { RebaseSuggestionService } from './rebaseSuggestionService'
import { IGitRunner, getDefaultGitRunner } from './gitRunner'
import { GitError } from './errors'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PushStackOptions {
	/** Pass `--force-with-lease` to git push.  Default false. */
	forceWithLease?: boolean
	/** Remote to push to.  Default "origin". */
	remote?: string
	/** Skip branches whose worktree is missing on disk.  Default true. */
	skipMissing?: boolean
}

export interface SyncStackOptions {
	/** Remote to fetch from.  Default "origin". */
	remote?: string
}

export interface StackOpResult {
	branch: string
	ok: boolean
	message?: string
}

// ─── Implementation ──────────────────────────────────────────────────────────

/**
 * Stack-wide git operations (T67).
 *
 * Both operations iterate the stack in `ConfigService.getStack()` order and
 * surface a summary at the end rather than modal-bombing the user on every
 * failure.  Individual failures are logged via `log.error`; the dialog shows
 * a count plus a "View Output" action.
 *
 * Design choices worth noting:
 *
 * - `pushStack` defaults to `--force-with-lease` **off** — a fresh push is
 *   safe; ratchet-up to force requires user opt-in.
 * - `syncStack` never runs `git rebase` inside a dirty worktree. If a
 *   worktree is dirty the branch is skipped with a clear note, so the user
 *   gets pointed at the branch that needs attention rather than a partial
 *   rebase half-applied.
 * - Rebases that fail mid-run are surfaced through the {@link
 *   RebaseSuggestionService._rebaseBranch} → recovery UI hand-off (T70),
 *   not duplicated here — we just record the failure and move on.
 */
export class StackCommands implements vscode.Disposable {

	constructor(
		private readonly _config: ConfigService,
		private readonly _branchStack: BranchStackService,
		private readonly _rebaseSvc: RebaseSuggestionService,
		private readonly _workspaceRoot: vscode.Uri,
		private readonly _runner: IGitRunner = getDefaultGitRunner(),
	) {}

	dispose(): void { /* nothing to tear down yet */ }

	// ── pushStack ─────────────────────────────────────────────────────────────

	async pushStack(options: PushStackOptions = {}): Promise<StackOpResult[]> {
		const remote = options.remote ?? 'origin'
		const skipMissing = options.skipMissing ?? true
		const stack = this._config.getStack()
		if (stack.length === 0) {
			await vscode.window.showInformationMessage('GitBraid: the stack is empty — nothing to push.')
			return []
		}

		const results: StackOpResult[] = []
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `GitBraid: pushing ${String(stack.length)} branch(es)…`,
				cancellable: false,
			},
			async (progress) => {
				let i = 0
				for (const entry of stack) {
					i += 1
					progress.report({
						message: `${String(i)}/${String(stack.length)} ${entry.name}`,
					})
					const result = await this._pushOne(entry.name, remote, options.forceWithLease ?? false, skipMissing)
					results.push(result)
					if (!result.ok) {
						log.error(`pushStack: ${entry.name} → ${result.message ?? 'unknown failure'}`)
					}
				}
			},
		)
		await this._summarise('Push', results)
		return results
	}

	private async _pushOne(
		branch: string,
		remote: string,
		force: boolean,
		skipMissing: boolean,
	): Promise<StackOpResult> {
		const wtPath = worktreePath(this._workspaceRoot, branch)
		const hasWorktree = fs.existsSync(wtPath.fsPath)
		if (!hasWorktree) {
			if (skipMissing) {
				return { branch, ok: true, message: 'skipped (no worktree)' }
			}
			return { branch, ok: false, message: 'worktree missing' }
		}

		// First push uses `-u` to set upstream; subsequent pushes don't need
		// it but passing `-u` is idempotent so always include it.  `git push`
		// errors on `--force-with-lease` when there's no upstream yet, so we
		// only add it when we know the remote tracking ref exists.
		const args: string[] = ['push', '-u']
		if (force) {
			const trackingCheck = await this._runner.run(
				['rev-parse', '--abbrev-ref', `${branch}@{upstream}`],
				{ cwd: wtPath.fsPath },
			)
			if (trackingCheck.exitCode === 0) {
				args.push('--force-with-lease')
			}
		}
		args.push(remote, branch)

		const { exitCode, stderr } = await this._runner.run(args, { cwd: wtPath.fsPath })
		if (exitCode === 0) {
			return { branch, ok: true }
		}
		return { branch, ok: false, message: stderr.trim() || `git push exited ${String(exitCode)}` }
	}

	// ── syncStack ─────────────────────────────────────────────────────────────

	async syncStack(options: SyncStackOptions = {}): Promise<StackOpResult[]> {
		const remote = options.remote ?? 'origin'
		const stack = this._config.getStack()
		if (stack.length === 0) {
			await vscode.window.showInformationMessage('GitBraid: the stack is empty — nothing to sync.')
			return []
		}

		const results: StackOpResult[] = []
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `GitBraid: syncing ${String(stack.length)} branch(es)…`,
				cancellable: false,
			},
			async (progress) => {
				// Fetch once up-front — faster than per-branch fetches and
				// gives every rebase a consistent view of the remote.
				progress.report({ message: `fetch ${remote}` })
				const fetch = await this._runner.run(['fetch', remote], { cwd: this._workspaceRoot.fsPath })
				if (fetch.exitCode !== 0) {
					results.push({ branch: `(${remote})`, ok: false, message: `fetch failed: ${fetch.stderr.trim()}` })
					return
				}

				// Rebase every child branch onto its parent, bottom-up.  The
				// stack is already ordered by `order` ascending in
				// `ConfigService.getStack()`, so a single pass suffices —
				// each child sees its parent's freshly-rebased tip.
				let i = 0
				for (const entry of stack) {
					i += 1
					progress.report({ message: `${String(i)}/${String(stack.length)} rebase ${entry.name}` })

					if (!entry.base) {
						results.push({ branch: entry.name, ok: true, message: 'skipped (no base)' })
						continue
					}
					if (!fs.existsSync(worktreePath(this._workspaceRoot, entry.name).fsPath)) {
						results.push({ branch: entry.name, ok: true, message: 'skipped (no worktree)' })
						continue
					}
					const dirty = await this._isDirty(entry.name)
					if (dirty) {
						results.push({
							branch: entry.name,
							ok: false,
							message: 'worktree has uncommitted changes — commit or stash, then re-run Sync Stack',
						})
						continue
					}
					try {
						await this._rebaseSvc.rebaseBranch(entry.name)
						results.push({ branch: entry.name, ok: true })
					} catch (e) {
						results.push({
							branch: entry.name,
							ok: false,
							message: e instanceof GitError ? e.message : (e instanceof Error ? e.message : String(e)),
						})
					}
				}
			},
		)
		await this._summarise('Sync', results)
		return results
	}

	private async _isDirty(branch: string): Promise<boolean> {
		const wtPath = worktreePath(this._workspaceRoot, branch)
		const { stdout, exitCode } = await this._runner.run(
			['status', '--porcelain'],
			{ cwd: wtPath.fsPath },
		)
		if (exitCode !== 0) {
			// Conservative — treat an errored status as dirty rather than
			// blundering a rebase over whatever state the worktree is in.
			return true
		}
		return stdout.trim().length > 0
	}

	// ── Shared reporting ──────────────────────────────────────────────────────

	private async _summarise(op: string, results: StackOpResult[]): Promise<void> {
		const failed = results.filter((r) => !r.ok)
		const skipped = results.filter((r) => r.ok && r.message && r.message.startsWith('skipped'))
		const ok = results.length - failed.length - skipped.length
		const summary = `GitBraid ${op}: ${String(ok)} ok, ${String(skipped.length)} skipped, ${String(failed.length)} failed`
		log.info(summary)

		if (failed.length === 0) {
			await vscode.window.showInformationMessage(summary)
			return
		}
		const detail = failed
			.slice(0, 3)
			.map((r) => `• ${r.branch}: ${r.message ?? 'unknown'}`)
			.join('\n')
		const more = failed.length > 3 ? `\n(+${String(failed.length - 3)} more in Output)` : ''
		const pick = await vscode.window.showWarningMessage(
			`${summary}\n${detail}${more}`,
			{ modal: false },
			'Open Output',
		)
		if (pick === 'Open Output') {
			log.show()
		}
	}
}
