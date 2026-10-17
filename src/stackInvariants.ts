import * as path from 'node:path'
import type { BranchStackEntry } from './configTypes'

/**
 * Plan 12: the rules the stack API enforces on every caller.
 *
 * Agents act on whatever is easiest, so the API layer (not the individual
 * tool wrappers) refuses operations that would leave the stack in a bad state,
 * and says why and what to do instead.  Pure functions with no `vscode`
 * dependency, so they can be unit tested directly and reused by a future CLI.
 */

export type InvariantCode =
	| 'BRANCH_NOT_FOUND'
	| 'BRANCH_HAS_NO_WORKTREE'
	| 'BRANCH_IS_SCRATCH'
	| 'PATH_INVALID'
	| 'PATH_ESCAPES_WORKSPACE'
	| 'PATH_RESERVED'
	| 'HUNK_OUT_OF_RANGE'
	| 'REORDER_NOT_A_PERMUTATION'
	| 'FORCE_REQUIRES_CONFIRMATION'

/**
 * A refused operation.  `code` is stable and machine-readable; `message` says
 * what was wrong; `hint` names the call that would fix it.
 */
export class StackInvariantError extends Error {
	constructor(
		readonly code: InvariantCode,
		message: string,
		readonly hint?: string,
	) {
		super(message)
		this.name = 'StackInvariantError'
	}

	toJSON(): { code: InvariantCode, message: string, hint?: string } {
		return { code: this.code, message: this.message, ...(this.hint ? { hint: this.hint } : {}) }
	}
}

/** Top-level directories GitBraid and git own; files under them must never be assigned. */
const RESERVED_ROOTS = ['.git', '.worktrees']

/**
 * Validate a workspace-relative path and return it normalised (forward slashes,
 * no leading `./`).  Rejects absolute paths, paths that leave the workspace, and
 * paths under `.git` or `.worktrees`.
 */
export function requireWorkspacePath(workspaceRoot: string, relativePath: string): string {
	if (typeof relativePath !== 'string' || relativePath.trim() === '') {
		throw new StackInvariantError('PATH_INVALID', 'The path is empty.', 'Pass a workspace-relative path such as "src/foo.ts".')
	}
	const slashed = relativePath.replaceAll('\\', '/')
	if (slashed.includes('\0')) {
		throw new StackInvariantError('PATH_INVALID', 'The path contains a NUL character.')
	}
	// `C:/x` and `//host/x` are absolute on Windows whatever the host OS.
	if (path.isAbsolute(slashed) || /^[A-Za-z]:\//.test(slashed) || slashed.startsWith('//')) {
		throw new StackInvariantError(
			'PATH_INVALID',
			`"${relativePath}" is an absolute path.`,
			'Pass a path relative to the workspace root, such as "src/foo.ts".',
		)
	}
	const normalised = path.posix.normalize(slashed).replace(/^(\.\/)+/, '')
	if (normalised === '..' || normalised.startsWith('../')) {
		throw new StackInvariantError(
			'PATH_ESCAPES_WORKSPACE',
			`Path escapes workspace root: ${relativePath}`,
			'Only files inside the workspace can be assigned.',
		)
	}
	const resolved = path.resolve(workspaceRoot, normalised)
	const rootWithSep = workspaceRoot.endsWith(path.sep) ? workspaceRoot : workspaceRoot + path.sep
	if (resolved !== workspaceRoot && !resolved.startsWith(rootWithSep)) {
		throw new StackInvariantError('PATH_ESCAPES_WORKSPACE', `Path escapes workspace root: ${relativePath}`)
	}
	const first = normalised.split('/')[0]
	if (RESERVED_ROOTS.includes(first)) {
		throw new StackInvariantError(
			'PATH_RESERVED',
			`"${relativePath}" is under "${first}", which git and GitBraid manage.`,
			'Assign your own source files instead.',
		)
	}
	return normalised
}

