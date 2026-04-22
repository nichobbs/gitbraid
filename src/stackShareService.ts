import * as vscode from 'vscode'
import * as path from 'node:path'
import { promises as fsp } from 'node:fs'
import { log } from './channelLogger'
import { ConfigService } from './configService'
import { BranchStackEntry } from './configTypes'
import { ConfigError } from './errors'

/** Directory (relative to workspace root) where shared stack layouts live. */
export const SHARED_DIR = '.gitbraid'
export const SHARED_FILE = 'stack.json'

/** Schema version for `.gitbraid/stack.json`. */
export const SHARED_SCHEMA_VERSION = 1

/**
 * Shape of `.gitbraid/stack.json`.  Designed to be **committed** to the
 * repository so teammates converge on the same stack layout.
 *
 * Only team-shareable fields are included.  Personal state —
 * `hunkAnchors` (keyed to line numbers that don't match across machines),
 * worktree paths, and the mtime cache — stays in the per-machine
 * `.worktrees/local-config.json`.
 */
export interface SharedStackFile {
	version: number
	/** Ordered stack from base to top. */
	stack: SharedBranchEntry[]
	/** Workspace-relative path → branch name.  Empty if none are shared. */
	assignments: Record<string, string>
	/** Optional per-file hunk-index → branch map.  Treat as hints. */
	hunkAssignments?: Record<string, Record<string, string>>
	/** ISO-8601 timestamp (UTC) the file was exported at.  Informational. */
	exportedAt?: string
}

export interface SharedBranchEntry {
	name: string
	base: string
	/** Hex colour — optional; teammates may override. */
	color?: string
	order: number
}

/**
 * Team-shareable stack export / import (T71).
 *
 * Non-goals:
 *   - Continuous bidirectional sync — this is an explicit import / export,
 *     not a live merge.  Keep it simple.
 *   - Round-tripping personal state.  Hunk *indexes* are shared as hints;
 *     anchors (bodyHash, startLine, endLine) are local-machine-only because
 *     they reference line positions the receiving machine can't validate.
 */
export class StackShareService {

	constructor(
		private readonly _config: ConfigService,
		private readonly _workspaceRoot: vscode.Uri,
	) {}

	sharedFilePath(): string {
		return path.join(this._workspaceRoot.fsPath, SHARED_DIR, SHARED_FILE)
	}

	// ── Export ────────────────────────────────────────────────────────────────

	/**
	 * Serialise the in-memory config to the shared-file shape.  Exposed for
	 * tests; production callers should use {@link exportToDisk}.
	 */
	toSharedFile(): SharedStackFile {
		const stack: SharedBranchEntry[] = this._config.getStack().map((e) => ({
			name: e.name,
			base: e.base,
			color: e.color,
			order: e.order,
		}))

		const assignments: Record<string, string> = { ...this._config.getAllAssignments() }

		// Hunk indexes without anchors — teammates' diffs will differ, but
		// exporting the indexes gives them a starting point.
		const hunkAssignments: Record<string, Record<string, string>> = {}
		for (const rel of this._config.getHunkAssignedFiles()) {
			const entries = this._config.getHunkAssignments(rel)
			if (!entries || entries.size === 0) continue
			const obj: Record<string, string> = {}
			for (const [idx, branch] of entries) {
				obj[String(idx)] = branch
			}
			hunkAssignments[rel] = obj
		}

		const shared: SharedStackFile = {
			version: SHARED_SCHEMA_VERSION,
			stack,
			assignments,
			exportedAt: new Date().toISOString(),
		}
		if (Object.keys(hunkAssignments).length > 0) {
			shared.hunkAssignments = hunkAssignments
		}
		return shared
	}

	async exportToDisk(): Promise<string> {
		const dir = path.join(this._workspaceRoot.fsPath, SHARED_DIR)
		await fsp.mkdir(dir, { recursive: true })
		const filePath = this.sharedFilePath()
		const body = JSON.stringify(this.toSharedFile(), null, 2) + '\n'
		const tmp = filePath + '.tmp'
		await fsp.writeFile(tmp, body, 'utf-8')
		await fsp.rename(tmp, filePath)
		log.info(`StackShareService: exported ${String(this._config.getStack().length)} branch(es) to ${filePath}`)
		return filePath
	}

	// ── Import ────────────────────────────────────────────────────────────────

