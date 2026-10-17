import path from 'node:path'
import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { log } from './channelLogger'
import { requireInside } from './pathGuard'
import { IGitRunner, getDefaultGitRunner } from './gitRunner'

/** Default LRU cap on cached files (count). */
export const DEFAULT_HUNK_CACHE_ENTRIES = 256
/** Default cap on the total size of cached patch text, in bytes. */
export const DEFAULT_HUNK_CACHE_BYTES = 16 * 1024 * 1024
/**
 * Files up to this size are hashed on every lookup, so a cache hit never
 * depends on mtime at all.  Larger files reuse a previous hash when their
 * mtime and size are unchanged (and old enough to be trustworthy; see
 * {@link RACY_WINDOW_MS}), because reading them every time costs more.
 */
const ALWAYS_HASH_BELOW_BYTES = 1024 * 1024
/**
 * A file modified within this window of "now" can be rewritten without its
 * mtime changing visibly (coarse filesystem timestamps), so its stamp is not
 * trusted.  The same "racy" rule git applies to its index.
 */
const RACY_WINDOW_MS = 2000

/**
 * A cached diff is valid only for the exact inputs it was computed from:
 * the commit `HEAD` pointed at, and the working file's content.
 */
interface CachedHunks {
	hunks: DiffHunk[]
	headId: string
	contentHash: string
	bytes: number
}

/** Remembered hash of a large file, reusable while mtime and size match. */
interface FileStamp {
	mtimeMs: number
	size: number
	hash: string
}

export interface DiffEngineOptions {
	/** Max cached files.  Default {@link DEFAULT_HUNK_CACHE_ENTRIES}. */
	maxEntries?: number
	/** Max total patch bytes held.  Default {@link DEFAULT_HUNK_CACHE_BYTES}. */
	maxBytes?: number
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

	/**
	 * LRU of diffs keyed by `${wsRoot}::${path}`.  Each entry records the HEAD
	 * and content it was computed from and is used only if both still match, so
	 * it stays correct without anyone having to invalidate it.
	 */
	private readonly _hunkCache = new Map<string, CachedHunks>()
	private _cachedBytes = 0
	/** Hashes of large files, reusable while their mtime and size are unchanged. */
	private readonly _stamps = new Map<string, FileStamp>()
	/** In-flight `rev-parse HEAD` per root, so concurrent lookups share one process. */
	private readonly _headLookups = new Map<string, Promise<string>>()
	private readonly _maxEntries: number
	private readonly _maxBytes: number

	/**
	 * @param runner  Optional git runner for test injection.  Defaults to the
	 *                module-level singleton returned by `getDefaultGitRunner`.
	 */
	constructor(
		private readonly runner: IGitRunner = getDefaultGitRunner(),
		opts: DiffEngineOptions = {},
	) {
		this._maxEntries = Math.max(1, opts.maxEntries ?? DEFAULT_HUNK_CACHE_ENTRIES)
		this._maxBytes = Math.max(1, opts.maxBytes ?? DEFAULT_HUNK_CACHE_BYTES)
	}

	// ── Public API ─────────────────────────────────────────────────────────────

	/**
	 * Return the diff hunks for a single file compared to `HEAD` in the given
	 * working directory.
	 *
	 * Results are cached against the `HEAD` commit and the file's content (not
	 * its mtime): touching a file without changing it is a cache hit, and moving
	 * `HEAD` (commit, rebase, checkout) is a miss even if the file is untouched.
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

		const [headId, contentHash] = await Promise.all([this._headId(wsRoot), this._contentHash(absPath)])
		const cached = this._lookup(cacheKey, headId, contentHash)
		if (cached) return cached

		const { stdout, exitCode, stderr } = await this.runner.run(
			['diff', 'HEAD', '--', safe],
			{ cwd: wsRoot },
		)
		if (exitCode !== 0) {
			log.error(`DiffEngine.getHunksForFile: git diff exited ${String(exitCode)}: ${stderr}`)
			return []
		}
		const hunks = parseDiffHunks(stdout)
		await this._store(cacheKey, absPath, headId, contentHash, hunks)
		return hunks
	}

	/**
	 * Hunks for several files at once, keyed by the paths as passed in.  Files
	 * already cached are served from the cache; the rest share a single
	 * `git diff` process.  Equivalent to calling {@link getHunksForFile} for
	 * each path, with fewer processes.
	 */
	async getHunksForFiles(wsRoot: string, relativePaths: readonly string[]): Promise<Map<string, DiffHunk[]>> {
		const result = new Map<string, DiffHunk[]>()
		const unique = [...new Set(relativePaths)]
		for (const rel of unique) requireInside(wsRoot, rel)

		const headId = await this._headId(wsRoot)
		const misses: Array<{ rel: string, safe: string, key: string, abs: string, hash: string | undefined }> = []
		await Promise.all(unique.map(async (rel) => {
			const safe = this._normalisePath(rel)
			const key = `${wsRoot}::${safe}`
			const abs = path.join(wsRoot, safe)
			const hash = await this._contentHash(abs)
			const cached = this._lookup(key, headId, hash)
			if (cached) result.set(rel, cached)
			else misses.push({ rel, safe, key, abs, hash })
		}))
		if (misses.length === 0) return result

		const split = misses.length > 1
			? await this._batchDiff(wsRoot, misses.map((m) => m.safe))
			: undefined
		for (const m of misses) {
			let hunks = split?.get(m.safe)
			if (hunks === undefined) {
				// Single file, or the batch output could not be matched to this path:
				// ask git about it directly.
				const one = await this.runner.run(['diff', 'HEAD', '--', m.safe], { cwd: wsRoot })
				if (one.exitCode !== 0) {
					log.error(`DiffEngine.getHunksForFiles: git diff exited ${String(one.exitCode)}: ${one.stderr}`)
					result.set(m.rel, [])
					continue
				}
				hunks = parseDiffHunks(one.stdout)
			}
			await this._store(m.key, m.abs, headId, m.hash, hunks)
			result.set(m.rel, hunks)
		}
		return result
	}