/** The stack entry called `name`, or a `BRANCH_NOT_FOUND` error listing what does exist. */
export function requireBranch(stack: readonly BranchStackEntry[], name: string): BranchStackEntry {
	const entry = stack.find((e) => e.name === name)
	if (!entry) {
		const known = stack.map((e) => e.name)
		throw new StackInvariantError(
			'BRANCH_NOT_FOUND',
			`Branch "${name}" is not in the stack`,
			known.length > 0
				? `Branches in the stack: ${known.join(', ')}. Call getStack to list them.`
				: 'The stack is empty. Call addBranch first.',
		)
	}
	return entry
}

/** For operations that run git in the branch's worktree: a virtual branch has none yet. */
export function requireWorktree(entry: BranchStackEntry, action: string): void {
	if (entry.virtual === true) {
		throw new StackInvariantError(
			'BRANCH_HAS_NO_WORKTREE',
			`Branch "${entry.name}" is virtual and has no worktree, so it cannot ${action}.`,
			`Call materialiseBranch for "${entry.name}" first.`,
		)
	}
}

/** Scratch worktrees are parking areas: nothing there is meant to be committed or published. */
export function requireNotScratch(entry: BranchStackEntry, action: string): void {
	if (entry.scratch === true) {
		throw new StackInvariantError(
			'BRANCH_IS_SCRATCH',
			`Branch "${entry.name}" is a scratch worktree, so it cannot ${action}.`,
			'Scratch worktrees are not meant to be committed or pushed. Assign the files to a real branch instead.',
		)
	}
}

/** `hunkIndex` must name a hunk that currently exists in the file. */
export function requireHunkInRange(relativePath: string, hunkIndex: number, hunkCount: number): void {
	if (!Number.isInteger(hunkIndex) || hunkIndex < 0 || hunkIndex >= hunkCount) {
		throw new StackInvariantError(
			'HUNK_OUT_OF_RANGE',
			hunkCount === 0
				? `"${relativePath}" has no uncommitted changes, so there is no hunk ${String(hunkIndex)}.`
				: `"${relativePath}" has ${String(hunkCount)} hunk(s) (0 to ${String(hunkCount - 1)}); hunk ${String(hunkIndex)} does not exist.`,
			'Call getFileHunks to list the hunks that exist right now. Indices change whenever the file is edited.',
		)
	}
}

/**
 * `orderedNames` must contain every branch in the stack exactly once.  A partial
 * or misspelt list would otherwise silently leave some branches where they were.
 */
export function requirePermutation(stack: readonly BranchStackEntry[], orderedNames: readonly string[]): void {
	const current = stack.map((e) => e.name)
	const wanted = new Set(orderedNames)
	const missing = current.filter((n) => !wanted.has(n))
	const unknown = [...wanted].filter((n) => !current.includes(n))
	const duplicated = orderedNames.length !== wanted.size
	if (missing.length === 0 && unknown.length === 0 && !duplicated) return

	const problems: string[] = []
	if (missing.length > 0) problems.push(`missing: ${missing.join(', ')}`)
	if (unknown.length > 0) problems.push(`not in the stack: ${unknown.join(', ')}`)
	if (duplicated) problems.push('contains duplicates')
	throw new StackInvariantError(
		'REORDER_NOT_A_PERMUTATION',
		`orderedNames must list every branch in the stack exactly once (${problems.join('; ')}).`,
		`The stack currently contains: ${current.join(', ')}.`,
	)
}

/**
 * Agent callers do not get to bypass the "discard uncommitted work" prompt.
 * Applied by the tool layer, where the caller is known, not by the API itself,
 * because programmatic API users (other extensions) pass `force` deliberately.
 */
export function requireForceAllowed(force: boolean, allowed: boolean): void {
	if (force && !allowed) {
		throw new StackInvariantError(
			'FORCE_REQUIRES_CONFIRMATION',
			'Removing a branch with force would discard its uncommitted work, which an agent may not do on its own.',
			'Commit or stash the work and call removeBranch without force, or ask the user to enable the gitbraid.agentAllowForce setting.',
		)
	}
}

/** `{ code, message, hint? }` for any error, so adapters can report failures uniformly. */
export function describeError(e: unknown): { code: InvariantCode | 'ERROR', message: string, hint?: string } {
	if (e instanceof StackInvariantError) return e.toJSON()
	return { code: 'ERROR', message: e instanceof Error ? e.message : String(e) }
}
