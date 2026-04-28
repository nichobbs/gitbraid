/**
 * Type definitions for the branch-overlay workspace configuration.
 *
 * The config is stored in `.worktrees/gitbraid-config.json` and is never
 * committed to the repository — it is personal working state.
 */

export const CONFIG_SCHEMA_VERSION = 2

/** A single entry in the ordered branch stack. */
export interface BranchStackEntry {
	/** Git branch name, e.g. "feature/docs" */
	name: string
	/** CSS hex colour used for file decorations, e.g. "#4CAF50" */
	color: string
	/** Position in the stack (1-based, lower = closer to base) */
	order: number
	/**
	 * Name of the parent branch in the stack, or the repo default branch
	 * (e.g. "main") for the lowest layer.
	 */
	base: string
	/**
	 * When true this is a scratch worktree — a parking area for files that are
	 * not intended to be committed to any branch.  The SCM panel for scratch
	 * entries hides the commit/push controls.
	 */
	scratch?: boolean
	/**
	 * When true this branch has no git worktree yet — it exists only as an
	 * in-memory set of file snapshots held by {@link VirtualBranchStore}.
	 * Materialising the branch (see `gitbraid.materialiseVirtualBranch`) creates
	 * the worktree, writes every tracked file, and flips this flag back to
	 * `undefined` / `false`.  See `docs/plans/08-virtual-branches.md`.
	 */
	virtual?: boolean
	/**
	 * Optional commit-message template for this branch's SCM input box.
	 * Variables: `{branch}` (full name), `{issue}` (first JIRA-style token),
	 * `{scope}` (last path segment after `/`).
	 */
	commitTemplate?: string
	/**
	 * Cached pull-request number for this branch on the configured host.
	 * This is a cache, not a source of truth — the host adapter is always
	 * authoritative.  Stored so the UI can avoid a network round-trip for
	 * the common case of "which PR is this branch?".
	 */
	prNumber?: number
	/**
	 * When true the SCM panel treats this branch as single-commit: new
	 * commits amend the existing HEAD instead of appending.  See
	 * `docs/plans/03-single-commit-per-pr.md`.
	 */
	singleCommit?: boolean
}

/**
 * Map of workspace-relative file paths to the branch name that owns them.
 * Floating files (not yet assigned) are absent from this map.
 *
 * Keys use forward slashes regardless of OS, e.g. "src/foo.ts".
 */
export type AssignmentMap = Record<string, string>

/**
 * Per-file hunk-level assignments.
 *
 * Outer key: workspace-relative file path (forward-slash normalised).
 * Inner key: hunk index (as string for JSON compatibility).
 * Value: branch name that should receive that hunk's changes.
 */
export type HunkAssignmentMap = Record<string, Record<string, string>>

/**
 * Stable positional anchors for hunk assignments.
 *
 * The bare integer index kept in {@link HunkAssignmentMap} is fragile: any
 * edit that splits, merges, or renumbers hunks shifts the indices and the
 * persisted assignment silently starts pointing at different lines.
 *
 * On every `setHunkAssignment` we also record the hunk's line range and a
 * short SHA of its body so the router can reconcile the assignment against
 * the live diff at route time.  See remediation T8.
 *
 * Outer key: relative path.  Inner key: same hunk-index string used in
 * `HunkAssignmentMap` so the two maps stay in lockstep.
 */
export type HunkAnchorMap = Record<string, Record<string, HunkAnchor>>

export interface HunkAnchor {
	/** 1-based start line in the new (current) file. */
	startLine: number
	/** 1-based inclusive end line; -1 or `startLine - 1` for pure deletions. */
	endLine: number
	/** SHA1 of the hunk header + body (first 12 chars) captured at set time. */
	bodyHash: string
}

/**
 * When two branches modify overlapping line ranges in the same file the user
 * resolves the conflict at add-branch time.  The resolution is persisted here
 * so the display is stable across restarts.  See plan 11.
 */
export interface OverlapResolution {
	/** Workspace-relative file path (forward-slash normalised). */
	file: string
	/** 1-based inclusive line range of the overlap in the workspace view. */
	range: [number, number]
	/** The two (or more) branch names that both modify this range. */
	branches: [string, string, ...string[]]
	/** Which branch's version is shown.  `'manual'` = user edited the merged result. */
	resolution: string
}

