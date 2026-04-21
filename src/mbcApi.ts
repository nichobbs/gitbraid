import * as vscode from 'vscode'
import * as node_util from 'node:util'
import * as node_child_process from 'node:child_process'
import { log } from './channelLogger'
import { ConfigService } from './configService'
import { BranchStackService, worktreePath } from './branchStackService'
import { WorkspaceSync } from './workspaceSync'
import { BranchStackEntry, BranchStatus, StackStatus, AssignmentChangeEvent, StackChangeEvent } from './configTypes'
import { GitError } from './errors'
import type { GitBraidExportedAPI, BranchOptions, CommitOptions } from './@types/GitBraidAPI'

const execAsync = node_util.promisify(node_child_process.exec)

// ─── Git status helper ────────────────────────────────────────────────────────

interface WorktreeFileStatus {
	xy: string
}

async function _gitStatus(worktreeDir: string): Promise<WorktreeFileStatus[]> {
	try {
		const { stdout } = await execAsync('git status --porcelain=v1 -z', { cwd: worktreeDir })
		const results: WorktreeFileStatus[] = []
		const entries = stdout.split('\0').filter((s) => s.length > 0)
		for (const entry of entries) {
			const xy = entry.slice(0, 2)
			if (entry.length > 3) {
				results.push({ xy })
			}
		}
		return results
	} catch {
		return []
	}
}

// ─── MbcApi ───────────────────────────────────────────────────────────────────

/**
 * Implements the full exported `GitBraidExportedAPI`.
 *
 * This object is returned by `activate()` and can be obtained by other
 * extensions via `vscode.extensions.getExtension(...).exports`.
 */
export class MbcApi implements GitBraidExportedAPI {

	constructor(
		private readonly _config: ConfigService,
		private readonly _branchStack: BranchStackService,
		private readonly _sync: WorkspaceSync,
		private readonly _workspaceRoot: vscode.Uri,
	) {}

	// ── Stack management ──────────────────────────────────────────────────────

	getStack(): BranchStackEntry[] {
		return this._config.getStack()
	}

	async addBranch(name: string, base: string, options?: BranchOptions): Promise<void> {
		await this._branchStack.addBranchToStack(name, base, options?.color)
	}

	async removeBranch(name: string, force = false): Promise<void> {
		await this._branchStack.removeBranchFromStack(name, force)
	}

	// ── File assignment ───────────────────────────────────────────────────────

	getAssignment(relativePath: string): string | undefined {
		return this._config.getAssignment(relativePath)
	}

	async assignFile(relativePath: string, branch: string): Promise<void> {
		await this._config.setAssignment(relativePath, branch)
	}

	async assignHunk(relativePath: string, hunkIndex: number, branch: string): Promise<void> {
		await this._config.setHunkAssignment(relativePath, hunkIndex, branch)
	}

	async unassignFile(relativePath: string): Promise<void> {
		await this._config.removeAssignment(relativePath)
	}

	getFloatingFiles(): string[] {
		return [...this._sync.getFloatingDirty()]
	}

	// ── Status queries ────────────────────────────────────────────────────────

	async getBranchStatus(branch: string): Promise<BranchStatus> {
		const wtDir = worktreePath(this._workspaceRoot, branch).fsPath
		const statuses = await _gitStatus(wtDir)

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
			await execAsync('git add -u', { cwd: wtDir })
		}

		const gpgFlag = options.noGpgSign === true ? ' --no-gpg-sign' : ''
		// Route the commit message through a shell via JSON.stringify so
		// backticks, $(…), newlines etc. cannot break out. The previous
		// replaceAll('"', '\\"') only handled literal double quotes.
		// The full fix (spawn-with-argv) lands with remediation plan T18.
		const quoted = JSON.stringify(message)
		try {
			await execAsync(`git commit${gpgFlag} -m ${quoted}`, { cwd: wtDir })
			log.info(`MbcApi.commitBranch: committed to "${branch}"`)
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : JSON.stringify(e)
			log.error(`MbcApi.commitBranch: failed for "${branch}": ${msg}`)
			throw new GitError(`Commit to "${branch}" failed: ${msg}`, typeof (e as { code?: number })?.code === 'number' ? (e as { code: number }).code : 1)
		}
	}

	async stageBranch(branch: string, files?: string[]): Promise<void> {
		const wtDir = worktreePath(this._workspaceRoot, branch).fsPath

		if (files && files.length > 0) {
			for (const f of files) {
				if (/["`$\\\n|;&<>()]/.test(f) || f.startsWith('-')) {
					throw new GitError(`Refusing to stage path with unsafe characters: ${f}`, 1)
				}
			}
			const paths = files.map((f) => JSON.stringify(f)).join(' ')
			await execAsync(`git add -- ${paths}`, { cwd: wtDir })
		} else {
			await execAsync('git add -u', { cwd: wtDir })
		}
		log.info(`MbcApi.stageBranch: staged in "${branch}"`)
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
