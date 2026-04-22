import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { log } from './channelLogger'
import { IGitRunner, getDefaultGitRunner } from './gitRunner'

// ─── Types ────────────────────────────────────────────────────────────────────

export type RebaseState = 'idle' | 'in-progress'

export interface InProgressRebase {
	worktreeDir: string
	/** Conflict-state relative paths parsed from `git status --porcelain=v1`. */
	conflictedFiles: string[]
}

// ─── Implementation ──────────────────────────────────────────────────────────

/**
 * Detects mid-rebase state in a worktree and exposes the three recovery
 * primitives — open conflicts, abort, continue — plus a file-system watcher
 * on `.git/rebase-merge/` so the "Rebase in progress" notification fires
 * the moment a rebase bails with conflicts, and auto-dismisses once the
 * user finishes the rebase (T70).
 *
 * Shape of what `git` leaves behind:
 *
 *   <worktree>/.git                  → "gitdir: …/.git/worktrees/<name>"
 *   <gitdir>/rebase-merge/           → present while a rebase is paused
 *   <gitdir>/rebase-apply/           → present during `git am` / `rebase
 *                                      --am` flows (older git)
 *
 * We watch for both directories.  The service is intentionally stateless
 * beyond the watcher — each `gitbraid.rebaseAbort` / `Continue` call
 * re-queries `git status` so the user can resolve conflicts via any path
 * (VS Code's merge editor, external tools, plain file edits) and we still
 * pick it up.
 */
export class RebaseRecovery implements vscode.Disposable {

	private readonly _disposables: vscode.Disposable[] = []
	private readonly _onDidChangeState = new vscode.EventEmitter<{ worktreeDir: string, state: RebaseState }>()
	/** Fires whenever a watched worktree transitions between idle ↔ in-progress. */
	readonly onDidChangeState = this._onDidChangeState.event
	/** Tracks the active notification per worktree so we dismiss it on completion. */
	private readonly _activeToast = new Map<string, { active: boolean }>()

	constructor(private readonly _runner: IGitRunner = getDefaultGitRunner()) {}

	dispose(): void {
		this._onDidChangeState.dispose()
		for (const d of this._disposables) {
			d.dispose()
		}
	}

	/**
	 * Begin watching a branch worktree for rebase state transitions.
	 * Returns a disposable that stops watching just this worktree.
	 */
	watch(worktreeDir: string): vscode.Disposable {
		// `.git` inside a worktree dir is a file pointing at the real gitdir;
		// the rebase-merge/rebase-apply dirs live under the real gitdir.
		// FileSystemWatcher globs don't follow `.git`'s gitdir indirection,
		// so watch the worktree-local `.git/rebase-*` pattern as well as
		// the resolved gitdir.
		const pattern = new vscode.RelativePattern(worktreeDir, '.git/**')
		const watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false)
		const check = () => { void this._recheck(worktreeDir) }

		const disp = vscode.Disposable.from(
			watcher,
			watcher.onDidCreate(check),
			watcher.onDidChange(check),
			watcher.onDidDelete(check),
		)
		this._disposables.push(disp)

		// Also check the resolved gitdir if the .git file indirection is in
		// use (worktrees created via `git worktree add`).
		const resolved = resolveGitDir(worktreeDir)
		if (resolved && resolved !== path.join(worktreeDir, '.git')) {
			const outerPattern = new vscode.RelativePattern(resolved, 'rebase-*/**')
			const outer = vscode.workspace.createFileSystemWatcher(outerPattern, false, false, false)
			this._disposables.push(
				outer,
				outer.onDidCreate(check),
				outer.onDidChange(check),
				outer.onDidDelete(check),
			)
		}

