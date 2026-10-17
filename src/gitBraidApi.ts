import { autoRouteMode, withInheritedTrivial } from './hunkKinds'
import * as vscode from 'vscode'
import { log } from './channelLogger'
import { ConfigService } from './configService'
import { BranchStackService, worktreePath } from './branchStackService'
import { WorkspaceSync } from './workspaceSync'
import { BranchStackEntry, BranchStatus, StackStatus, AssignmentChangeEvent, StackChangeEvent } from './configTypes'
import { GitError } from './errors'
import { IGitRunner, getDefaultGitRunner } from './gitRunner'
import type {
	GitBraidExportedAPI,
	BranchOptions,
	CommitOptions,
	FileOwnership,
	FileHunkInfo,
	FileHunkOptions,
	BranchDiff,
	BranchDiffOptions,
} from './@types/GitBraidAPI'
import { hideAssignedFile, unhideAssignedFile } from './gitIndex'
import { HunkRouter, anchorFor } from './hunkRouter'
import { DiffEngine } from './diffEngine'
import type { PersistentUndoLog, UndoLogEntry } from './persistentUndoLog'
import {
	requireBranch,
	requireHunkInRange,
	requireNotScratch,
	requirePermutation,
	requireWorkspacePath,
	requireWorktree,
} from './stackInvariants'

