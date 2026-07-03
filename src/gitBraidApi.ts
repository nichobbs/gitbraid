import * as vscode from 'vscode'
import { log } from './channelLogger'
import { ConfigService } from './configService'
import { BranchStackService, worktreePath } from './branchStackService'
import { WorkspaceSync } from './workspaceSync'
import { BranchStackEntry, BranchStatus, StackStatus, AssignmentChangeEvent, StackChangeEvent } from './configTypes'
import { GitError } from './errors'
import { IGitRunner, getDefaultGitRunner } from './gitRunner'
import type { GitBraidExportedAPI, BranchOptions, CommitOptions } from './@types/GitBraidAPI'
import { hideAssignedFile, unhideAssignedFile } from './gitIndex'
import { HunkRouter } from './hunkRouter'
import { DiffEngine } from './diffEngine'

// ─── Git status helper ────────────────────────────────────────────────────────

interface WorktreeFileStatus {
	xy: string
}

async function _gitStatus(runner: IGitRunner, worktreeDir: string): Promise<WorktreeFileStatus[]> {
	let result: { stdout: string; exitCode: number }
	try {
		result = await runner.run(
			['status', '--porcelain=v1', '-z'],
			{ cwd: worktreeDir },
		)
	} catch {
		// Worktree directory may not exist yet — treat as empty
		return []
	}
	if (result.exitCode !== 0) {
		return []
	}
	const results: WorktreeFileStatus[] = []
	const entries = result.stdout.split('\0').filter((s) => s.length > 0)
	for (const entry of entries) {
		const xy = entry.slice(0, 2)
		if (entry.length > 3) {
			results.push({ xy })
		}
	}
	return results
}

// ─── GitBraidApi ───────────────────────────────────────────────────────────────────

/**
 * Implements the full exported `GitBraidExportedAPI`.
 *
 * This object is returned by `activate()` and can be obtained by other
 * extensions via `vscode.extensions.getExtension(...).exports`.
 */
export class GitBraidApi implements GitBraidExportedAPI {

	private readonly _hunkRouter: HunkRouter

	constructor(
		private readonly _config: ConfigService,
		private readonly _branchStack: BranchStackService,
		private readonly _sync: WorkspaceSync,
		private readonly _workspaceRoot: vscode.Uri,
		private readonly _runner: IGitRunner = getDefaultGitRunner(),
		hunkRouter?: HunkRouter,
	) {
		this._hunkRouter = hunkRouter ?? new HunkRouter(new DiffEngine())
	}

	// ── Stack management ──────────────────────────────────────────────────────

	getStack(): BranchStackEntry[] {
		return this._config.getStack()
	}

	async addBranch(name: string, base: string, options?: BranchOptions): Promise<void> {
		await this._branchStack.addBranchToStack(name, base, options?.color, { virtual: options?.virtual === true })
	}

	async materialiseBranch(name: string): Promise<void> {
		await this._branchStack.materialiseBranch(name)
	}

	getVirtualBranches(): string[] {
		return this._config.getVirtualBranches()
	}

	async removeBranch(name: string, force = false): Promise<void> {
		// Collect files assigned to this branch before removing it from the stack
		// so we can undo skip-worktree / exclude entries after removal.
		const allAssignments = this._config.getAllAssignments()
		const assignedFiles = Object.entries(allAssignments)
			.filter(([, b]) => b === name)
			.map(([rel]) => rel)

		await this._branchStack.removeBranchFromStack(name, force)

		for (const rel of assignedFiles) {
			await unhideAssignedFile(this._runner, this._workspaceRoot.fsPath, rel)
		}
	}

	// ── File assignment ───────────────────────────────────────────────────────

	getAssignment(relativePath: string): string | undefined {
		return this._config.getAssignment(relativePath)
	}

	async assignFile(relativePath: string, branch: string): Promise<void> {
		await this._config.setAssignment(relativePath, branch)
		// Only hide from main git status when the branch has a real worktree.
		// If there is no worktree (i.e. the file is being assigned to the currently
		// checked-out branch), the file belongs in the primary workspace and should
		// remain visible in `git status` as normal.
		if (this._branchStack.worktreeExists(branch)) {
			await hideAssignedFile(this._runner, this._workspaceRoot.fsPath, relativePath)
		}
	}

	async assignHunk(relativePath: string, hunkIndex: number, branch: string): Promise<void> {
		await this._config.setHunkAssignment(relativePath, hunkIndex, branch)
	}

