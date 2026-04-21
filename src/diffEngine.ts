import util from 'node:util'
import child_process from 'node:child_process'
import path from 'node:path'
import { log } from './channelLogger'

const exec = util.promisify(child_process.exec)

// ─── Types ─────────────────────────────────────────────────────────────────────

/**
 * A single contiguous block of changes from a unified diff (`@@ … @@` section).
 *
 * `startLine` and `endLine` are 1-based line numbers in the **new** (current)
 * version of the file.  For a pure deletion, `endLine === startLine`.
 */
export interface DiffHunk {
	/** Zero-based index within the file's diff output (insertion order). */
	index: number
	/** 1-based first line of the hunk in the **new** file. */
	startLine: number
	/** 1-based last line of the hunk in the **new** file (inclusive). */
	endLine: number
	/** The raw `@@ -A,B +C,D @@` header, optionally with trailing context. */
	header: string
	/** The full hunk text including the header line, ready for `git apply`. */
	patch: string
}

// ─── Unified diff parser ───────────────────────────────────────────────────────

/**
 * Parse a unified diff string into an array of {@link DiffHunk}s.
 *
 * Handles the standard `git diff` format:
 * ```
 * diff --git a/foo b/foo
 * index abc..def 100644
 * --- a/foo
 * +++ b/foo
 * @@ -10,5 +10,6 @@ fn context
 *  line
 * -removed
 * +added
 * ```
 *
 * Returns an empty array for empty/whitespace-only input.
 */
export function parseDiffHunks(unifiedDiff: string): DiffHunk[] {
	if (!unifiedDiff.trim()) {
		return []
	}

	const lines = unifiedDiff.split('\n')
	const hunks: DiffHunk[] = []
	let currentHunkLines: string[] = []
	let currentHeader = ''
	let currentStart = 0
	let currentNewLineCount = 0

	const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/

	function flushHunk() {
		if (currentHunkLines.length === 0) {
			return
		}
		const newCount = currentNewLineCount
		const endLine = currentStart + Math.max(newCount - 1, 0)
		hunks.push({
			index: hunks.length,
			startLine: currentStart,
			endLine: endLine,
			header: currentHeader,
			patch: currentHunkLines.join('\n') + '\n',
		})
		currentHunkLines = []
		currentHeader = ''
		currentStart = 0
		currentNewLineCount = 0
	}

	// We need the file header lines (diff --git, index, ---, +++) to construct a
	// valid patch for `git apply`.  Collect them separately.
	const fileHeaderLines: string[] = []
	let inFileHeader = true

	for (const line of lines) {
		const hunkMatch = HUNK_HEADER.exec(line)
		if (hunkMatch) {
			flushHunk()
			inFileHeader = false
			currentHeader = line
			currentStart = Number.parseInt(hunkMatch[1], 10)
			// When the count is omitted it means 1 line.
			currentNewLineCount = hunkMatch[2] === undefined ? 1 : Number.parseInt(hunkMatch[2], 10)
			currentHunkLines.push(line)
		} else if (inFileHeader) {
			fileHeaderLines.push(line)
		} else if (currentHunkLines.length > 0) {
			currentHunkLines.push(line)
		}
	}
	flushHunk()

	// Prepend file header to every hunk patch so each slice is self-contained.
	const fileHeaderText = fileHeaderLines.join('\n') + '\n'
	return hunks.map((h) => ({ ...h, patch: fileHeaderText + h.patch }))
}

// ─── DiffEngine ────────────────────────────────────────────────────────────────

/**
 * Provides diff-hunk extraction against git references.
 *
 * All methods accept an absolute path for `wsRoot` (the workspace root or a
 * worktree root) so they can be called without needing a live `vscode.Uri`.
 */
export class DiffEngine {

	// ── Public API ─────────────────────────────────────────────────────────────

	/**
	 * Return the diff hunks for a single file compared to `HEAD` in the given
	 * working directory.
	 *
	 * @param wsRoot Absolute path of the git working directory (repo or worktree).
	 * @param relativePath Path to the file relative to `wsRoot`.
	 */
	async getHunksForFile(wsRoot: string, relativePath: string): Promise<DiffHunk[]> {
		log.info(`DiffEngine.getHunksForFile: ${relativePath} in ${wsRoot}`)
		const safeRelative = this._sanitisePath(relativePath)
		try {
			const { stdout } = await exec(
				`git diff HEAD -- "${safeRelative}"`,
				{ cwd: wsRoot },
			)
			return parseDiffHunks(stdout)
		} catch (err) {
			log.error(`DiffEngine.getHunksForFile error: ${String(err)}`)
			return []
		}
	}

	/**
	 * Return the hunks for a file compared to the merge-base of `branch` and
	 * `HEAD`.  Useful for understanding what the current branch has added since
	 * the common ancestor.
	 *
	 * @param wsRoot  Absolute path of the git working directory.
	 * @param relativePath Path to the file relative to `wsRoot`.
	 * @param branch  The branch to find the merge-base against.
	 */
	async getHunksAgainstBranch(
		wsRoot: string,
		relativePath: string,
		branch: string,
	): Promise<DiffHunk[]> {
		log.info(`DiffEngine.getHunksAgainstBranch: ${relativePath} against ${branch}`)
		const mergeBase = await this.getMergeBase(wsRoot, 'HEAD', branch)
		if (!mergeBase) {
			return this.getHunksForFile(wsRoot, relativePath)
		}
		const safeRelative = this._sanitisePath(relativePath)
		try {
			const { stdout } = await exec(
				`git diff "${mergeBase}" -- "${safeRelative}"`,
				{ cwd: wsRoot },
			)
			return parseDiffHunks(stdout)
		} catch (err) {
			log.error(`DiffEngine.getHunksAgainstBranch error: ${String(err)}`)
			return []
		}
	}

	/**
	 * Return the merge-base commit SHA for two refs, or `undefined` on failure.
	 */
	async getMergeBase(wsRoot: string, ref1: string, ref2: string): Promise<string | undefined> {
		log.info(`DiffEngine.getMergeBase: ${ref1} ${ref2} in ${wsRoot}`)
		try {
			const { stdout } = await exec(`git merge-base "${ref1}" "${ref2}"`, { cwd: wsRoot })
			const sha = stdout.trim()
			return sha || undefined
		} catch {
			log.error(`DiffEngine.getMergeBase: no common ancestor for ${ref1} and ${ref2}`)
			return undefined
		}
	}

	// ── Private helpers ────────────────────────────────────────────────────────

	/**
	 * Sanitise a relative path so it cannot escape the repository root via
	 * path traversal.  The sanitised value is safe to interpolate into a git
	 * command after being surrounded with double quotes.
	 */
	private _sanitisePath(relativePath: string): string {
		// Normalise and strip any leading '../' segments
		const normalised = path.normalize(relativePath).replace(/^(\.\.\/|\.\.\\)+/, '')
		// Escape double-quotes that appear inside the path itself
		return normalised.replaceAll('"', String.raw`"`)
	}
}
