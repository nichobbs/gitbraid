import * as vscode from 'vscode'
import * as node_util from 'node:util'
import * as node_child_process from 'node:child_process'
import * as node_path from 'node:path'
import { log } from './channelLogger'
import { ConfigService } from './configService'
import { BranchStackService, worktreePath } from './branchStackService'

const execAsync = node_util.promisify(node_child_process.exec)

/**
 * Resolves file content through the cumulative branch stack.
 *
 * The workspace should always reflect the "if all branches were merged" state.
 * For a file assigned to layer N, the resolved content is:
 *
 *   1. The committed state of that file on the owning branch (`git show`)
 *   2. Plus any uncommitted (dirty) changes in that branch's worktree
 *
 * For a floating file (no assignment), the workspace file itself is the content.
 */
export class StackResolver implements vscode.Disposable {

	private readonly _disposables: vscode.Disposable[] = []

	constructor(
		private readonly _config: ConfigService,
		private readonly _branchStack: BranchStackService,
	) {}

	dispose(): void {
		for (const d of this._disposables) {
			d.dispose()
		}
	}

	// ─── Public API ───────────────────────────────────────────────────────────

	/**
	 * Returns the resolved content for a workspace-relative path by walking
	 * the branch stack from the bottom up.
	 *
	 * Returns `undefined` if the file doesn't exist in the stack or workspace.
	 */
	async getResolvedContent(
		workspaceRoot: vscode.Uri,
		relativePath: string,
	): Promise<Uint8Array | undefined> {
		const norm = relativePath.replaceAll('\\', '/')

		// Which branch owns this file?
		const branch = this._config.getAssignment(norm)
		if (!branch) {
			// Floating — serve the primary workspace copy
			const uri = vscode.Uri.joinPath(workspaceRoot, norm)
			try {
				return await vscode.workspace.fs.readFile(uri)
			} catch {
				return undefined
			}
		}

		// Prefer the live worktree copy (includes uncommitted edits)
		const wtDir = worktreePath(workspaceRoot, branch)
		const wtUri = vscode.Uri.joinPath(wtDir, norm)
		try {
			const content = await vscode.workspace.fs.readFile(wtUri)
			return content
		} catch {
			// Worktree doesn't have the file (perhaps not yet synced) — fall
			// through to git show
		}

		// Fall back to the committed state on that branch
		return this._showBranchFile(workspaceRoot.fsPath, branch, norm)
	}

	/**
	 * Returns the committed state of a file on a specific branch.
	 * Uses `git show <branch>:<relativePath>`.
	 * Returns `undefined` if the file doesn't exist on that branch.
	 */
	async getCommittedContent(
		workspaceRoot: string,
		branch: string,
		relativePath: string,
	): Promise<Uint8Array | undefined> {
		return this._showBranchFile(workspaceRoot, branch, relativePath)
	}

	/**
	 * Returns the cumulative stack diff for a file — every layer's changes
	 * combined — using `git diff <base>..<topBranch> -- <file>`.
	 *
	 * Useful for previewing what the final merged diff would look like.
	 */
	async getStackDiff(
		workspaceRoot: string,
		relativePath: string,
	): Promise<string | undefined> {
		const stack = this._config.getStack()
		if (stack.length === 0) {
			return undefined
		}
		const top = stack.at(-1)
		const bottom = stack[0]

		const safeFile = _sanitise(relativePath)
		const safeTop = _sanitise(top.name)
		const safeBase = _sanitise(bottom.base)

		try {
			const { stdout } = await execAsync(
				`git diff "${safeBase}"..."${safeTop}" -- "${safeFile}"`,
				{ cwd: workspaceRoot },
			)
			return stdout.trim() || undefined
		} catch {
			return undefined
		}
	}

	/**
	 * Lists all files that exist in the stack (across all branch worktrees),
	 * deduplicated.
	 */
	getStackFiles(): string[] {
		const assignments = this._config.getAllAssignments()
		return Object.keys(assignments)
	}

	// ─── Private helpers ──────────────────────────────────────────────────────

	private async _showBranchFile(
		wsRoot: string,
		branch: string,
		relativePath: string,
	): Promise<Uint8Array | undefined> {
		const safeBranch = _sanitise(branch)
		const safeFile = _sanitise(relativePath)
		try {
			const { stdout } = await execAsync(
				`git show "${safeBranch}:${safeFile}"`,
				{ cwd: wsRoot, encoding: 'buffer' },
			)
			return new Uint8Array(stdout)
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : JSON.stringify(e)
			if (!msg.includes('does not exist') && !msg.includes('Path') && !msg.includes('does not exist in')) {
				log.warn(`StackResolver: git show failed for ${branch}:${relativePath} — ${msg}`)
			}
			return undefined
		}
	}
}

/** Strip path traversal and escape double-quotes for shell use. */
function _sanitise(input: string): string {
	const stripped = input
		.split(node_path.sep).join('/')
		.replaceAll('../', '')
		.replaceAll('./', '')
	return stripped.replaceAll('"', String.raw`\"`)
}