		// Seed the state so a pre-existing mid-rebase surfaces immediately.
		void this._recheck(worktreeDir)
		return disp
	}

	/** Snapshot the rebase state of a worktree without taking any action. */
	async inspect(worktreeDir: string): Promise<InProgressRebase | undefined> {
		if (!this._isMidRebase(worktreeDir)) {
			return undefined
		}
		const conflictedFiles = await this._listConflicts(worktreeDir)
		return { worktreeDir, conflictedFiles }
	}

	/** Run `git rebase --abort` in the given worktree. */
	async abort(worktreeDir: string): Promise<void> {
		const r = await this._runner.run(['rebase', '--abort'], { cwd: worktreeDir })
		if (r.exitCode === 0) {
			log.info(`RebaseRecovery: aborted rebase in ${worktreeDir}`)
			await vscode.window.showInformationMessage('GitBraid: rebase aborted.')
		} else {
			log.error(`RebaseRecovery: abort failed: ${r.stderr}`)
			await vscode.window.showErrorMessage(`GitBraid: abort failed — ${r.stderr.trim() || 'unknown error'}`)
		}
	}

	/** Run `git rebase --continue` — fails loudly if conflicts remain. */
	async continue(worktreeDir: string): Promise<void> {
		const remaining = await this._listConflicts(worktreeDir)
		if (remaining.length > 0) {
			await vscode.window.showWarningMessage(
				`GitBraid: ${String(remaining.length)} conflicted file(s) remain — resolve and stage them first.`,
			)
			return
		}
		const r = await this._runner.run(['rebase', '--continue'], { cwd: worktreeDir })
		if (r.exitCode === 0) {
			log.info(`RebaseRecovery: continued rebase in ${worktreeDir}`)
			await vscode.window.showInformationMessage('GitBraid: rebase continued.')
		} else {
			log.error(`RebaseRecovery: continue failed: ${r.stderr}`)
			await vscode.window.showErrorMessage(`GitBraid: continue failed — ${r.stderr.trim() || 'unknown error'}`)
		}
	}

	/** Open every conflicted file in VS Code's built-in merge editor (with plain-editor fallback). */
	async openConflicts(worktreeDir: string): Promise<void> {
		const files = await this._listConflicts(worktreeDir)
		if (files.length === 0) {
			await vscode.window.showInformationMessage('GitBraid: no conflicted files remain.')
			return
		}
		// Open up to the first 10 — more than that is overwhelming and VS Code
		// struggles to lay them out.  The user can re-run the command for more.
		const toOpen = files.slice(0, 10)
		for (const rel of toOpen) {
			const uri = vscode.Uri.file(path.join(worktreeDir, rel))
			try {
				await vscode.commands.executeCommand('git.openMergeEditor', uri)
			} catch {
				// Merge editor unavailable (older VS Code / extension disabled) — fall back.
				try {
					await vscode.window.showTextDocument(uri, { preview: false })
				} catch (e) {
					log.warn(`RebaseRecovery: failed to open ${rel}: ${e instanceof Error ? e.message : String(e)}`)
				}
			}
		}
		const opened = toOpen.length
		if (files.length > opened) {
			await vscode.window.showInformationMessage(
				`Opened ${String(opened)} of ${String(files.length)} conflicted files. Run "Open Rebase Conflicts" again for the rest.`,
			)
		} else if (opened > 0) {
			await vscode.window.showInformationMessage(
				`Opened ${String(opened)} conflicted file${opened !== 1 ? 's' : ''} in the merge editor. Resolve conflicts, then run "Continue Rebase".`,
			)
		}
	}

	// ── Private ───────────────────────────────────────────────────────────────

	private async _recheck(worktreeDir: string): Promise<void> {
		const inRebase = this._isMidRebase(worktreeDir)
		const entry = this._activeToast.get(worktreeDir) ?? { active: false }

		if (inRebase && !entry.active) {
			entry.active = true
			this._activeToast.set(worktreeDir, entry)
			this._onDidChangeState.fire({ worktreeDir, state: 'in-progress' })
			void this._promptRecovery(worktreeDir)
		} else if (!inRebase && entry.active) {
			entry.active = false
			this._activeToast.set(worktreeDir, entry)
			this._onDidChangeState.fire({ worktreeDir, state: 'idle' })
		}
	}

	private async _promptRecovery(worktreeDir: string): Promise<void> {
		const conflicts = await this._listConflicts(worktreeDir)
		const title = conflicts.length > 0
			? `GitBraid: rebase paused with ${String(conflicts.length)} conflicted file(s).`
			: 'GitBraid: rebase in progress.'

		const pick = await vscode.window.showWarningMessage(
			title,
			{ modal: false },
			'Open Conflicts',
			'Abort',
			'Continue',
		)
		if (!pick) return
		switch (pick) {
			case 'Open Conflicts': await this.openConflicts(worktreeDir); break
			case 'Abort':          await this.abort(worktreeDir); break
			case 'Continue':       await this.continue(worktreeDir); break
		}
	}

	private _isMidRebase(worktreeDir: string): boolean {
		const gitdir = resolveGitDir(worktreeDir) ?? path.join(worktreeDir, '.git')
		return fs.existsSync(path.join(gitdir, 'rebase-merge')) ||
			fs.existsSync(path.join(gitdir, 'rebase-apply'))
	}

	private async _listConflicts(worktreeDir: string): Promise<string[]> {
		const r = await this._runner.run(['status', '--porcelain=v1', '-z'], { cwd: worktreeDir })
		if (r.exitCode !== 0) return []
		const out: string[] = []
		for (const entry of r.stdout.split('\0')) {
			if (entry.length < 4) continue
			const xy = entry.slice(0, 2)
			const file = entry.slice(3)
			// Conflict states per git-status(1): UU, AA, DD, UD, DU, AU, UA.
			if (/^(UU|AA|DD|UD|DU|AU|UA)$/.test(xy)) {
				out.push(file)
			}
		}
		return out
	}
}

/**
 * Resolve the real gitdir for a worktree.  For a worktree created by
 * `git worktree add`, `<worktree>/.git` is a file containing
 * `gitdir: /abs/path/to/.git/worktrees/<name>`.  For a plain repo the file
 * is absent and the directory itself IS the gitdir.
 */
function resolveGitDir(worktreeDir: string): string | undefined {
	const dotgit = path.join(worktreeDir, '.git')
	try {
		const st = fs.statSync(dotgit, { throwIfNoEntry: false })
		if (!st) return undefined
		if (st.isDirectory()) return dotgit
		if (st.isFile()) {
			const content = fs.readFileSync(dotgit, 'utf-8').trim()
			const m = /^gitdir:\s*(.+)$/.exec(content)
			if (m) {
				return path.resolve(worktreeDir, m[1])
			}
		}
	} catch {
		return undefined
	}
	return undefined
}
