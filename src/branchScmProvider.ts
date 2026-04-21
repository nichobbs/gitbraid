import * as vscode from 'vscode'
import { log } from './channelLogger'
import { ConfigService } from './configService'
import { WorkspaceSync } from './workspaceSync'
import { worktreePath } from './branchStackService'
import { BranchStackEntry } from './configTypes'
import { IGitRunner, getDefaultGitRunner } from './gitRunner'

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
	// null-separated entries; each entry is "<XY> <path>" (or rename "XY old\0new")
	const entries = stdout.split('\0').filter((s) => s.length > 0)
	for (const entry of entries) {
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
		private readonly _runner: IGitRunner = getDefaultGitRunner(),
	) {
		this._sc = vscode.scm.createSourceControl(
			`gitbraid-${_entry.name}`,
			`GitBraid: ${_entry.name}`,
			vscode.Uri.file(_worktreeDir),
		)
		this._sc.inputBox.placeholder = `Commit to ${_entry.name} (message)`
		this._sc.acceptInputCommand = {
			command: 'gitbraid.scm.commitBranch',
			title: 'Commit',
			arguments: [_entry.name],
		}
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
		const statuses = await gitStatusInDir(this._runner, this._worktreeDir)
		const stagedUris: vscode.SourceControlResourceState[] = []
		const changedUris: vscode.SourceControlResourceState[] = []

		for (const { xy, relativePath } of statuses) {
			const uri = vscode.Uri.joinPath(vscode.Uri.file(this._worktreeDir), relativePath)
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
 * Also manages the top-level `Floating` resource group showing unassigned
 * dirty files.
 *
 * Refreshes SCM state on file saves (via `WorkspaceSync.onDidSyncFile`) and
 * when the stack changes (via `ConfigService.onDidChangeStack`).
 */
export class BranchScmProviderManager implements vscode.Disposable {

	private readonly _entries = new Map<string, BranchScmEntry>()
	private readonly _floatingSc: vscode.SourceControl
	private readonly _floatingGroup: vscode.SourceControlResourceGroup
	private readonly _disposables: vscode.Disposable[] = []

	constructor(
		private readonly _config: ConfigService,
		private readonly _sync: WorkspaceSync,
		private readonly _workspaceRoot: vscode.Uri,
		private readonly _runner: IGitRunner = getDefaultGitRunner(),
	) {
		// Top-level "Floating" source control — unassigned dirty files
		this._floatingSc = vscode.scm.createSourceControl(
			'gitbraid-floating',
			'GitBraid: Floating (unassigned)',
			_workspaceRoot,
		)
		this._floatingSc.inputBox.visible = false
		this._floatingGroup = this._floatingSc.createResourceGroup('floating', 'Unassigned (floating)')
		this._floatingGroup.hideWhenEmpty = true

		this._disposables.push(
			this._floatingSc,
			this._floatingGroup,
			_config.onDidChangeStack(() => void this._rebuild()),
			// Targeted per-branch refresh (T47) — only the branch whose
			// worktree received the sync needs to re-run `git status`.  The
			// old `_refreshAll()` fired N forks per save.
			_sync.onDidSyncFile((e) => void this._refreshBranch(e.branch)),
			_sync.onDidFloatFile(() => this._refreshFloating()),
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
		this._refreshFloating()
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
		// Dispose entries for branches no longer in the stack
		const currentNames = new Set(this._config.getStack().map((e) => e.name))
		for (const [name, entry] of this._entries) {
			if (!currentNames.has(name)) {
				entry.dispose()
				this._entries.delete(name)
			}
		}

		// Create entries for new branches
		for (const branchEntry of this._config.getStack()) {
			if (!this._entries.has(branchEntry.name)) {
				const wtDir = worktreePath(this._workspaceRoot, branchEntry.name).fsPath
				const scmEntry = new BranchScmEntry(branchEntry, wtDir, this._runner)
				this._entries.set(branchEntry.name, scmEntry)
			}
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
		this._refreshFloating()
	}

	private _refreshFloating(): void {
		const wsf = vscode.workspace.workspaceFolders?.[0]
		if (!wsf) { return }

		const floatingDirty = this._sync.getFloatingDirty()
		this._floatingGroup.resourceStates = floatingDirty.map((rel) => ({
			resourceUri: vscode.Uri.joinPath(wsf.uri, rel),
			command: {
				command: 'vscode.open',
				title: 'Open',
				arguments: [vscode.Uri.joinPath(wsf.uri, rel)],
			},
		}))
	}

	/**
	 * Commit all staged changes in the given branch's worktree.
	 * Shows a warning (not a block) if floating files exist.
	 */
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
			await entry.refresh()
		} else {
			await vscode.window.showErrorMessage(`Commit to "${branchName}" failed: ${stderr}`)
			log.error(`[BranchScmProvider] commit error (exit=${String(exitCode)}): ${stderr}`)
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
