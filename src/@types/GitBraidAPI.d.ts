// GitBraidAPI.d.ts
//
// The exported surface of the gitbraid extension.
// Other extensions and AI tools interact with the extension through this API.

import * as vscode from 'vscode'
import { BranchStackEntry, BranchStatus, StackStatus, AssignmentChangeEvent, StackChangeEvent } from '../configTypes'
import type { UndoLogEntry } from '../persistentUndoLog'

// ─── Option types ─────────────────────────────────────────────────────────────

export interface BranchOptions {
	/** Hex colour for Explorer decorations, e.g. "#4CAF50" */
	color?: string
	/**
	 * When true the branch is created as a virtual branch — no git worktree
	 * is allocated until the branch is materialised.  See
	 * `docs/plans/08-virtual-branches.md` for the full design.
	 */
	virtual?: boolean
}

export interface CommitOptions {
	/** Pass --no-gpg-sign to skip GPG signing (useful in tests). */
	noGpgSign?: boolean
	/** Stage all modified tracked files before committing. */
	stageAll?: boolean
}

/** Who owns a file right now, and which of its hunks go elsewhere. */
export interface FileOwnership {
	/** The workspace-relative path, normalised. */
	path: string
	/** Branch the whole file is assigned to, or `undefined`. */
	branch?: string
	/** Hunk-level assignments for this file: hunk index (as a string) to branch. */
	hunkAssignments: Record<string, string>
	/** True if the file is modified but assigned to no branch. */
	floating: boolean
}

/** One hunk of a file's uncommitted changes. Indices are only valid until the file is next edited. */
export interface FileHunkInfo {
	index: number
	/** 1-based first line in the current file. */
	startLine: number
	/** 1-based last line (inclusive). */
	endLine: number
	/** The raw `@@ -a,b +c,d @@` header. */
	header: string
	/** Branch this hunk is assigned to, if any. */
	assignedBranch?: string
	/** The patch text; present only when requested. */
	patch?: string
}

export interface FileHunkOptions {
	/** Include each hunk's patch text. Off by default because it can be large. */
	includePatch?: boolean
}

export interface BranchDiffOptions {
	/** Return `git diff --stat` instead of the full diff. */
	stat?: boolean
	/** Truncate the output to this many bytes. Default 200000. */
	maxBytes?: number
}

/** What a branch changes relative to the point it forked from its base (tracked files only). */
export interface BranchDiff {
	branch: string
	base: string
	diff: string
	/** True if `diff` was cut at `maxBytes`. */
	truncated: boolean
}

// ─── Full extension API ───────────────────────────────────────────────────────

export interface GitBraidExportedAPI {
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

	/**
	 * Materialises a virtual branch: creates its git worktree, writes every
	 * file currently captured in the virtual-branch store, and flips the
	 * branch's `virtual` flag off.  Throws if the branch isn't virtual.
	 */
	materialiseBranch(name: string): Promise<void>

	/** Returns the names of every branch currently flagged as virtual. */
	getVirtualBranches(): string[]

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

	/** Ownership of one file: whole-file branch, hunk assignments, and whether it is floating. */
	getFileOwnership(relativePath: string): FileOwnership

	/**
	 * The hunks of a file's uncommitted changes, with the branch each is
	 * assigned to. Use these indices with `assignHunk`.
	 */
	getFileHunks(relativePath: string, options?: FileHunkOptions): Promise<FileHunkInfo[]>

	// ── Status queries ────────────────────────────────────────────────────────

	/**
	 * Returns the staged/unstaged/untracked/floating counts for a branch.
	 * The counts reflect the branch's worktree `git status`.
	 */
	getBranchStatus(branch: string): Promise<BranchStatus>

	/** Returns status for all branches plus the total floating file count. */
	getStackStatus(): Promise<StackStatus>

	/**
	 * What the branch changes relative to where it forked from its base,
	 * including uncommitted edits to tracked files in its worktree.
	 * Throws for a virtual branch (it has no worktree yet).
	 */
	getBranchDiff(branch: string, options?: BranchDiffOptions): Promise<BranchDiff>

	/** The most recent recorded GitBraid actions, newest first. */
	getUndoLog(limit?: number): Promise<UndoLogEntry[]>

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

	/**
	 * Pulls the latest changes from origin into the branch's worktree.
	 * Runs `git pull --rebase`.
	 */
	pullBranch(branch: string): Promise<void>

	/**
	 * Syncs the branch: pulls (--rebase) then pushes to origin.
	 * Sets the upstream automatically on the first push if none is configured.
	 */
	syncBranch(branch: string): Promise<void>

	// ── Symmetric read / mutate helpers ───────────────────────────────────────

	/** Reorder branches in the stack by providing the desired name sequence. */
	reorderStack(orderedNames: string[]): Promise<void>

	/** Retrieve the hunk assignments for a file (hunkIndex → branchName). */
	getHunkAssignments(relativePath: string): Map<number, string> | undefined

	/** Remove a single hunk assignment. */
	removeHunkAssignment(relativePath: string, hunkIndex: number): Promise<void>

	/**
	 * Rebases the branch onto its configured parent branch.
	 * Throws if the branch is not in the stack or if git rebase fails.
	 */
	rebaseBranch(branch: string): Promise<void>

	/**
	 * Applies all pending hunk assignments for a file by running `git apply`
	 * in each target branch's worktree, then clears the assignments.
	 * Returns the number of hunks routed and skipped.
	 */
	routeHunks(relativePath: string): Promise<{ routed: number, skipped: number }>

	// ── Events ────────────────────────────────────────────────────────────────

	/** Fires whenever a file assignment is created, changed, or removed. */
	onDidChangeAssignment: vscode.Event<AssignmentChangeEvent>

	/** Fires whenever the branch stack is modified (add / remove / reorder). */
	onDidChangeStack: vscode.Event<StackChangeEvent>

	/** Fires when a file is copied into a branch's worktree after a save. */
	onDidSyncFile: vscode.Event<{ relativePath: string, branch: string }>

	/** Fires when a save touches a file with no branch assignment. */
	onDidFloatFile: vscode.Event<{ relativePath: string }>
}
