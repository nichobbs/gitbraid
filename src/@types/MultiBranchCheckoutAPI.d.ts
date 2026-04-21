// MultiBranchCheckoutAPI.d.ts
//
// The exported surface of the multi-branch-checkout extension.
// Other extensions and AI tools interact with the extension through this API.

import * as vscode from 'vscode'
import { BranchStackEntry, BranchStatus, StackStatus, AssignmentChangeEvent, StackChangeEvent } from '../configTypes'

// ─── Option types ─────────────────────────────────────────────────────────────

export interface BranchOptions {
	/** Hex colour for Explorer decorations, e.g. "#4CAF50" */
	color?: string
}

export interface CommitOptions {
	/** Pass --no-gpg-sign to skip GPG signing (useful in tests). */
	noGpgSign?: boolean
	/** Stage all modified tracked files before committing. */
	stageAll?: boolean
}

// ─── Full extension API ───────────────────────────────────────────────────────

export interface MultiBranchCheckoutExportedAPI {
	// ── Stack management ──────────────────────────────────────────────────────

	/** Returns the current stack entries sorted by order (base first). */
	getStack(): BranchStackEntry[]

	/**
	 * Adds a new branch to the stack. Creates the git branch and worktree.
	 * @param name  Git branch name, e.g. "feature/docs"
	 * @param base  Parent branch name, e.g. "main"
	 */
	addBranch(name: string, base: string, options?: BranchOptions): Promise<void>

	/**
	 * Removes a branch from the stack, pruning its worktree.
	 * @param force  Remove even if the worktree has uncommitted changes.
	 */
	removeBranch(name: string, force?: boolean): Promise<void>

	// ── File assignment ───────────────────────────────────────────────────────

	/**
	 * Returns the branch assigned to the given workspace-relative path,
	 * or `undefined` if the file is floating.
	 */
	getAssignment(relativePath: string): string | undefined

	/**
	 * Assigns a workspace-relative file path to a branch.
	 * The file will be synced to that branch's worktree on the next save.
	 */
	assignFile(relativePath: string, branch: string): Promise<void>

	/**
	 * Assigns a specific line range within a file to a branch.
	 * The hunk is identified by its 0-based index in the unified diff output.
	 */
	assignHunk(relativePath: string, hunkIndex: number, branch: string): Promise<void>

	/** Removes the branch assignment for the given file path. */
	unassignFile(relativePath: string): Promise<void>

	/**
	 * Returns the workspace-relative paths of all files that have been
	 * modified but have no branch assignment (floating files).
	 */
	getFloatingFiles(): string[]

	// ── Status queries ────────────────────────────────────────────────────────

	/**
	 * Returns the staged/unstaged/untracked/floating counts for a branch.
	 * The counts reflect the branch's worktree `git status`.
	 */
	getBranchStatus(branch: string): Promise<BranchStatus>

	/** Returns status for all branches plus the total floating file count. */
	getStackStatus(): Promise<StackStatus>

	// ── Actions ───────────────────────────────────────────────────────────────

	/**
	 * Stages and commits all tracked changes in the given branch's worktree.
	 * @param message  Commit message.
	 */
	commitBranch(branch: string, message: string, options?: CommitOptions): Promise<void>

	/**
	 * Stages files in a branch's worktree.
	 * If `files` is omitted, stages all modified tracked files.
	 */
	stageBranch(branch: string, files?: string[]): Promise<void>

	// ── Events ────────────────────────────────────────────────────────────────

	/** Fires whenever a file assignment is created, changed, or removed. */
	onDidChangeAssignment: vscode.Event<AssignmentChangeEvent>

	/** Fires whenever the branch stack is modified (add / remove / reorder). */
	onDidChangeStack: vscode.Event<StackChangeEvent>
}