	async unassignFile(relativePath: string): Promise<void> {
		await this._config.removeAssignment(relativePath)
		await unhideAssignedFile(this._runner, this._workspaceRoot.fsPath, relativePath)
	}

	getFloatingFiles(): string[] {
		return [...this._sync.getFloatingDirty()]
	}

	// ── Status queries ────────────────────────────────────────────────────────

	async getBranchStatus(branch: string): Promise<BranchStatus> {
		const wtDir = worktreePath(this._workspaceRoot, branch).fsPath
		const statuses = await _gitStatus(this._runner, wtDir)

		let staged = 0
		let unstaged = 0
		let untracked = 0

		for (const { xy } of statuses) {
			const indexStatus = xy[0] ?? ' '
			const workStatus = xy[1] ?? ' '
			if (xy === '??') {
				untracked += 1
			} else {
				if (indexStatus !== ' ') {
					staged += 1
				}
				if (workStatus !== ' ') {
					unstaged += 1
				}
			}
		}

		const floating = this._sync.getFloatingDirty().length
		return { branch, staged, unstaged, untracked, floating }
	}

	async getStackStatus(): Promise<StackStatus> {
		const stack = this._config.getStack()
		const branchStatuses = await Promise.all(stack.map((e) => this.getBranchStatus(e.name)))
		return {
			branches: branchStatuses,
			totalFloating: this._sync.getFloatingDirty().length,
		}
	}

	// ── Actions ───────────────────────────────────────────────────────────────

	async commitBranch(branch: string, message: string, options: CommitOptions = {}): Promise<void> {
		const wtDir = worktreePath(this._workspaceRoot, branch).fsPath

		if (options.stageAll) {
			const addResult = await this._runner.run(['add', '-u'], { cwd: wtDir })
			if (addResult.exitCode !== 0) {
				throw new GitError(`git add -u failed in "${branch}": ${addResult.stderr}`, addResult.exitCode)
			}
		}

		const commitArgs: string[] = ['commit']
		if (options.noGpgSign === true) {
			commitArgs.push('--no-gpg-sign')
		}
		commitArgs.push('-m', message)
		const { exitCode, stderr } = await this._runner.run(commitArgs, { cwd: wtDir })
		if (exitCode !== 0) {
			log.error(`GitBraidApi.commitBranch: failed for "${branch}": ${stderr}`)
			throw new GitError(`Commit to "${branch}" failed: ${stderr}`, exitCode)
		}
		log.info(`GitBraidApi.commitBranch: committed to "${branch}"`)
	}

	async stageBranch(branch: string, files?: string[]): Promise<void> {
		const wtDir = worktreePath(this._workspaceRoot, branch).fsPath

		if (files && files.length > 0) {
			// With spawn the shell never sees these arguments, so the
			// metacharacter check is no longer strictly required — but we keep
			// a leading-dash guard so a malicious path can't be mistaken for
			// a git option.
			for (const f of files) {
				if (f.startsWith('-')) {
					throw new GitError(`Refusing to stage path that would be parsed as a flag: ${f}`, 1)
				}
			}
			const { exitCode, stderr } = await this._runner.run(
				['add', '--', ...files],
				{ cwd: wtDir },
			)
			if (exitCode !== 0) {
				throw new GitError(`git add failed in "${branch}": ${stderr}`, exitCode)
			}
		} else {
			const { exitCode, stderr } = await this._runner.run(['add', '-u'], { cwd: wtDir })
			if (exitCode !== 0) {
				throw new GitError(`git add -u failed in "${branch}": ${stderr}`, exitCode)
			}
		}
		log.info(`GitBraidApi.stageBranch: staged in "${branch}"`)
	}

	async pullBranch(branch: string): Promise<void> {
		const wtDir = worktreePath(this._workspaceRoot, branch).fsPath
		const { exitCode, stderr } = await this._runner.run(['pull', '--rebase'], { cwd: wtDir })
		if (exitCode !== 0) {
			throw new GitError(`Pull "${branch}" failed: ${stderr}`, exitCode)
		}
		log.info(`GitBraidApi.pullBranch: pulled "${branch}"`)
	}

