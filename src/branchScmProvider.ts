import * as vscode from 'vscode'
import * as fs from 'node:fs'
import { log } from './channelLogger'
import { ConfigService } from './configService'
import { WorkspaceSync } from './workspaceSync'
import { worktreePath } from './branchStackService'
import { BranchStackEntry } from './configTypes'
import { IGitRunner, getDefaultGitRunner } from './gitRunner'
import { showError } from './errorSurfacer'

// ─── Git status parsing ───────────────────────────────────────────────────────

interface WorktreeFileStatus {
	/** XY status code from `git status --porcelain=v1` */
	xy: string
	relativePath: string
}

async function gitStatusInDir(runner: IGitRunner, dir: string): Promise<WorktreeFileStatus[]> {
	const { stdout, exitCode } = await runner.run(
		['status', '--porcelain=v1', '-z'],
		{ cwd: dir },
	)
	if (exitCode !== 0) {
		// Worktree may not exist yet or git is unavailable — treat as empty
		return []
	}
	const results: WorktreeFileStatus[] = []
	// NUL-separated entries in porcelain v1 -z format.
	// Each primary entry is "XY<SP>path"; for renames the old path follows as
	// a bare "old_path" token (no XY prefix).  We skip those secondary tokens
	// by requiring entry[2] === ' '.
	const entries = stdout.split('\0').filter((s) => s.length > 0)
	for (const entry of entries) {
		if (entry.length < 4 || entry[2] !== ' ') continue
		const xy = entry.slice(0, 2)
		const file = entry.slice(3)
		if (file) {
			results.push({ xy, relativePath: file })
		}
	}
	return results
}

function toResourceState(uri: vscode.Uri): vscode.SourceControlResourceState {
	return {
		resourceUri: uri,
		command: {
			command: 'vscode.open',
			title: 'Open',
			arguments: [uri],
		},
	}
}

// ─── Per-branch provider ──────────────────────────────────────────────────────

/**
 * A single `vscode.SourceControl` instance for one branch in the stack.
 *
 * Displays `Staged Changes` and `Changes` resource groups populated from
 * `git status --porcelain` in the branch's worktree directory.
 */
class BranchScmEntry implements vscode.Disposable {

	private readonly _sc: vscode.SourceControl
	private readonly _staged: vscode.SourceControlResourceGroup
	private readonly _changes: vscode.SourceControlResourceGroup
	private readonly _disposables: vscode.Disposable[] = []

	constructor(
		private readonly _entry: BranchStackEntry,
		private readonly _worktreeDir: string,
		private readonly _workspaceRoot: vscode.Uri,
		private readonly _runner: IGitRunner = getDefaultGitRunner(),
	) {
		this._sc = vscode.scm.createSourceControl(
			`gitbraid-${_entry.name}`,
			_entry.name,
			_workspaceRoot,
		)
		this._sc.inputBox.placeholder = `Commit to ${_entry.name} (message)`
		this._sc.acceptInputCommand = {
			command: 'gitbraid.scm.commitBranch',
			title: 'Commit',
			arguments: [_entry.name],
		}
		this._sc.statusBarCommands = [
			{
				command: 'gitbraid.scm.generateCommitMessage',
				title: '$(sparkle) Message',
				tooltip: `Generate commit message for ${_entry.name}`,
				arguments: [_entry.name],
			},
			{
				command: 'gitbraid.scm.stashBranch',
				title: '$(archive) Stash',
				tooltip: `Stash changes in ${_entry.name}`,
				arguments: [_entry.name],
			},
			{
				command: 'gitbraid.scm.pushBranch',
				title: '$(cloud-upload) Push',
				tooltip: `Push ${_entry.name}`,
				arguments: [_entry.name],
			},
		]
		this._sc.quickDiffProvider = undefined

		this._staged = this._sc.createResourceGroup('staged', 'Staged Changes')
		this._staged.hideWhenEmpty = true

		this._changes = this._sc.createResourceGroup('changes', 'Changes')
		this._changes.hideWhenEmpty = true

		this._disposables.push(this._sc, this._staged, this._changes)
	}

