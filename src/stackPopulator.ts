import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { log } from './channelLogger'
import { ConfigService } from './configService'
import { worktreePath } from './branchStackService'
import { getDefaultGitRunner, IGitRunner } from './gitRunner'

/**
 * Populates the primary workspace with committed files from each branch in the
 * stack.
 *
 * When a branch is added to the stack its files (those that differ from its
 * base, i.e. `git diff --name-only <base>..HEAD`) are copied into the primary
 * workspace and auto-assigned to that branch.  "Latest layer wins": if two
 * branches both introduce the same file, the branch with the higher `order`
 * in the stack owns it in the workspace.
 *
 * `seedFromStack()` is called once at activation to handle branches that were
 * already in the stack before this session — their committed files appear in
 * the workspace without the user having to edit them first.
 */
export class StackPopulator implements vscode.Disposable {

	private _workspaceRoot: vscode.Uri | undefined
	private readonly _disposables: vscode.Disposable[] = []
	private readonly _runner: IGitRunner

	constructor(
		private readonly _config: ConfigService,
		runner?: IGitRunner,
	) {
		this._runner = runner ?? getDefaultGitRunner()
	}

	init(workspaceRoot: vscode.Uri): void {
		this._workspaceRoot = workspaceRoot
		this._disposables.push(
			this._config.onDidChangeStack(async (ev) => {
				if (ev.type === 'add') {
					await this._onBranchAdded(ev.branch)
				}
			}),
		)
	}

	/**
	 * Copy committed files from all branches currently in the stack into the
	 * primary workspace.  Processes branches in ascending `order` so the
	 * highest-order branch wins when two branches introduce the same file.
	 *
	 * Skips files that already have an assignment — those are already managed
	 * from a previous session.
	 */
	async seedFromStack(): Promise<void> {
		if (!this._workspaceRoot) return
		const stack = this._config.getStack()
		if (stack.length === 0) return

		// Descending order: highest-layer branch is processed first.
		// When a lower-layer branch sees a file already claimed by a higher one
		// the `onlyNew` guard skips it, so the highest-layer branch always wins.
		const sorted = [...stack].sort((a, b) => b.order - a.order)
		let total = 0
		for (const entry of sorted) {
			total += await this._populateBranch(entry.name, entry.base, true)
		}
		if (total > 0) {
			log.info(`StackPopulator.seedFromStack: seeded ${total} file(s) from stack`)
		}
	}

	private async _onBranchAdded(branchName: string): Promise<void> {
		const entry = this._config.getStack().find((e) => e.name === branchName)
		if (!entry) return
		await this._populateBranch(branchName, entry.base, false)
	}

	/**
	 * Enumerate committed files introduced by `branchName` relative to `base`,
	 * copy them into the primary workspace, and assign them to the branch.
	 *
	 * @param onlyNew - When `true` (seeding), files that already have an
	 *   assignment are skipped so existing tracked state is not disturbed.
	 *   When `false` (fresh add), overlapping files are reassigned if this
	 *   branch sits higher in the stack.
	 * @returns Number of files copied.
	 */
	private async _populateBranch(
		branchName: string,
		base: string,
		onlyNew: boolean,
	): Promise<number> {
		if (!this._workspaceRoot) return 0
		if (!fs.existsSync(worktreePath(this._workspaceRoot, branchName).fsPath)) return 0

		const files = await this._getBranchFiles(branchName, base)
		if (files.length === 0) return 0

		const stack = this._config.getStack()
		const branchOrder = stack.find((e) => e.name === branchName)?.order ?? 0
		const conflicts: Array<{ file: string; existingBranch: string }> = []
		let copied = 0

		for (const relPath of files) {
			const existingBranch = this._config.getAssignment(relPath)

			if (existingBranch) {
				if (existingBranch === branchName) continue

				// Don't disturb existing assignments when seeding from saved state.
				if (onlyNew) continue

				const existingOrder = stack.find((e) => e.name === existingBranch)?.order ?? 0
				if (branchOrder > existingOrder) {
					// This branch is higher — take over ownership.
					conflicts.push({ file: relPath, existingBranch })
					await this._config.setAssignment(relPath, branchName)
					await this._copyToWorkspace(relPath, branchName)
					copied++
				} else {
					// A higher layer already owns it — note the overlap but leave it.
					conflicts.push({ file: relPath, existingBranch })
				}
				continue
			}

			await this._config.setAssignment(relPath, branchName)
			await this._copyToWorkspace(relPath, branchName)
			copied++
		}

		if (conflicts.length > 0) {
			_warnConflicts(branchName, conflicts)
		}

		log.info(`StackPopulator: populated ${copied} file(s) from branch "${branchName}"`)
		return copied
	}

	/**
	 * Run `git diff --name-only --diff-filter=ACMR <base>..HEAD` in the
	 * branch's worktree to find files the branch introduces relative to its
	 * base.  Deleted files are excluded — we only want files that exist in
	 * the branch and should be visible in the workspace.
	 */
	async getBranchFiles(branchName: string, base: string): Promise<string[]> {
		return this._getBranchFiles(branchName, base)
	}

	// exposed as getBranchFiles above for test access; kept private otherwise
	private async _getBranchFiles(branchName: string, base: string): Promise<string[]> {
		if (!this._workspaceRoot) return []
		const wtPath = worktreePath(this._workspaceRoot, branchName)
		try {
			const { stdout, exitCode } = await this._runner.run(
				['diff', '--name-only', '--diff-filter=ACMR', `${base}..HEAD`],
				{ cwd: wtPath.fsPath },
			)
			if (exitCode !== 0) return []
			return stdout.split('\n').map((s) => s.trim()).filter(Boolean)
		} catch {
			return []
		}
	}

	/** Copy a file from the branch's worktree into the primary workspace. */
	private async _copyToWorkspace(relPath: string, branchName: string): Promise<void> {
		if (!this._workspaceRoot) return
		const srcUri = vscode.Uri.joinPath(worktreePath(this._workspaceRoot, branchName), relPath)
		const destUri = vscode.Uri.joinPath(this._workspaceRoot, relPath)

		let content: Uint8Array
		try {
			content = await vscode.workspace.fs.readFile(srcUri)
		} catch {
			return
		}

		try {
			await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(destUri.fsPath)))
		} catch { /* already exists */ }

		try {
			await vscode.workspace.fs.writeFile(destUri, content)
			log.info(`StackPopulator: ${relPath} ← ${branchName}`)
		} catch (e) {
			log.warn(`StackPopulator: failed to copy ${relPath}: ${e instanceof Error ? e.message : String(e)}`)
		}
	}

	dispose(): void {
		for (const d of this._disposables) {
			d.dispose()
		}
	}
}

function _warnConflicts(
	branchName: string,
	conflicts: Array<{ file: string; existingBranch: string }>,
): void {
	const shown = conflicts.slice(0, 5).map((c) => `• ${c.file} (also in ${c.existingBranch})`).join('\n')
	const tail = conflicts.length > 5 ? `\n…and ${conflicts.length - 5} more` : ''
	void vscode.window.showWarningMessage(
		`GitBraid: ${conflicts.length} file(s) overlap between "${branchName}" and other branches. ` +
		`The highest-layer branch owns each file in the workspace.\n${shown}${tail}`,
	)
}