	async syncBranch(branch: string): Promise<void> {
		await this.pullBranch(branch)
		const wtDir = worktreePath(this._workspaceRoot, branch).fsPath
		const pushResult = await this._runner.run(['push'], { cwd: wtDir })
		if (pushResult.exitCode !== 0) {
			if (pushResult.stderr.includes('no upstream') || pushResult.stderr.includes('has no upstream')) {
				const upResult = await this._runner.run(
					['push', '--set-upstream', 'origin', branch],
					{ cwd: wtDir },
				)
				if (upResult.exitCode !== 0) {
					throw new GitError(`Push "${branch}" failed: ${upResult.stderr}`, upResult.exitCode)
				}
			} else {
				throw new GitError(`Push "${branch}" failed: ${pushResult.stderr}`, pushResult.exitCode)
			}
		}
		log.info(`GitBraidApi.syncBranch: synced "${branch}"`)
	}

	// ── API parity with internal services ─────────────────────────────────────

	/** Reorder branches in the stack by providing the desired name sequence. */
	async reorderStack(orderedNames: string[]): Promise<void> {
		await this._branchStack.reorderStack(orderedNames)
	}

	/** Retrieve the hunk assignments for a file (hunkIndex → branchName). */
	getHunkAssignments(relativePath: string): Map<number, string> | undefined {
		return this._config.getHunkAssignments(relativePath)
	}

	/** Remove a single hunk assignment. */
	async removeHunkAssignment(relativePath: string, hunkIndex: number): Promise<void> {
		await this._config.removeHunkAssignment(relativePath, hunkIndex)
	}

	async rebaseBranch(branch: string): Promise<void> {
		const entry = this._config.getBranch(branch)
		if (!entry) throw new Error(`Branch "${branch}" is not in the stack`)
		const wtDir = worktreePath(this._workspaceRoot, branch).fsPath
		const { exitCode, stderr } = await this._runner.run(['rebase', '--autostash', entry.base], { cwd: wtDir })
		if (exitCode !== 0) {
			throw new GitError(`Rebase "${branch}" onto "${entry.base}" failed: ${stderr}`, exitCode)
		}
		log.info(`GitBraidApi.rebaseBranch: rebased "${branch}" onto "${entry.base}"`)
	}

	async routeHunks(relativePath: string): Promise<{ routed: number, skipped: number }> {
		const assignments = this._config.getHunkAssignments(relativePath)
		if (!assignments || assignments.size === 0) {
			return { routed: 0, skipped: 0 }
		}
		const worktreeDirs = new Map<string, string>()
		for (const entry of this._config.getStack()) {
			worktreeDirs.set(entry.name, worktreePath(this._workspaceRoot, entry.name).fsPath)
		}
		const anchors = new Map<number, import('./configTypes').HunkAnchor>()
		for (const idx of assignments.keys()) {
			const a = this._config.getHunkAnchor(relativePath, idx)
			if (a) anchors.set(idx, a)
		}
		const result = await this._hunkRouter.routeFile(
			this._workspaceRoot.fsPath,
			relativePath,
			worktreeDirs,
			assignments,
			anchors,
		)
		const total = assignments.size
		if (result.ok) {
			await this._config.clearHunkAssignments(relativePath)
			log.info(`GitBraidApi.routeHunks: routed ${String(total)} hunk(s) for "${relativePath}"`)
			return { routed: total, skipped: 0 }
		}
		// Only clear the hunks that actually applied — leaving the failed ones
		// assigned prevents a retry from re-applying an already-applied
		// branch's patch (which would then fail too).
		for (const idx of result.appliedIndices) {
			await this._config.removeHunkAssignment(relativePath, idx)
		}
		log.warn(
			`GitBraidApi.routeHunks: partial failure for "${relativePath}" ` +
			`(${String(result.appliedIndices.length)} routed, ${String(result.failedIndices.length)} failed)`,
		)
		return { routed: result.appliedIndices.length, skipped: result.failedIndices.length }
	}

	// ── Events ────────────────────────────────────────────────────────────────

	get onDidChangeAssignment(): vscode.Event<AssignmentChangeEvent> {
		return this._config.onDidChangeAssignment
	}

	get onDidChangeStack(): vscode.Event<StackChangeEvent> {
		return this._config.onDidChangeStack
	}

	get onDidSyncFile(): vscode.Event<{ relativePath: string, branch: string }> {
		return this._sync.onDidSyncFile
	}

	get onDidFloatFile(): vscode.Event<{ relativePath: string }> {
		return this._sync.onDidFloatFile
	}
}