	get branchName(): string { return this._entry.name }
	get worktreeDir(): string { return this._worktreeDir }
	get inputBox(): vscode.SourceControlInputBox { return this._sc.inputBox }

	/** Last status snapshot; used to skip redundant group updates (T47). */
	private _lastStatusHash: string | undefined
	/** Timestamp of the last refresh; combined with REFRESH_TTL_MS to coalesce bursts. */
	private _lastRefreshAt = 0

	async refresh(force = false): Promise<void> {
		const now = Date.now()
		if (!force && now - this._lastRefreshAt < 2_000) {
			// Within the TTL window — skip.  A rapid burst of save events
			// (common when a formatter touches many files) collapses to one
			// SCM redraw.
			return
		}
		this._lastRefreshAt = now
		// If the worktree directory does not exist the branch is the currently
		// checked-out branch whose files live in the primary workspace.  Fall
		// back to the workspace root so its changes are visible in the SCM view
		// (important when the built-in git provider is disabled).
		const statusDir = fs.existsSync(this._worktreeDir)
			? this._worktreeDir
			: this._workspaceRoot.fsPath
		const statusRoot = fs.existsSync(this._worktreeDir)
			? vscode.Uri.file(this._worktreeDir)
			: this._workspaceRoot
		const statuses = await gitStatusInDir(this._runner, statusDir)
		const stagedUris: vscode.SourceControlResourceState[] = []
		const changedUris: vscode.SourceControlResourceState[] = []

		for (const { xy, relativePath } of statuses) {
			const uri = vscode.Uri.joinPath(statusRoot, relativePath)
			const indexStatus = xy[0]
			const workStatus = xy[1]

			if (indexStatus !== ' ' && indexStatus !== '?') {
				stagedUris.push(toResourceState(uri))
			}
			if (workStatus !== ' ' && workStatus !== '?') {
				changedUris.push(toResourceState(uri))
			}
			// Untracked (both '?') — show in Changes group
			if (xy === '??') {
				changedUris.push(toResourceState(uri))
			}
		}

		// Skip the resource-state update when the status set is unchanged —
		// VS Code treats every assignment as a state mutation that re-renders
		// the SCM pane (T47).
		const hash = statuses.map((s) => `${s.xy}\t${s.relativePath}`).join('\n')
		if (hash === this._lastStatusHash) {
			return
		}
		this._lastStatusHash = hash

		this._staged.resourceStates = stagedUris
		this._changes.resourceStates = changedUris
	}

	dispose(): void {
		for (const d of this._disposables) {
			d.dispose()
		}
	}
}

// ─── Manager ─────────────────────────────────────────────────────────────────

/**
 * Creates and manages one `BranchScmEntry` per branch in the stack.
 *
 * Refreshes SCM state on file saves (via `WorkspaceSync.onDidSyncFile`) and
 * when the stack changes (via `ConfigService.onDidChangeStack`).
 */
export class BranchScmProviderManager implements vscode.Disposable {

	private readonly _entries = new Map<string, BranchScmEntry>()
	private readonly _disposables: vscode.Disposable[] = []

	constructor(
		private readonly _config: ConfigService,
		private readonly _sync: WorkspaceSync,
		private readonly _workspaceRoot: vscode.Uri,
		private readonly _runner: IGitRunner = getDefaultGitRunner(),
	) {
		this._disposables.push(
			_config.onDidChangeStack(() => void this._rebuild()),
			// Targeted per-branch refresh (T47) — only the branch whose
			// worktree received the sync needs to re-run `git status`.  The
			// old `_refreshAll()` fired N forks per save.
			_sync.onDidSyncFile((e) => void this._refreshBranch(e.branch)),
		)
	}

