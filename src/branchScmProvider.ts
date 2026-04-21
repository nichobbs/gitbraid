import * as vscode from 'vscode'
import util from 'node:util'
import child_process from 'node:child_process'
import { log } from './channelLogger'
import { ConfigService } from './configService'
import { WorkspaceSync } from './workspaceSync'
import { worktreePath } from './branchStackService'
import { BranchStackEntry } from './configTypes'

const exec = util.promisify(child_process.exec)

// ─── Git status parsing ───────────────────────────────────────────────────────

interface WorktreeFileStatus {
	/** XY status code from `git status --porcelain=v1` */
	xy: string
	relativePath: string
}

async function gitStatusInDir(dir: string): Promise<WorktreeFileStatus[]> {
	try {
		const { stdout } = await exec('git status --porcelain=v1 -z', { cwd: dir })
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
	} catch {
		// Worktree may not exist yet or git is unavailable — treat as empty
		return []
	}
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
	) {
		this._sc = vscode.scm.createSourceControl(
			`mbc-${_entry.name}`,
			`MBC: ${_entry.name}`,
			vscode.Uri.file(_worktreeDir),
		)
		this._sc.inputBox.placeholder = `Commit to ${_entry.name} (message)`
		this._sc.acceptInputCommand = {
			command: 'multi-branch-checkout.scm.commitBranch',
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

	async refresh(): Promise<void> {
		const statuses = await gitStatusInDir(this._worktreeDir)
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
	) {
		// Top-level "Floating" source control — unassigned dirty files
		this._floatingSc = vscode.scm.createSourceControl(
			'mbc-floating',
			'MBC: Floating (unassigned)',
			_workspaceRoot,
		)
		this._floatingSc.inputBox.visible = false
		this._floatingGroup = this._floatingSc.createResourceGroup('floating', 'Unassigned (floating)')
		this._floatingGroup.hideWhenEmpty = true

		this._disposables.push(
			this._floatingSc,
			this._floatingGroup,
			_config.onDidChangeStack(() => void this._rebuild()),
			_sync.onDidSyncFile(() => void this._refreshAll()),
			_sync.onDidFloatFile(() => this._refreshFloating()),
		)
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
				const scmEntry = new BranchScmEntry(branchEntry, wtDir)
				this._entries.set(branchEntry.name, scmEntry)
			}
		}

		await this._refreshAll()
	}

	private async _refreshAll(): Promise<void> {
		await Promise.all([...this._entries.values()].map((e) => e.refresh()))
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

		// Warn about floating files (non-blocking)
		const floating = this._sync.getFloatingDirty()
		if (floating.length > 0) {
			const suffix = floating.length > 5 ? ` …and ${floating.length - 5} more` : ''
			const fileList = floating.slice(0, 5).join(', ') + suffix
			const proceed = await vscode.window.showWarningMessage(
				`${floating.length} file(s) are floating (unassigned) and will NOT be committed:\n${fileList}`,
				{ modal: true },
				'Commit anyway',
			)
			if (proceed !== 'Commit anyway') { return }
		}

		try {
			await exec(`git commit -m ${JSON.stringify(message)}`, { cwd: entry.worktreeDir })
			entry.inputBox.value = ''
			log.info(`[BranchScmProvider] committed to "${branchName}"`)
			await entry.refresh()
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			await vscode.window.showErrorMessage(`Commit to "${branchName}" failed: ${msg}`)
			log.error(`[BranchScmProvider] commit error: ${msg}`)
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