/** Root structure of `.worktrees/gitbraid-config.json`. */
export interface BranchConfig {
	version: number
	/**
	 * Common base branch for all branches in the stack (e.g. "main").
	 * Used as the diff root for hunk attribution in the parallel-branch workspace.
	 * See `docs/plans/11-parallel-branch-workspace.md`.
	 */
	root?: string
	stack: BranchStackEntry[]
	assignments: AssignmentMap
	/** Hunk-level assignments — present only when the user has assigned individual hunks. */
	hunkAssignments?: HunkAssignmentMap
	/** Stable positional anchors accompanying `hunkAssignments` — T8. */
	hunkAnchors?: HunkAnchorMap
	/** Persisted overlap-conflict resolutions — plan 11. */
	overlapResolutions?: OverlapResolution[]
}

// ─── Runtime status types ────────────────────────────────────────────────────

/** Staged/unstaged counts for a single branch's worktree. */
export interface BranchStatus {
	branch: string
	staged: number
	unstaged: number
	untracked: number
	floating: number
}

/** Aggregated status across the whole stack. */
export interface StackStatus {
	branches: BranchStatus[]
	totalFloating: number
}

// ─── Event types ─────────────────────────────────────────────────────────────

export interface AssignmentChangeEvent {
	/** Workspace-relative path of the affected file. */
	relativePath: string
	/** New branch name, or `undefined` if the file was unassigned. */
	branch: string | undefined
	/** Previous branch name, or `undefined` if the file was unassigned before. */
	previousBranch: string | undefined
}

export interface StackChangeEvent {
	type: 'add' | 'remove' | 'reorder'
	/** Branch name involved in the change. */
	branch: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns an empty, valid BranchConfig. */
export function emptyConfig(): BranchConfig {
	return {
		version: CONFIG_SCHEMA_VERSION,
		stack: [],
		assignments: {},
		hunkAssignments: {},
		hunkAnchors: {},
		overlapResolutions: [],
	}
}

/**
 * Validate that a parsed object conforms to BranchConfig well enough to use.
 * Returns `true` if valid, `false` if the structure is unrecognisably wrong.
 * Partial/missing fields are tolerated and filled in by `migrateConfig`.
 */
export function isValidConfig(raw: unknown): raw is BranchConfig {
	if (typeof raw !== 'object' || raw === null) {
		return false
	}
	const r = raw as Record<string, unknown>
	if (typeof r['version'] !== 'number') {
		return false
	}
	if (!Array.isArray(r['stack'])) {
		return false
	}
	if (typeof r['assignments'] !== 'object' || r['assignments'] === null || Array.isArray(r['assignments'])) {
		return false
	}
	return true
}

/**
 * Migrate a config object to the current schema version in-place.
 * Currently only version 1 exists, so this is a no-op except for filling
 * in missing optional fields.
 */
export function migrateConfig(config: BranchConfig): BranchConfig {
	// Ensure assignments object exists (may be missing in hand-edited files)
	if (!config.assignments) {
		config.assignments = {}
	}
	// Ensure each stack entry has a color
	for (const entry of config.stack) {
		if (!entry.color) {
			entry.color = '#888888'
		}
	}
	// Re-number order to be contiguous if entries are missing order values
	const unsorted = config.stack.filter((e) => typeof e.order !== 'number')
	if (unsorted.length > 0) {
		const maxOrder = config.stack.reduce((m, e) => Math.max(m, e.order || 0), 0)
		unsorted.forEach((e, i) => { e.order = maxOrder + i + 1 })
	}
	// Ensure hunkAssignments object exists
	config.hunkAssignments ??= {}
	// v1 → v2: introduce hunkAnchors.  Pre-existing hunk assignments carry
	// no anchor yet; they'll be treated as stale by the reconciler until the
	// user re-assigns them.  Safe default — routing simply warns rather than
	// applying them to the wrong lines.
	config.hunkAnchors ??= {}
	config.overlapResolutions ??= []
	config.version = CONFIG_SCHEMA_VERSION
	return config
}