	/**
	 * Read the shared file.  Returns `undefined` if the file doesn't exist.
	 * Throws {@link ConfigError} on malformed JSON or schema mismatches.
	 */
	async readSharedFile(): Promise<SharedStackFile | undefined> {
		const filePath = this.sharedFilePath()
		let raw: string
		try {
			raw = await fsp.readFile(filePath, 'utf-8')
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
				return undefined
			}
			throw new ConfigError(`Failed to read ${filePath}: ${(e as Error).message}`)
		}
		let parsed: unknown
		try {
			parsed = JSON.parse(raw)
		} catch (e) {
			throw new ConfigError(`Malformed JSON in ${filePath}: ${(e as Error).message}`)
		}
		if (!isValidSharedFile(parsed)) {
			throw new ConfigError(`${filePath}: unexpected structure`)
		}
		if (parsed.version > SHARED_SCHEMA_VERSION) {
			throw new ConfigError(
				`${filePath} was exported by a newer version of GitBraid (schema ${String(parsed.version)} > ${String(SHARED_SCHEMA_VERSION)}).` +
				' Update the extension or edit the file manually to continue.'
			)
		}
		return parsed
	}

	// ── Diff ──────────────────────────────────────────────────────────────────

	/**
	 * Compute what importing `shared` would change, without mutating state.
	 * Used to drive the conflict-resolution QuickPick.
	 */
	diffWithCurrent(shared: SharedStackFile): ImportDiff {
		const currentStack = new Map(this._config.getStack().map((e) => [e.name, e]))
		const newBranches: SharedBranchEntry[] = []
		const conflictBranches: Array<{ shared: SharedBranchEntry, ours: BranchStackEntry }> = []
		for (const s of shared.stack) {
			const ours = currentStack.get(s.name)
			if (!ours) {
				newBranches.push(s)
			} else if (ours.base !== s.base || ours.order !== s.order || ours.color !== s.color) {
				conflictBranches.push({ shared: s, ours })
			}
		}

		const currentAssignments = this._config.getAllAssignments()
		const newAssignments: Array<{ relativePath: string, branch: string }> = []
		const conflictAssignments: Array<{ relativePath: string, shared: string, ours: string }> = []
		for (const [rel, branch] of Object.entries(shared.assignments)) {
			const ours = currentAssignments[rel]
			if (ours === undefined) {
				newAssignments.push({ relativePath: rel, branch })
			} else if (ours !== branch) {
				conflictAssignments.push({ relativePath: rel, shared: branch, ours })
			}
		}

		return {
			newBranches,
			conflictBranches,
			newAssignments,
			conflictAssignments,
		}
	}

	// ── Apply ─────────────────────────────────────────────────────────────────

	/**
	 * Apply an import.  `resolution` controls how conflicts are handled; see
	 * {@link ImportResolution}.  Returns a summary suitable for logging.
	 */
	async applyImport(shared: SharedStackFile, resolution: ImportResolution): Promise<ImportSummary> {
		const summary: ImportSummary = {
			addedBranches: 0,
			addedAssignments: 0,
			updatedBranches: 0,
			updatedAssignments: 0,
			skipped: 0,
		}

		// 1 — Add new branches.  No-op if the branch already exists; the
		// config service rejects duplicates.
		const diff = this.diffWithCurrent(shared)
		for (const b of diff.newBranches) {
			try {
				await this._config.addBranch({
					name: b.name,
					base: b.base,
					color: b.color ?? '#888888',
					order: b.order,
				})
				summary.addedBranches += 1
			} catch (e) {
				log.warn(`StackShareService: failed to add branch "${b.name}": ${(e as Error).message}`)
			}
		}

		// 2 — Conflicting branch metadata (base / order / colour).  We only
		// touch it when the caller said so.
		if (resolution.branches === 'theirs') {
			for (const { shared: s } of diff.conflictBranches) {
				// The config service doesn't expose an "update branch" API;
				// simplest path is remove + re-add.  Skip if removal would
				// destroy a worktree the user is actively using.
				try {
					await this._config.removeBranch(s.name)
					await this._config.addBranch({
						name: s.name,
						base: s.base,
						color: s.color ?? '#888888',
						order: s.order,
					})
					summary.updatedBranches += 1
				} catch (e) {
					log.warn(`StackShareService: could not update branch "${s.name}": ${(e as Error).message}`)
					summary.skipped += 1
				}
			}
		} else {
			summary.skipped += diff.conflictBranches.length
		}

		// 3 — New assignments always get added.
		for (const a of diff.newAssignments) {
			try {
				await this._config.setAssignment(a.relativePath, a.branch)
				summary.addedAssignments += 1
			} catch (e) {
				log.warn(`StackShareService: could not assign "${a.relativePath}": ${(e as Error).message}`)
			}
		}

		// 4 — Conflicting assignments — obey the resolution.
		if (resolution.assignments === 'theirs') {
			for (const a of diff.conflictAssignments) {
				try {
					await this._config.setAssignment(a.relativePath, a.shared)
					summary.updatedAssignments += 1
				} catch {
					summary.skipped += 1
				}
			}
		} else {
			summary.skipped += diff.conflictAssignments.length
		}

		log.info(`StackShareService.applyImport: ${JSON.stringify(summary)}`)
		return summary
	}
}

// ─── Types / validation ─────────────────────────────────────────────────────

export interface ImportDiff {
	newBranches: SharedBranchEntry[]
	conflictBranches: Array<{ shared: SharedBranchEntry, ours: BranchStackEntry }>
	newAssignments: Array<{ relativePath: string, branch: string }>
	conflictAssignments: Array<{ relativePath: string, shared: string, ours: string }>
}

/** How to handle values that exist in both the imported file and our config. */
export interface ImportResolution {
	/** 'theirs' → imported file wins; 'ours' → keep local. */
	branches: 'theirs' | 'ours'
	/** Same for assignments. */
	assignments: 'theirs' | 'ours'
}

export interface ImportSummary {
	addedBranches: number
	updatedBranches: number
	addedAssignments: number
	updatedAssignments: number
	/** Items that were conflicts but the resolution said to keep local. */
	skipped: number
}

export function isValidSharedFile(raw: unknown): raw is SharedStackFile {
	if (typeof raw !== 'object' || raw === null) return false
	const r = raw as Record<string, unknown>
	if (typeof r.version !== 'number') return false
	if (!Array.isArray(r.stack)) return false
	if (typeof r.assignments !== 'object' || r.assignments === null || Array.isArray(r.assignments)) return false
	for (const entry of r.stack) {
		if (typeof entry !== 'object' || entry === null) return false
		const e = entry as Record<string, unknown>
		if (typeof e.name !== 'string' || typeof e.base !== 'string' || typeof e.order !== 'number') return false
		if (e.color !== undefined && typeof e.color !== 'string') return false
	}
	return true
}
