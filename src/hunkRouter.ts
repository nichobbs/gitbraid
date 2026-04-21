import util from 'node:util'
import child_process from 'node:child_process'
import * as vscode from 'vscode'
import { log } from './channelLogger'
import { DiffEngine, DiffHunk } from './diffEngine'

const exec = util.promisify(child_process.exec)

// ─── Types ─────────────────────────────────────────────────────────────────────

/**
 * Maps a hunk index (from {@link DiffHunk.index}) to the name of the branch
 * that should receive that hunk's changes.
 */
export type HunkAssignment = Map<number, string>

/** A pair of hunk indices whose line ranges overlap in the same file. */
export interface HunkOverlap {
	hunkA: number
	hunkB: number
}

// ─── HunkRouter ────────────────────────────────────────────────────────────────

/**
 * Routes individual diff hunks to branch worktrees by generating a minimal
 * patch file and running `git apply --index` in the target worktree directory.
 *
 * Each hunk in `HunkAssignment` must correspond to a {@link DiffHunk} from the
 * **same** `getHunksForFile` call; the hunks are assumed to be in the correct
 * order and must not overlap.
 */
export class HunkRouter {

	constructor(private readonly _diffEngine: DiffEngine) {}

	// ── Public API ─────────────────────────────────────────────────────────────

	/**
	 * Route all assigned hunks in a file to their respective branch worktrees.
	 *
	 * For each branch referenced in `assignments`, this method:
	 * 1. Collects the hunks assigned to that branch.
	 * 2. Builds a self-contained unified diff patch.
	 * 3. Runs `git apply --index` inside the branch's worktree directory.
	 *
	 * @param wsRoot       Absolute path of the primary git working directory.
	 * @param relativePath File path relative to `wsRoot`.
	 * @param worktreeDirs Map of branch name → absolute worktree directory path.
	 * @param assignments  Map of hunk index → target branch name.
	 * @returns `true` if all branches applied successfully; `false` if any failed.
	 */
	async routeFile(
		wsRoot: string,
		relativePath: string,
		worktreeDirs: Map<string, string>,
		assignments: HunkAssignment,
	): Promise<boolean> {
		if (assignments.size === 0) {
			return true
		}

		const hunks = await this._diffEngine.getHunksForFile(wsRoot, relativePath)
		if (hunks.length === 0) {
			log.info('HunkRouter.routeFile: no hunks found — nothing to route')
			return true
		}

		// Reject overlapping assignments before touching any worktree
		const overlaps = this.detectOverlaps(hunks, assignments)
		if (overlaps.length > 0) {
			const pairs = overlaps.map((o) => `hunks ${o.hunkA} & ${o.hunkB}`).join(', ')
			log.error(`HunkRouter.routeFile: overlapping assignments detected — ${pairs}`)
			await vscode.window.showErrorMessage(
				`gitbraid: cannot route hunks for "${relativePath}" — overlapping assignments detected (${pairs}). ` +
				'Reassign the conflicting hunks so each line belongs to at most one branch.',
			)
			return false
		}

		// Group hunk indices by branch
		const byBranch = new Map<string, DiffHunk[]>()
		for (const [hunkIndex, branchName] of assignments) {
			const hunk = hunks[hunkIndex]
			if (!hunk) {
				log.error(`HunkRouter.routeFile: hunk index ${hunkIndex} out of range`)
				continue
			}
			const list = byBranch.get(branchName) ?? []
			list.push(hunk)
			byBranch.set(branchName, list)
		}

		let allSucceeded = true
		for (const [branchName, branchHunks] of byBranch) {
			const worktreeDir = worktreeDirs.get(branchName)
			if (!worktreeDir) {
				log.error(`HunkRouter.routeFile: no worktree directory for branch "${branchName}"`)
				allSucceeded = false
				continue
			}

			const patch = this._buildPatch(branchHunks)
			const success = await this._applyPatch(patch, worktreeDir)
			if (!success) {
				allSucceeded = false
				await vscode.window.showErrorMessage(
					`gitbraid: failed to apply ${branchHunks.length} hunk(s) to "${branchName}". ` +
					'Check the Output panel for details.',
				)
			}
		}

		return allSucceeded
	}

	/**
	 * Detect overlapping hunk assignments within the same file.
	 *
	 * Two hunks overlap when they are assigned to **different** branches and
	 * their new-file line ranges intersect.  Hunks assigned to the same branch
	 * are considered intentional and are NOT reported.
	 *
	 * @param hunks       The full hunk list for the file (from DiffEngine).
	 * @param assignments Current assignments for those hunks.
	 */
	detectOverlaps(hunks: DiffHunk[], assignments: HunkAssignment): HunkOverlap[] {
		const overlaps: HunkOverlap[] = []
		const assignedHunks = hunks.filter((h) => assignments.has(h.index))

		for (let i = 0; i < assignedHunks.length; i++) {
			const a = assignedHunks[i]
			const branchA = assignments.get(a.index)
			for (let j = i + 1; j < assignedHunks.length; j++) {
				const b = assignedHunks[j]
				const branchB = assignments.get(b.index)
				if (branchA === branchB) {
					continue
				}
				if (this._rangesOverlap(a.startLine, a.endLine, b.startLine, b.endLine)) {
					overlaps.push({ hunkA: a.index, hunkB: b.index })
				}
			}
		}

		return overlaps
	}

	// ── Private helpers ────────────────────────────────────────────────────────

	/**
	 * Build a valid unified diff patch string from the given hunks.
	 *
	 * Each {@link DiffHunk.patch} already includes the file header, so we
	 * de-duplicate the header and concatenate only the hunk bodies.
	 */
	private _buildPatch(hunks: DiffHunk[]): string {
		if (hunks.length === 0) {
			return ''
		}
		// All hunks share the same file header — take it from the first hunk
		const firstPatch = hunks[0].patch
		const headerEnd = firstPatch.indexOf('@@ ')
		const fileHeader = headerEnd > 0 ? firstPatch.slice(0, headerEnd) : ''

		const hunkBodies = [...hunks]
			.sort((a, b) => a.startLine - b.startLine)
			.map((h) => {
				const bodyStart = h.patch.indexOf('@@ ')
				return bodyStart >= 0 ? h.patch.slice(bodyStart) : h.patch
			})
			.join('')

		return fileHeader + hunkBodies
	}

	/**
	 * Apply a patch string inside a worktree directory using `git apply --index`.
	 * Returns `true` on success, `false` on failure.
	 */
	private async _applyPatch(patch: string, worktreeDir: string): Promise<boolean> {
		if (!patch.trim()) {
			return true
		}
		log.info(`HunkRouter._applyPatch: applying patch in ${worktreeDir}`)
		try {
			const child = child_process.spawn('git', ['apply', '--index', '-'], {
				cwd: worktreeDir,
				stdio: ['pipe', 'pipe', 'pipe'],
			})
			return await new Promise<boolean>((resolve) => {
				let stderr = ''
				child.stderr.on('data', (chunk: Buffer) => {
					stderr += chunk.toString()
				})
				child.stdin.write(patch)
				child.stdin.end()
				child.on('close', (code) => {
					if (code === 0) {
						log.info('HunkRouter._applyPatch: success')
						resolve(true)
					} else {
						log.error(`git apply failed (code ${String(code)}): ${stderr}`)
						resolve(false)
					}
				})
			})
		} catch (err) {
			log.error(`HunkRouter._applyPatch error: ${String(err)}`)
			return false
		}
	}

	private _rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
		return startA <= endB && startB <= endA
	}
}
