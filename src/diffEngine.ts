import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { log } from './channelLogger'
import { requireInside } from './pathGuard'
import { IGitRunner, getDefaultGitRunner } from './gitRunner'

/** LRU cap on the DiffEngine hunk cache. */
const HUNK_CACHE_MAX = 32

interface CachedHunks {
	hunks: DiffHunk[]
	mtimeMs: number
}

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
		// A pure deletion has newCount === 0; represent it as an empty range
		// (endLine < startLine) so overlap detection doesn't falsely claim the
		// hunk collides with the next line.
		const endLine = newCount === 0 ? currentStart - 1 : currentStart + newCount - 1
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
 *
 * Git is invoked via the injected {@link IGitRunner} (spawn with
 * `shell: false` by default), so path and ref arguments never touch a shell.
 */
export class DiffEngine {

	/** LRU cache keyed by `${wsRoot}::${relativePath}` (T53). */
	private readonly _hunkCache = new Map<string, CachedHunks>()

	/**
	 * @param runner  Optional git runner for test injection.  Defaults to the
	 *                module-level singleton returned by `getDefaultGitRunner`.
	 */
	constructor(private readonly runner: IGitRunner = getDefaultGitRunner()) {}

	// ── Public API ─────────────────────────────────────────────────────────────

	/**
	 * Return the diff hunks for a single file compared to `HEAD` in the given
	 * working directory.
	 *
	 * @param wsRoot Absolute path of the git working directory (repo or worktree).
	 * @param relativePath Path to the file relative to `wsRoot`.
	 */
	async getHunksForFile(wsRoot: string, relativePath: string): Promise<DiffHunk[]> {
		log.debug(`DiffEngine.getHunksForFile: ${relativePath} in ${wsRoot}`)
		requireInside(wsRoot, relativePath)
		const safe = this._normalisePath(relativePath)

		const cacheKey = `${wsRoot}::${safe}`
		const absPath = path.join(wsRoot, safe)
		const cached = this._hunkCache.get(cacheKey)

		// Cache hit only if the on-disk mtime still matches what we cached.
		// The mtime check always runs on every call — a stat() is cheap
		// enough that skipping it for a short window after the cache was
		// filled isn't worth the risk of serving stale hunks (and therefore
		// misrouting a patch) to a save that lands soon after the previous
		// one, which happens routinely with format-on-save or a quick
		// follow-up edit.
		if (cached) {
			try {
				const st = await fsp.stat(absPath)
				if (st.mtimeMs === cached.mtimeMs) {
					this._hunkCache.delete(cacheKey)
					this._hunkCache.set(cacheKey, cached)
					return cached.hunks
				}
			} catch {
				// File missing — fall through and let git report the truth.
			}
		}

		const { stdout, exitCode, stderr } = await this.runner.run(
			['diff', 'HEAD', '--', safe],
			{ cwd: wsRoot },
		)
		if (exitCode !== 0) {
			log.error(`DiffEngine.getHunksForFile: git diff exited ${String(exitCode)}: ${stderr}`)
			return []
		}
		const hunks = parseDiffHunks(stdout)

		let mtimeMs = 0
		try { mtimeMs = (await fsp.stat(absPath)).mtimeMs } catch { /* ignore */ }
		if (this._hunkCache.size >= HUNK_CACHE_MAX) {
			const oldest = this._hunkCache.keys().next().value
			if (oldest !== undefined) this._hunkCache.delete(oldest)
		}
		this._hunkCache.set(cacheKey, { hunks, mtimeMs })
		return hunks
	}

	/** Drop cached diff output for a specific file. */
	invalidateCache(wsRoot: string, relativePath: string): void {
		const safe = this._normalisePath(relativePath)
		this._hunkCache.delete(`${wsRoot}::${safe}`)
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
		requireInside(wsRoot, relativePath)
		const mergeBase = await this.getMergeBase(wsRoot, 'HEAD', branch)
		if (!mergeBase) {
			return this.getHunksForFile(wsRoot, relativePath)
		}
		const safe = this._normalisePath(relativePath)
		const { stdout, exitCode, stderr } = await this.runner.run(
			['diff', mergeBase, '--', safe],
			{ cwd: wsRoot },
		)
		if (exitCode !== 0) {
			log.error(`DiffEngine.getHunksAgainstBranch: git diff exited ${String(exitCode)}: ${stderr}`)
			return []
		}
		return parseDiffHunks(stdout)
	}

	/**
	 * Return the merge-base commit SHA for two refs, or `undefined` on failure.
	 */
	async getMergeBase(wsRoot: string, ref1: string, ref2: string): Promise<string | undefined> {
		log.info(`DiffEngine.getMergeBase: ${ref1} ${ref2} in ${wsRoot}`)
		const { stdout, exitCode } = await this.runner.run(
			['merge-base', ref1, ref2],
			{ cwd: wsRoot },
		)
		if (exitCode !== 0) {
			log.debug(`DiffEngine.getMergeBase: no common ancestor for ${ref1} and ${ref2}`)
			return undefined
		}
		return stdout.trim() || undefined
	}

	// ── Private helpers ────────────────────────────────────────────────────────

	/**
	 * Normalise slashes and strip leading `../` segments.  Shell-metacharacter
	 * rejection is now redundant (args are passed through `spawn` as argv so
	 * the shell never sees them), but we keep the `pathGuard.requireInside`
	 * call at the public entry points to block filesystem escapes.
	 */
	private _normalisePath(relativePath: string): string {
		return path.normalize(relativePath).replace(/^(\.\.\/|\.\.\\)+/, '')
	}
}
