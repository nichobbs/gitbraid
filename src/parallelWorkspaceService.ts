/**
 * Parallel-branch workspace service — plan 11.
 *
 * Owns the per-branch diff cache (committed diff + uncommitted dirty diff),
 * the in-memory hunk-attribution map, and overlap-conflict detection.
 *
 * Each entry in the attribution map maps a workspace-relative path to an
 * array of {@link AttributedHunk}s covering the lines that differ from the
 * root branch.  When two branches touch overlapping lines the overlap is
 * surfaced for user resolution; the resolution is stored in ConfigService.
 *
 * This service is intentionally read-only with respect to the workspace
 * filesystem — it only reads git diffs and writes to the config.  The
 * {@link HunkDecorationProvider} reads `attributionFor()` to paint gutter
 * decorations; `WorkspaceSync` / `HunkRouter` drive the actual file writes.
 */

import * as vscode from 'vscode'
import { log } from './channelLogger'
import { IGitRunner, getDefaultGitRunner } from './gitRunner'
import { parseDiffHunks, type DiffHunk } from './diffEngine'
import type { ConfigService } from './configService'
import type { OverlapResolution } from './configTypes'

// ─── Types ────────────────────────────────────────────────────────────────────

/** A hunk attributed to a branch, with display metadata. */
export interface AttributedHunk {
	/** Branch this hunk belongs to. */
	branch: string
	/** 1-based inclusive start line in the workspace file. */
	startLine: number
	/** 1-based inclusive end line in the workspace file. */
	endLine: number
	/** `true` if the hunk is committed on the branch; `false` if only in the worktree dirty state. */
	committed: boolean
}

/** Per-file attribution — all attributed hunks for a single file. */
export type FileAttribution = AttributedHunk[]

