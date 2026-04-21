/**
 * Type definitions for the branch-overlay workspace configuration.
 *
 * The config is stored in `.worktrees/local-config.json` and is never
 * committed to the repository — it is personal working state.
 */

export const CONFIG_SCHEMA_VERSION = 1

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
}

/**
 * Map of workspace-relative file paths to the branch name that owns them.
 * Floating files (not yet assigned) are absent from this map.
 *
 * Keys use forward slashes regardless of OS, e.g. "src/foo.ts".
 */
export type AssignmentMap = Record<string, string>

/** Root structure of `.worktrees/local-config.json`. */
export interface BranchConfig {
	version: number
	stack: BranchStackEntry[]
	assignments: AssignmentMap
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
	config.version = CONFIG_SCHEMA_VERSION
	return config
}