	/** Refresh SCM status for a single branch (cache-aware). */
	private async _refreshBranch(branchName: string): Promise<void> {
		const entry = this._entries.get(branchName)
		if (!entry) return
		try {
			await entry.refresh()
		} catch (e) {
			log.warn(`[BranchScmProvider] refresh "${branchName}" failed: ${e instanceof Error ? e.message : String(e)}`)
		}
	}

	/**
	 * Perform the initial worktree scan. Call once after construction.
	 * Separated from the constructor to avoid async-in-constructor lint issues.
	 */
	async initialize(): Promise<void> {
		await this._rebuild()
	}

	/** Refresh SCM status for all branches (e.g. after a save). */
	async refreshAll(): Promise<void> {
		await this._refreshAll()
	}

	private async _rebuild(): Promise<void> {
		// Sort branches alphabetically so the SCM view presents them in a
		// consistent, predictable order regardless of stack insertion sequence.
		const stackEntries = [...this._config.getStack()].sort((a, b) => a.name.localeCompare(b.name))
		const currentNames = new Set(stackEntries.map((e) => e.name))

		// Save input-box values so typed-but-not-committed messages survive a
		// rebuild (e.g. when the user adds a new branch while composing a commit).
		const savedValues = new Map<string, string>()
		for (const [name, entry] of this._entries) {
			savedValues.set(name, entry.inputBox.value)
		}

		// Dispose all existing entries and recreate in sorted order.
		// VS Code shows SCM providers in creation order, so recreating them
		// ensures alphabetical display even after branches are added/reordered.
		for (const entry of this._entries.values()) {
			entry.dispose()
		}
		this._entries.clear()

		for (const branchEntry of stackEntries) {
			if (!currentNames.has(branchEntry.name)) continue
			const wtDir = worktreePath(this._workspaceRoot, branchEntry.name).fsPath
			const scmEntry = new BranchScmEntry(branchEntry, wtDir, this._workspaceRoot, this._runner)
			const saved = savedValues.get(branchEntry.name)
			if (saved) scmEntry.inputBox.value = saved
			this._entries.set(branchEntry.name, scmEntry)
		}

		await this._refreshAll()
	}

	private async _refreshAll(): Promise<void> {
		// Use allSettled so a single failing branch doesn't poison the whole
		// refresh (reviews/06-error-handling-and-logging.md "Error flow in
		// long-running operations").
		const results = await Promise.allSettled(
			[...this._entries.entries()].map(async ([name, e]) => {
				try {
					await e.refresh()
				} catch (err) {
					log.warn(`[BranchScmProvider] refresh "${name}" failed: ${err instanceof Error ? err.message : String(err)}`)
					throw err
				}
			}),
		)
		const failed = results.filter((r) => r.status === 'rejected').length
		if (failed > 0) {
			log.warn(`[BranchScmProvider] ${failed} of ${results.length} SCM refreshes failed`)
		}
	}

	/**
	 * Commit all staged changes in the given branch's worktree.
	 * Shows a warning (not a block) if floating files exist.
	 */
	/** Set the commit message input box for a branch (used by AI generation). */
	setInputBoxValue(branchName: string, value: string): void {
		const entry = this._entries.get(branchName)
		if (entry) {
			entry.inputBox.value = value
		}
	}

	/** Push the branch's worktree to origin, setting upstream if needed. */
	async pushBranch(branchName: string): Promise<void> {
		const entry = this._entries.get(branchName)
		if (!entry) {
			await vscode.window.showErrorMessage(`Branch "${branchName}" not found in stack`)
			return
		}
		const { exitCode, stderr } = await this._runner.run(
			['push'],
			{ cwd: entry.worktreeDir },
		)
		if (exitCode === 0) {
			log.info(`[BranchScmProvider] pushed "${branchName}"`)
			await vscode.window.showInformationMessage(`GitBraid: pushed "${branchName}"`)
		} else if (stderr.includes('no upstream') || stderr.includes('has no upstream')) {
			// First push — set upstream automatically
			const { exitCode: ec2, stderr: se2 } = await this._runner.run(
				['push', '--set-upstream', 'origin', branchName],
				{ cwd: entry.worktreeDir },
			)
			if (ec2 === 0) {
				log.info(`[BranchScmProvider] pushed "${branchName}" with --set-upstream`)
				await vscode.window.showInformationMessage(`GitBraid: pushed "${branchName}" and set upstream`)
			} else {
				await showError(`Push "${branchName}" failed`, new Error(se2 || `git push exited ${String(ec2)}`))
			}
		} else {
			await showError(`Push "${branchName}" failed`, new Error(stderr || `git push exited ${String(exitCode)}`))
		}
	}