/** Internal per-branch diff cache entry. */
interface BranchDiffEntry {
	/** Cached committed hunks from `git diff root..branch`. */
	committed: Map<string, DiffHunk[]>
	/** Cached uncommitted hunks from `git diff HEAD` inside the branch worktree. */
	uncommitted: Map<string, DiffHunk[]>
	/** SHA of root at last compute. */
	rootSha: string
	/** SHA of branch HEAD at last compute. */
	headSha: string
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class ParallelWorkspaceService implements vscode.Disposable {

	private readonly _disposables: vscode.Disposable[] = []
	private readonly _branchDiffs = new Map<string, BranchDiffEntry>()
	/** In-memory attribution map.  Key = workspace-relative path. */
	private readonly _attribution = new Map<string, FileAttribution>()
	/** EventEmitter fired when the attribution map changes. */
	private readonly _onDidChange = new vscode.EventEmitter<void>()
	/** Fires when the attribution map is updated for any file. */
	readonly onDidChange: vscode.Event<void> = this._onDidChange.event

	constructor(
		private readonly _config: ConfigService,
		private readonly _wsRoot: string,
		private readonly _runner: IGitRunner = getDefaultGitRunner(),
	) {}

	dispose(): void {
		this._onDidChange.dispose()
		for (const d of this._disposables) d.dispose()
	}

	// ── Public API ─────────────────────────────────────────────────────────────

	/**
	 * (Re)compute diffs for every branch in the stack against the configured
	 * root.  Safe to call whenever the stack changes or the root advances.
	 *
	 * Returns a list of detected overlaps that were not already resolved.
	 */
	async refresh(): Promise<OverlapResolution[]> {
		const root = this._config.getRoot()
		if (!root) return []

		const stack = this._config.getStack().filter((e) => !e.scratch && !e.virtual)

		// Resolve SHAs once — used for cache invalidation.
		const rootSha = await this._resolveSha(root)

		await Promise.all(stack.map(async (entry) => {
			const worktreeDir = await this._worktreeDir(entry.name)
			if (!worktreeDir) return

			const headSha = await this._resolveSha('HEAD', worktreeDir)
			const cached = this._branchDiffs.get(entry.name)

			if (cached?.rootSha === rootSha && cached.headSha === headSha) {
				return // nothing changed for this branch
			}

			const [committed, uncommitted] = await Promise.all([
				this._computeCommittedDiffs(root, entry.name, worktreeDir),
				this._computeUncommittedDiffs(worktreeDir),
			])

			this._branchDiffs.set(entry.name, { committed, uncommitted, rootSha, headSha })
		}))

		// Remove diffs for branches no longer in the stack.
		const stackNames = new Set(stack.map((e) => e.name))
		for (const name of this._branchDiffs.keys()) {
			if (!stackNames.has(name)) this._branchDiffs.delete(name)
		}

		const overlaps = this._buildAttribution(stack.map((e) => e.name))
		this._onDidChange.fire()
		return overlaps
	}

	/**
	 * Returns the attribution for a workspace-relative file path, or an empty
	 * array if the file has no attributed hunks.
	 */
	attributionFor(relativePath: string): FileAttribution {
		return this._attribution.get(normalisePath(relativePath)) ?? []
	}

	/** Returns all files that have at least one attributed hunk. */
	attributedFiles(): string[] {
		return [...this._attribution.keys()]
	}

	// ── Private helpers ────────────────────────────────────────────────────────

	/**
	 * Rebuild the in-memory attribution map from cached diffs.
	 * Returns newly-detected overlaps (not already in config).
	 */
	private _buildAttribution(branchNames: string[]): OverlapResolution[] {
		this._attribution.clear()
		const existingResolutions = this._config.getOverlapResolutions()
		const fileMap = this._collectFileMap(branchNames)
		const newOverlaps: OverlapResolution[] = []

		for (const [file, hunks] of fileMap) {
			const { resolved, overlaps } = this._resolveFile(file, hunks, existingResolutions)
			if (resolved.length > 0) this._attribution.set(file, resolved)
			newOverlaps.push(...overlaps)
		}
		return newOverlaps
	}

	/** Build a per-file map of all attributed hunks from the cached diffs. */
	private _collectFileMap(branchNames: string[]): Map<string, AttributedHunk[]> {
		const fileMap = new Map<string, AttributedHunk[]>()
		for (const branch of branchNames) {
			const entry = this._branchDiffs.get(branch)
			if (!entry) continue
			for (const [file, hunks] of entry.committed) {
				const list = fileMap.get(file) ?? []
				for (const h of hunks) list.push({ branch, startLine: h.startLine, endLine: h.endLine, committed: true })
				fileMap.set(file, list)
			}
			for (const [file, hunks] of entry.uncommitted) {
				const list = fileMap.get(file) ?? []
				for (const h of hunks) list.push({ branch, startLine: h.startLine, endLine: h.endLine, committed: false })
				fileMap.set(file, list)
			}
		}
		return fileMap
	}

	/** Resolve overlaps within a single file, returning accepted hunks + new unresolved overlaps. */
	private _resolveFile(
		file: string,
		hunks: AttributedHunk[],
		existingResolutions: OverlapResolution[],
	): { resolved: AttributedHunk[]; overlaps: OverlapResolution[] } {
		const sorted = [...hunks].sort((a, b) => a.startLine - b.startLine)
		const resolved: AttributedHunk[] = []
		const overlaps: OverlapResolution[] = []

		for (const h of sorted) {
			const overlapping = resolved.filter((r) => r.startLine <= h.endLine && r.endLine >= h.startLine)
			if (overlapping.length === 0) {
				resolved.push(h)
				continue
			}
			const overlapRange: [number, number] = [
				Math.min(h.startLine, ...overlapping.map((o) => o.startLine)),
				Math.max(h.endLine, ...overlapping.map((o) => o.endLine)),
			]
			const existingRes = existingResolutions.find(
				(r) => r.file === file && r.range[0] === overlapRange[0] && r.range[1] === overlapRange[1],
			)
			if (existingRes) {
				if (existingRes.resolution === 'manual' || existingRes.resolution === h.branch) {
					resolved.push(h)
				}
			} else {
				const involvedBranches = [
					...new Set([h.branch, ...overlapping.map((o) => o.branch)]),
				] as [string, string, ...string[]]
				overlaps.push({ file, range: overlapRange, branches: involvedBranches, resolution: 'manual' })
				resolved.push(h)
			}
		}
		return { resolved, overlaps }
	}

	/** Compute `git diff root..branch` and return a per-file hunk map. */
	private async _computeCommittedDiffs(
		root: string,
		branch: string,
		worktreeDir: string,
	): Promise<Map<string, DiffHunk[]>> {
		const r = await this._runner.run(
			['diff', `${root}..${branch}`, '--unified=0', '--diff-filter=ACMR'],
			{ cwd: worktreeDir },
		)
		if (r.exitCode !== 0) {
			log.warn(`ParallelWorkspaceService: committed diff failed for ${branch}: ${r.stderr}`)
			return new Map()
		}
		return this._groupByFile(r.stdout)
	}

	/** Compute `git diff HEAD` inside the branch worktree (dirty state). */
	private async _computeUncommittedDiffs(worktreeDir: string): Promise<Map<string, DiffHunk[]>> {
		const r = await this._runner.run(
			['diff', 'HEAD', '--unified=0', '--diff-filter=ACMR'],
			{ cwd: worktreeDir },
		)
		if (r.exitCode !== 0) {
			log.warn(`ParallelWorkspaceService: uncommitted diff failed in ${worktreeDir}: ${r.stderr}`)
			return new Map()
		}
		return this._groupByFile(r.stdout)
	}

	/** Parse a unified diff output into a map of relativePath → DiffHunk[]. */
	private _groupByFile(diffOutput: string): Map<string, DiffHunk[]> {
		const result = new Map<string, DiffHunk[]>()
		if (!diffOutput.trim()) return result

		// Split on `diff --git` boundaries.
		const fileSections = diffOutput.split(/(?=^diff --git )/m).filter((s) => s.trim())
		for (const section of fileSections) {
			// Extract the b/ path (new file) from the header.
			const match = /^\+\+\+ b\/(.+)$/m.exec(section)
			if (!match) continue
			const relativePath = normalisePath(match[1])
			const hunks = parseDiffHunks(section)
			if (hunks.length > 0) {
				result.set(relativePath, hunks)
			}
		}
		return result
	}

	/** Resolve a branch/ref name to its full SHA. */
	private async _resolveSha(ref: string, cwd?: string): Promise<string> {
		const r = await this._runner.run(['rev-parse', ref], { cwd: cwd ?? this._wsRoot })
		return r.stdout.trim() || ref
	}

	/** Look up the worktree directory for a branch name via `git worktree list`. */
	private async _worktreeDir(branchName: string): Promise<string | undefined> {
		const r = await this._runner.run(
			['worktree', 'list', '--porcelain'],
			{ cwd: this._wsRoot },
		)
		if (r.exitCode !== 0) return undefined

		const sections = r.stdout.split('\n\n').filter((s) => s.trim())
		for (const section of sections) {
			const branchLine = /^branch refs\/heads\/(.+)$/m.exec(section)
			if (!branchLine) continue
			if (branchLine[1] !== branchName) continue
			const wt = /^worktree (.+)$/m.exec(section)
			if (wt) return wt[1].trim()
		}
		return undefined
	}
}

function normalisePath(p: string): string {
	return p.replaceAll('\\', '/')
}