/** Default cap on `getBranchDiff` output, in bytes. */
const DEFAULT_BRANCH_DIFF_BYTES = 200_000

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
		private readonly _undoLog?: PersistentUndoLog,
	) {
		this._hunkRouter = hunkRouter ?? new HunkRouter(new DiffEngine())
	}

	// ── Invariant helpers (plan 12) ───────────────────────────────────────────
	// Structural rules are enforced here, once, so every caller (chat tools, the
	// MCP server, other extensions) gets the same protection and the same errors.

	private _branch(name: string): BranchStackEntry {
		return requireBranch(this._config.getStack(), name)
	}

	private _path(relativePath: string): string {
		return requireWorkspacePath(this._workspaceRoot.fsPath, relativePath)
	}

	/** A branch whose worktree git commands will run in. */
	private _worktreeBranch(name: string, action: string): BranchStackEntry {
		const entry = this._branch(name)
		requireWorktree(entry, action)
		return entry
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
		this._branch(name)
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

	getFileOwnership(relativePath: string): FileOwnership {
		const rel = this._path(relativePath)
		const hunks: Record<string, string> = {}
		for (const [idx, branch] of this._config.getHunkAssignments(rel) ?? []) hunks[String(idx)] = branch
		return {
			path: rel,
			...(this._config.getAssignment(rel) ? { branch: this._config.getAssignment(rel) } : {}),
			hunkAssignments: hunks,
			floating: this._sync.getFloatingDirty().includes(rel),
		}
	}

	async getFileHunks(relativePath: string, options: FileHunkOptions = {}): Promise<FileHunkInfo[]> {
		const rel = this._path(relativePath)
		const hunks = await this._hunkRouter.diffEngine.getHunksForFile(this._workspaceRoot.fsPath, rel)
		const assigned = this._config.getHunkAssignments(rel)
		return hunks.map((h) => ({
			index: h.index,
			startLine: h.startLine,
			endLine: h.endLine,
			header: h.header,
			...(assigned?.get(h.index) ? { assignedBranch: assigned.get(h.index) } : {}),
			...(options.includePatch === true ? { patch: h.patch } : {}),
		}))
	}

	async assignFile(relativePath: string, branch: string): Promise<void> {
		relativePath = this._path(relativePath)
		this._branch(branch)
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
		relativePath = this._path(relativePath)
		this._branch(branch)
		const hunks = await this._hunkRouter.diffEngine.getHunksForFile(this._workspaceRoot.fsPath, relativePath)
		requireHunkInRange(relativePath, hunkIndex, hunks.length)
		// Anchor the assignment to the hunk's content, as the editor does, so it
		// survives later edits that renumber the hunks.
		await this._config.setHunkAssignment(relativePath, hunkIndex, branch, anchorFor(hunks[hunkIndex]))
	}

	async unassignFile(relativePath: string): Promise<void> {
		relativePath = this._path(relativePath)
		await this._config.removeAssignment(relativePath)
		await unhideAssignedFile(this._runner, this._workspaceRoot.fsPath, relativePath)
	}

	getFloatingFiles(): string[] {
		return [...this._sync.getFloatingDirty()]
	}

	// ── Status queries ────────────────────────────────────────────────────────

	async getBranchStatus(branch: string): Promise<BranchStatus> {
		this._branch(branch)
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
		requireNotScratch(this._worktreeBranch(branch, 'be committed'), 'be committed')
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
		this._worktreeBranch(branch, 'stage changes')
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
		requireNotScratch(this._worktreeBranch(branch, 'be pulled'), 'be pulled')
		const wtDir = worktreePath(this._workspaceRoot, branch).fsPath
		const { exitCode, stderr } = await this._runner.run(['pull', '--rebase'], { cwd: wtDir })
		if (exitCode !== 0) {
			throw new GitError(`Pull "${branch}" failed: ${stderr}`, exitCode)
		}
		log.info(`GitBraidApi.pullBranch: pulled "${branch}"`)
	}

	async syncBranch(branch: string): Promise<void> {
		requireNotScratch(this._worktreeBranch(branch, 'be synced'), 'be synced')
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
		requirePermutation(this._config.getStack(), orderedNames)
		await this._branchStack.reorderStack(orderedNames)
	}

	/** Retrieve the hunk assignments for a file (hunkIndex → branchName). */
	getHunkAssignments(relativePath: string): Map<number, string> | undefined {
		return this._config.getHunkAssignments(relativePath)
	}

	/** Remove a single hunk assignment. */
	async removeHunkAssignment(relativePath: string, hunkIndex: number): Promise<void> {
		await this._config.removeHunkAssignment(this._path(relativePath), hunkIndex)
	}

	async rebaseBranch(branch: string): Promise<void> {
		const entry = this._worktreeBranch(branch, 'be rebased')
		const wtDir = worktreePath(this._workspaceRoot, branch).fsPath
		const { exitCode, stderr } = await this._runner.run(['rebase', '--autostash', entry.base], { cwd: wtDir })
		if (exitCode !== 0) {
			throw new GitError(`Rebase "${branch}" onto "${entry.base}" failed: ${stderr}`, exitCode)
		}
		log.info(`GitBraidApi.rebaseBranch: rebased "${branch}" onto "${entry.base}"`)
	}

	async routeHunks(relativePath: string): Promise<{ routed: number, skipped: number }> {
		relativePath = this._path(relativePath)
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
		const mode = autoRouteMode(vscode.workspace.getConfiguration('gitbraid').get('autoRouteTrivialHunks'))
		const effective = await withInheritedTrivial(this._hunkRouter.diffEngine, this._workspaceRoot.fsPath, relativePath, assignments, mode)
		const result = await this._hunkRouter.routeFile(
			this._workspaceRoot.fsPath,
			relativePath,
			worktreeDirs,
			new Map(effective),
			anchors,
		)
		const total = effective.size
		if (result.ok) {
			await this._config.clearHunkAssignments(relativePath)
			log.info(`GitBraidApi.routeHunks: routed ${String(total)} hunk(s) for "${relativePath}"`)
			return { routed: total, skipped: 0 }
		}
		// Only clear the hunks that actually applied — leaving the failed ones
		// assigned prevents a retry from re-applying an already-applied
		// branch's patch (which would then fail too).
		for (const idx of result.appliedIndices) {
			if (!assignments.has(idx)) continue   // inherited for this run only; never persisted
			await this._config.removeHunkAssignment(relativePath, idx)
		}
		log.warn(
			`GitBraidApi.routeHunks: partial failure for "${relativePath}" ` +
			`(${String(result.appliedIndices.length)} routed, ${String(result.failedIndices.length)} failed)`,
		)
		return { routed: result.appliedIndices.length, skipped: result.failedIndices.length }
	}

	async getBranchDiff(branch: string, options: BranchDiffOptions = {}): Promise<BranchDiff> {
		const entry = this._worktreeBranch(branch, 'be diffed')
		const wtDir = worktreePath(this._workspaceRoot, branch).fsPath
		// Diff against the fork point, not the tip of the base, so commits that landed
		// on the base since this branch was created do not show up as its changes.
		const mergeBase = await this._runner.run(['merge-base', entry.base, 'HEAD'], { cwd: wtDir })
		const baseRef = mergeBase.exitCode === 0 && mergeBase.stdout.trim() ? mergeBase.stdout.trim() : entry.base
		const args = ['diff', '--no-color', ...(options.stat === true ? ['--stat'] : []), baseRef]
		const { stdout, stderr, exitCode } = await this._runner.run(args, { cwd: wtDir })
		if (exitCode !== 0) {
			throw new GitError(`Diff of "${branch}" against "${entry.base}" failed: ${stderr}`, exitCode)
		}
		const limit = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_BRANCH_DIFF_BYTES))
		if (Buffer.byteLength(stdout) <= limit) {
			return { branch, base: entry.base, diff: stdout, truncated: false }
		}
		// Cut on a line boundary so the output never ends mid-line or mid-character.
		const cut = Buffer.from(stdout).subarray(0, limit).toString('utf-8')
		return { branch, base: entry.base, diff: cut.slice(0, cut.lastIndexOf('\n') + 1), truncated: true }
	}

	async getUndoLog(limit = 20): Promise<UndoLogEntry[]> {
		if (!this._undoLog) return []
		const n = Math.min(200, Math.max(1, Math.floor(limit)))
		return (await this._undoLog.load()).slice(-n).reverse()
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
