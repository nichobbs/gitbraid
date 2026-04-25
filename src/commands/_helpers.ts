/**
 * Pure helpers extracted from the command modules so they can be unit-tested
 * without spinning up a VS Code extension host.  Anything in this file must
 * be free of `vscode.window.*` / `vscode.workspace.*` calls — the residual
 * shells in the command files glue these to the real APIs.
 */

import * as path from 'node:path'
import type { BranchStackEntry } from '../configTypes'

// ─── Stack reordering ────────────────────────────────────────────────────────

/**
 * Compute the new ordered branch-name list when `branchName` is moved one
 * position in `direction` within the stack (sorted ascending by `order`).
 *
 * Returns `undefined` when the move is a no-op (branch missing, or already
 * at the edge in the requested direction) so callers can early-return
 * without touching `ConfigService`.  Scratch entries are filtered out of
 * the move set — the caller is expected to call `reorderStack(names)`,
 * which preserves the order of any branch not mentioned.
 */
export function reorderForMove(
	stack: readonly BranchStackEntry[],
	branchName: string,
	direction: 'up' | 'down',
): string[] | undefined {
	const sorted = stack
		.filter((e) => !e.scratch)
		.sort((a, b) => a.order - b.order)
	const idx = sorted.findIndex((e) => e.name === branchName)
	if (idx === -1) return undefined
	if (direction === 'up' && idx >= sorted.length - 1) return undefined
	if (direction === 'down' && idx <= 0) return undefined

	const names = sorted.map((e) => e.name)
	const swapWith = direction === 'up' ? idx + 1 : idx - 1
	;[names[idx], names[swapWith]] = [names[swapWith], names[idx]]
	return names
}

// ─── Base-branch picker ──────────────────────────────────────────────────────

/**
 * Build the ordered base-branch list shown in the "Base branch" quick pick:
 * the detected default branch always comes first, followed by every stack
 * branch that isn't the default.  De-duplicates so the default doesn't
 * appear twice if it's also in the stack.
 */
export function buildBaseList(stack: readonly BranchStackEntry[], defaultBranch: string): string[] {
	const others = stack.map((e) => e.name).filter((n) => n !== defaultBranch)
	return [defaultBranch, ...others]
}

// ─── "Assign file" branch picker ─────────────────────────────────────────────

export interface AssignBranchPickItem {
	label: string
	description?: string
}

/**
 * Build the items shown when the user assigns a file to a branch.
 *
 * Behaviour:
 *  - The currently-checked-out branch is offered as a "stays in workspace"
 *    target IFF it isn't already in the stack.  This lets the user mark
 *    files as belonging to a branch that doesn't have a worktree.
 *  - Every stack branch is offered, with its colour as the description so
 *    the picker can render the dot inline.
 *  - Returns an empty array when neither source has anything to offer; the
 *    caller surfaces a "no branches in the stack" warning.
 */
export function buildAssignBranchPickItems(
	stack: readonly BranchStackEntry[],
	currentBranch: string | undefined,
	currentInStack: boolean,
): AssignBranchPickItem[] {
	const items: AssignBranchPickItem[] = []
	if (currentBranch && !currentInStack) {
		items.push({ label: currentBranch, description: '(current branch — stays in workspace)' })
	}
	for (const e of stack) {
		items.push({ label: e.name, description: e.color })
	}
	return items
}

// ─── Glob → candidate list ───────────────────────────────────────────────────

/**
 * Normalise a list of `vscode.Uri`-like fsPaths to workspace-relative POSIX
 * paths, dropping anything outside the root, and sort for stable display.
 */
export function globToCandidates(fsPaths: readonly string[], rootFsPath: string): string[] {
	return fsPaths
		.map((p) => path.relative(rootFsPath, p).replaceAll('\\', '/'))
		.filter((rel) => rel.length > 0 && !rel.startsWith('..'))
		.sort()
}

// ─── "Add stack branch" quick-pick item builder ──────────────────────────────

export interface BranchPickItem {
	label: string
	description?: string
	detail?: string
	kind?: 'separator' | 'item'
	isNew?: boolean
}

/**
 * Build the quick-pick items for the "Add Stack Branch" picker, given the
 * user's current input plus the cached local / remote branch lists.  Pure
 * function — the calling shell maps these to `vscode.QuickPickItem` and
 * wires up the separator kinds.
 *
 * Behaviour mirrors the original inline `buildItems()`:
 *  - When the trimmed input doesn't match any known branch, prepend a
 *    "create new branch" entry so the user can confirm a fresh name.
 *  - Group local matches under "Local" and remote matches under "Remote"
 *    using separator items.
 *  - Filter out branches that are already in the stack.
 */
export function buildAddBranchPickItems(
	value: string,
	availableLocal: readonly string[],
	remote: readonly string[],
	stackBranchNames: ReadonlySet<string>,
): BranchPickItem[] {
	const items: BranchPickItem[] = []
	const trimmed = value.trim()
	if (trimmed && !availableLocal.includes(trimmed) && !remote.includes(trimmed)) {
		items.push({
			label: `$(plus) ${trimmed}`,
			description: 'Create a new branch',
			detail: trimmed,
			isNew: true,
		})
	}
	const localMatches = availableLocal.filter((b) => b.includes(trimmed))
	if (localMatches.length > 0) {
		items.push({ label: 'Local', kind: 'separator' })
		for (const b of localMatches) items.push({ label: b, description: 'local' })
	}
	const remoteMatches = remote.filter((b) => !stackBranchNames.has(b))
	if (remoteMatches.length > 0) {
		items.push({ label: 'Remote', kind: 'separator' })
		for (const b of remoteMatches) items.push({ label: b, description: 'remote' })
	}
	return items
}

// ─── "Files assigned to branch" set ──────────────────────────────────────────

/**
 * Return the workspace-relative paths assigned to `branch` from a config
 * snapshot.  Used by `gitbraid.resetBranch` and `gitbraid.removeBranch` to
 * compute which files need their `skip-worktree` / `.git/info/exclude`
 * entries reverted.
 */
export function filesAssignedTo(
	allAssignments: Readonly<Record<string, string>>,
	branch: string,
): string[] {
	return Object.entries(allAssignments)
		.filter(([, b]) => b === branch)
		.map(([rel]) => rel)
}

// ─── Pluralisation ───────────────────────────────────────────────────────────

/**
 * Tiny pluraliser used by the toast messages.  Intentionally simple:
 *  pluralise(0, 'file')    → '0 files'
 *  pluralise(1, 'file')    → '1 file'
 *  pluralise(3, 'branch', 'branches') → '3 branches'
 */
export function pluralise(count: number, singular: string, plural?: string): string {
	const word = count === 1 ? singular : (plural ?? singular + 's')
	return `${String(count)} ${word}`
}

// ─── Tool display name ───────────────────────────────────────────────────────

export type StackedToolKind = 'graphite' | 'git-spr' | 'git-stack' | 'gitbutler' | 'upstream'

/** Human-readable label for a detected stacked-PR tool. */
export function toolDisplayName(tool: StackedToolKind): string {
	switch (tool) {
		case 'graphite':  return 'Graphite'
		case 'git-spr':   return 'git-spr'
		case 'git-stack': return 'git-stack'
		case 'gitbutler': return 'GitButler'
		case 'upstream':  return 'Upstream tracking'
	}
}