	/**
	 * Drop cached diff output for a specific file.  Never required for
	 * correctness (entries are validated against HEAD and content on every
	 * lookup); kept to release memory early.
	 */
	invalidateCache(wsRoot: string, relativePath: string): void {
		const safe = this._normalisePath(relativePath)
		this._evict(`${wsRoot}::${safe}`)
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

	/** The commit `HEAD` points at, or `'none'` if there is none yet. */
	private async _headId(wsRoot: string): Promise<string> {
		// No time-based reuse: HEAD can move at any moment (commit, rebase,
		// checkout) and a stale id would make a stale diff look valid.
		const direct = await this._readHeadDirect(wsRoot)
		if (direct) return direct
		// Anything unusual (reftable, no .git at this level, an unborn branch):
		// ask git. Only lookups already in flight are shared.
		let pending = this._headLookups.get(wsRoot)
		if (!pending) {
			pending = this.runner.run(['rev-parse', 'HEAD'], { cwd: wsRoot })
				.then((r) => (r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : 'none'))
				.finally(() => { this._headLookups.delete(wsRoot) })
			this._headLookups.set(wsRoot, pending)
		}
		return pending
	}

	/**
	 * Resolve `HEAD` by reading `.git/HEAD` and the ref it names, without
	 * starting a git process (a few small file reads instead of a spawn on every
	 * lookup).  Returns `undefined` for anything it does not fully understand, so
	 * the caller can ask git.  Handles a normal repository, a linked worktree
	 * (`.git` file, refs in the common dir), a detached HEAD, loose refs and
	 * `packed-refs`.
	 */
	private async _readHeadDirect(wsRoot: string): Promise<string | undefined> {
		const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
		try {
			const dotGit = path.join(wsRoot, '.git')
			const st = await fsp.stat(dotGit)
			let gitDir = dotGit
			if (st.isFile()) {
				const m = /^gitdir:\s*(.+?)\s*$/m.exec(await fsp.readFile(dotGit, 'utf-8'))
				if (!m) return undefined
				gitDir = path.resolve(wsRoot, m[1])
			} else if (!st.isDirectory()) {
				return undefined
			}

			const head = (await fsp.readFile(path.join(gitDir, 'HEAD'), 'utf-8')).trim()
			if (OID.test(head)) return head // detached
			const ref = /^ref:\s*(\S+)$/.exec(head)?.[1]
			if (!ref) return undefined

			// A linked worktree keeps HEAD in its own dir but branches in the main one.
			let commonDir = gitDir
			try {
				commonDir = path.resolve(gitDir, (await fsp.readFile(path.join(gitDir, 'commondir'), 'utf-8')).trim())
			} catch { /* not a linked worktree */ }

			for (const dir of commonDir === gitDir ? [gitDir] : [gitDir, commonDir]) {
				try {
					const loose = (await fsp.readFile(path.join(dir, ref), 'utf-8')).trim()
					return OID.test(loose) ? loose : undefined // a symbolic ref chain: let git resolve it
				} catch { /* not a loose ref here */ }
			}
			const packed = await fsp.readFile(path.join(commonDir, 'packed-refs'), 'utf-8').catch(() => '')
			for (const line of packed.split('\n')) {
				if (line.startsWith('#') || line.startsWith('^')) continue
				const sp = line.indexOf(' ')
				if (sp > 0 && line.slice(sp + 1).trim() === ref && OID.test(line.slice(0, sp))) return line.slice(0, sp)
			}
			return undefined // unborn branch, reftable, or something else: ask git
		} catch {
			return undefined
		}
	}

	/**
	 * A hash identifying the file's current content, `'missing'` if it does not
	 * exist, or `undefined` if it cannot be read (in which case the result is
	 * not cached).
	 */
	private async _contentHash(absPath: string): Promise<string | undefined> {
		let st: import('node:fs').Stats
		try {
			st = await fsp.stat(absPath)
		} catch {
			return 'missing'
		}
		if (!st.isFile()) return 'missing'
		const stamp = this._stamps.get(absPath)
		const trustworthy = Date.now() - st.mtimeMs > RACY_WINDOW_MS
		if (st.size > ALWAYS_HASH_BELOW_BYTES && stamp && trustworthy
			&& stamp.mtimeMs === st.mtimeMs && stamp.size === st.size) {
			return stamp.hash
		}
		try {
			const hash = createHash('sha1').update(await fsp.readFile(absPath)).digest('hex')
			if (st.size > ALWAYS_HASH_BELOW_BYTES) this._stamps.set(absPath, { mtimeMs: st.mtimeMs, size: st.size, hash })
			else this._stamps.delete(absPath)
			return hash
		} catch {
			return undefined
		}
	}

	private _lookup(key: string, headId: string, contentHash: string | undefined): DiffHunk[] | undefined {
		const cached = this._hunkCache.get(key)
		if (!cached || contentHash === undefined) return undefined
		if (cached.headId !== headId || cached.contentHash !== contentHash) return undefined
		this._hunkCache.delete(key) // refresh recency
		this._hunkCache.set(key, cached)
		return cached.hunks
	}

	/**
	 * Cache `hunks` for the inputs they were computed from.  Not cached if the
	 * file changed while git was reading it: the hunks may reflect content newer
	 * than `contentHash`, and filing them under the older hash could later serve
	 * them for the wrong content.
	 */
	private async _store(
		key: string,
		absPath: string,
		headId: string,
		contentHash: string | undefined,
		hunks: DiffHunk[],
	): Promise<void> {
		if (contentHash === undefined) return
		if (await this._contentHash(absPath) !== contentHash) return
		this._evict(key)
		const bytes = hunks.reduce((n, h) => n + h.patch.length + h.header.length, 0) + 128
		if (bytes > this._maxBytes) return
		this._hunkCache.set(key, { hunks, headId, contentHash, bytes })
		this._cachedBytes += bytes
		while (this._hunkCache.size > this._maxEntries || this._cachedBytes > this._maxBytes) {
			const oldest = this._hunkCache.keys().next().value
			if (oldest === undefined) break
			this._evict(oldest)
		}
	}

	private _evict(key: string): void {
		const existing = this._hunkCache.get(key)
		if (!existing) return
		this._hunkCache.delete(key)
		this._cachedBytes -= existing.bytes
	}

	/**
	 * One `git diff` for several paths, split back into per-path hunks.  Returns
	 * `undefined` if git failed or its output cannot be matched confidently to the
	 * requested paths (for example, names git quotes), so the caller falls back to
	 * asking about each path individually.
	 *
	 * A path with no changes simply has no section in the output, so it maps to `[]`.
	 */
	private async _batchDiff(wsRoot: string, safePaths: string[]): Promise<Map<string, DiffHunk[]> | undefined> {
		const { stdout, exitCode, stderr } = await this.runner.run(
			['diff', 'HEAD', '--no-renames', '--', ...safePaths],
			{ cwd: wsRoot },
		)
		if (exitCode !== 0) {
			log.warn(`DiffEngine batch diff exited ${String(exitCode)}: ${stderr}`)
			return undefined
		}
		// git prints forward slashes whatever the platform's separator is.
		const bySlashPath = new Map(safePaths.map((p) => [p.replaceAll('\\', '/'), p]))
		const out = new Map<string, DiffHunk[]>(safePaths.map((p) => [p, []]))

		const sections: string[] = []
		for (const line of stdout.split('\n')) {
			if (line.startsWith('diff --git ')) sections.push(line)
			else if (sections.length > 0) sections[sections.length - 1] += '\n' + line
		}
		for (const section of sections) {
			const header = section.slice(0, section.indexOf('\n') === -1 ? undefined : section.indexOf('\n'))
			const match = [...bySlashPath.entries()].find(([slash]) => header === `diff --git a/${slash} b/${slash}`)
			if (!match) return undefined
			out.set(match[1], parseDiffHunks(section.endsWith('\n') ? section : section + '\n'))
		}
		return out
	}


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