	/**
	 * Stash or pop stash in a branch's worktree.
	 * Shows a quick-pick: Stash / Stash Pop.
	 */
	async stashBranch(branchName: string): Promise<void> {
		const entry = this._entries.get(branchName)
		if (!entry) {
			await vscode.window.showErrorMessage(`Branch "${branchName}" not found in stack`)
			return
		}
		const op = await vscode.window.showQuickPick(
			[
				{ label: '$(archive) Stash', description: 'Save current changes to a stash', value: 'push' as const },
				{ label: '$(history) Stash Pop', description: 'Apply and remove the most recent stash', value: 'pop' as const },
			],
			{ placeHolder: `Stash operation for "${branchName}"` },
		)
		if (!op) return

		const args = op.value === 'push'
			? ['stash', 'push', '--include-untracked']
			: ['stash', 'pop']

		const { exitCode, stderr } = await this._runner.run(args, { cwd: entry.worktreeDir })
		if (exitCode === 0) {
			log.info(`[BranchScmProvider] stash ${op.value} "${branchName}"`)
			const msg = op.value === 'push'
				? `GitBraid: stashed changes in "${branchName}"`
				: `GitBraid: applied stash in "${branchName}"`
			await vscode.window.showInformationMessage(msg)
			await entry.refresh(true)
		} else {
			await showError(`Stash ${op.value} "${branchName}" failed`, new Error(stderr || `git stash exited ${String(exitCode)}`))
		}
	}

	async commitBranch(branchName: string): Promise<void> {
		const entry = this._entries.get(branchName)
		if (!entry) {
			await vscode.window.showErrorMessage(`Branch "${branchName}" not found in stack`)
			return
		}

		const message = entry.inputBox.value.trim()
		if (!message) {
			await vscode.window.showWarningMessage('Enter a commit message before committing.')
			return
		}

		// Warn about floating files (non-blocking), honouring
		// gitbraid.showFloatingWarningOnCommit (declared in package.json but
		// previously unread — see reviews/02-bugs-and-correctness.md
		// "showFloatingWarningOnCommit setting is ignored").
		const showWarning = vscode.workspace.getConfiguration('gitbraid').get<boolean>('showFloatingWarningOnCommit', true)
		const floating = this._sync.getFloatingDirty()
		if (showWarning && floating.length > 0) {
			const suffix = floating.length > 5 ? ` …and ${floating.length - 5} more` : ''
			const fileList = floating.slice(0, 5).join(', ') + suffix
			const proceed = await vscode.window.showWarningMessage(
				`${floating.length} file(s) are floating (unassigned) and will NOT be committed:\n${fileList}`,
				{ modal: true },
				'Commit anyway',
			)
			if (proceed !== 'Commit anyway') { return }
		}

		const { exitCode, stderr } = await this._runner.run(
			['commit', '-m', message],
			{ cwd: entry.worktreeDir },
		)
		if (exitCode === 0) {
			entry.inputBox.value = ''
			log.info(`[BranchScmProvider] committed to "${branchName}"`)
			await entry.refresh(true)
		} else {
			await showError(`Commit to "${branchName}" failed`, new Error(stderr || `git commit exited ${String(exitCode)}`))
		}
	}

	dispose(): void {
		for (const entry of this._entries.values()) {
			entry.dispose()
		}
		this._entries.clear()
		for (const d of this._disposables) {
			d.dispose()
		}
	}
}
