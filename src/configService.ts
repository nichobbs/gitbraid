import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { log } from './channelLogger'
import { ConfigError } from './errors'
import {
	AssignmentChangeEvent,
	BranchConfig,
	BranchStackEntry,
	HunkAnchor,
	StackChangeEvent,
	emptyConfig,
	isValidConfig,
	migrateConfig,
} from './configTypes'

const CONFIG_FILENAME = 'local-config.json'
const WORKTREES_DIR = '.worktrees'
/** Max retries when another writer races us on local-config.json. */
const MAX_WRITE_RETRIES = 3
/** Debounce window for coalescing rapid mutations into one flush (T48). */
const FLUSH_DEBOUNCE_MS = 50

/**
 * Merge an externally-modified config with our in-memory version.  The goal
 * is "don't lose data" rather than "produce the platonically correct state":
 * we take the union of stack branches and assignments, preferring our values
 * on any key collision since they represent the user's most recent action
 * in this window.  See T21 in the remediation plan.
 */
function mergeConfigs(external: BranchConfig, ours: BranchConfig): BranchConfig {
	const stackByName = new Map<string, BranchStackEntry>()
	for (const e of external.stack) {
		stackByName.set(e.name, e)
	}
	for (const e of ours.stack) {
		stackByName.set(e.name, e)
	}
	const stack = [...stackByName.values()].sort((a, b) => a.order - b.order)
	return {
		version: Math.max(external.version ?? 0, ours.version ?? 0),
		stack,
		assignments: { ...external.assignments, ...ours.assignments },
		hunkAssignments: { ...external.hunkAssignments, ...ours.hunkAssignments },
	}
}

/**
 * Manages reading and writing `.worktrees/local-config.json`.
 *
 * The file is never committed to the repository. A missing file is treated
 * as an empty (but valid) config — not an error.
 *
 * All write operations are atomic: content is written to a `.tmp` file and
 * then renamed over the target to avoid corruption on crash.
 */
export class ConfigService implements vscode.Disposable {

	private static _instance: ConfigService | undefined

	private _config: BranchConfig = emptyConfig()
	private _configPath: string | undefined
	/**
	 * Modification time (ms epoch) observed at the last successful read.
	 * Used to detect concurrent writes from another VS Code window.
	 */
	private _lastSeenMtimeMs: number | undefined

	/** Pending flush handle — coalesces rapid mutations (T48). */
	private _flushTimer: ReturnType<typeof setTimeout> | undefined
	/** Resolves when the current flush (if any) completes. */
	private _flushPromise: Promise<void> = Promise.resolve()
	private _flushResolver: (() => void) | undefined
	private _flushRejector: ((e: unknown) => void) | undefined

	private readonly _onDidChangeAssignment = new vscode.EventEmitter<AssignmentChangeEvent>()
	private readonly _onDidChangeStack = new vscode.EventEmitter<StackChangeEvent>()

	readonly onDidChangeAssignment: vscode.Event<AssignmentChangeEvent> = this._onDidChangeAssignment.event
	readonly onDidChangeStack: vscode.Event<StackChangeEvent> = this._onDidChangeStack.event

	private constructor() {}

	static getInstance(): ConfigService {
		if (!ConfigService._instance) {
			ConfigService._instance = new ConfigService()
		}
		return ConfigService._instance
	}

	/** Reset the singleton — for use in tests only. */
	static resetInstance(): void {
		ConfigService._instance?.dispose()
		ConfigService._instance = undefined
	}

	dispose(): void {
		// Flush any pending coalesced write before tearing down the emitters.
		// Deactivate hooks can't await, so we fire-and-forget — the flush will
		// complete synchronously via its timer callback in most cases.
		if (this._flushTimer) {
			clearTimeout(this._flushTimer)
			this._flushTimer = undefined
			void this._performFlush()
		}
		this._onDidChangeAssignment.dispose()
		this._onDidChangeStack.dispose()
	}

	// ─── Initialisation ──────────────────────────────────────────────────────

	/**
	 * Load config from disk. Call once at extension activation.
	 * Subsequent writes keep the in-memory state in sync; no need to reload.
	 */
	async load(workspaceRoot: vscode.Uri): Promise<void> {
		const worktreesDir = vscode.Uri.joinPath(workspaceRoot, WORKTREES_DIR)
		this._configPath = path.join(worktreesDir.fsPath, CONFIG_FILENAME)
		this._config = await this._readFromDisk()
		log.info('ConfigService loaded (' + this._config.stack.length + ' branches, ' +
			Object.keys(this._config.assignments).length + ' assignments)')
	}

	// ─── Stack queries ────────────────────────────────────────────────────────

	/** Returns a copy of the stack entries sorted by order (ascending). */
	getStack(): BranchStackEntry[] {
		return [...this._config.stack].sort((a, b) => a.order - b.order)
	}

	getBranch(name: string): BranchStackEntry | undefined {
		return this._config.stack.find((e) => e.name === name)
	}

	// ─── Assignment queries ───────────────────────────────────────────────────

	/** Returns the branch assigned to the given workspace-relative path, or `undefined`. */
	getAssignment(relativePath: string): string | undefined {
		return this._config.assignments[normalisePath(relativePath)]
	}

	/** Returns all assignments as a map copy. */
	getAllAssignments(): Record<string, string> {
		return { ...this._config.assignments }
	}

	// ─── Hunk assignment queries ──────────────────────────────────────────────

	/**
	 * Returns the hunk-level assignment map for a file, or `undefined` if
	 * no hunk assignments have been set for that file.
	 *
	 * The returned `Map` maps `hunkIndex → branchName`.
	 */
	getHunkAssignments(relativePath: string): Map<number, string> | undefined {
		const key = normalisePath(relativePath)
		const raw = this._config.hunkAssignments?.[key]
		if (!raw || Object.keys(raw).length === 0) {
			return undefined
		}
		const result = new Map<number, string>()
		for (const [idxStr, branch] of Object.entries(raw)) {
			result.set(Number.parseInt(idxStr, 10), branch)
		}
		return result
	}

	/**
	 * Returns the workspace-relative paths of all files that have at least
	 * one hunk assignment.
	 */
	getHunkAssignedFiles(): string[] {
		return Object.keys(this._config.hunkAssignments ?? {})
	}

	// ─── Hunk assignment mutations ────────────────────────────────────────────

	/**
	 * Assign a specific hunk index in a file to a branch.
	 *
	 * The optional {@link HunkAnchor} captures the hunk's line range and body
	 * hash so the router can reconcile the assignment against the live diff
	 * at route time — even if subsequent edits have renumbered the hunks.
	 * Callers that can't compute an anchor (e.g. hand-rolled tests) may
	 * omit it; the router will treat the assignment as unanchored.
	 */
	async setHunkAssignment(
		relativePath: string,
		hunkIndex: number,
		branch: string,
		anchor?: HunkAnchor,
	): Promise<void> {
		const key = normalisePath(relativePath)
		if (!this._config.stack.some((e) => e.name === branch)) {
			throw new ConfigError(`Branch "${branch}" is not in the stack`)
		}
		if (!this._config.hunkAssignments) {
			this._config.hunkAssignments = {}
		}
		if (!this._config.hunkAssignments[key]) {
			this._config.hunkAssignments[key] = {}
		}
		this._config.hunkAssignments[key][String(hunkIndex)] = branch

		if (anchor) {
			if (!this._config.hunkAnchors) {
				this._config.hunkAnchors = {}
			}
			if (!this._config.hunkAnchors[key]) {
				this._config.hunkAnchors[key] = {}
			}
			this._config.hunkAnchors[key][String(hunkIndex)] = anchor
		}

		await this._writeToDisk()
		this._onDidChangeAssignment.fire({ relativePath: key, branch, previousBranch: undefined })
	}

	/** Retrieve the anchor for a specific hunk assignment, if one was stored. */
	getHunkAnchor(relativePath: string, hunkIndex: number): HunkAnchor | undefined {
		const key = normalisePath(relativePath)
		return this._config.hunkAnchors?.[key]?.[String(hunkIndex)]
	}

	/** Remove the assignment for a specific hunk index in a file. */
	async removeHunkAssignment(relativePath: string, hunkIndex: number): Promise<void> {
		const key = normalisePath(relativePath)
		const fileHunks = this._config.hunkAssignments?.[key]
		if (!fileHunks) {
			return
		}
		delete fileHunks[String(hunkIndex)]
		if (Object.keys(fileHunks).length === 0 && this._config.hunkAssignments) {
			delete this._config.hunkAssignments[key]
		}

		const fileAnchors = this._config.hunkAnchors?.[key]
		if (fileAnchors) {
			delete fileAnchors[String(hunkIndex)]
			if (Object.keys(fileAnchors).length === 0 && this._config.hunkAnchors) {
				delete this._config.hunkAnchors[key]
			}
		}

		await this._writeToDisk()
		this._onDidChangeAssignment.fire({ relativePath: key, branch: undefined, previousBranch: undefined })
	}

	/** Remove all hunk assignments for a file. */
	async clearHunkAssignments(relativePath: string): Promise<void> {
		const key = normalisePath(relativePath)
		let changed = false
		if (this._config.hunkAssignments?.[key]) {
			delete this._config.hunkAssignments[key]
			changed = true
		}
		if (this._config.hunkAnchors?.[key]) {
			delete this._config.hunkAnchors[key]
			changed = true
		}
		if (changed) {
			await this._writeToDisk()
			this._onDidChangeAssignment.fire({ relativePath: key, branch: undefined, previousBranch: undefined })
		}
	}

	// ─── Mutations ────────────────────────────────────────────────────────────

	async setAssignment(relativePath: string, branch: string): Promise<void> {
		const key = normalisePath(relativePath)
		if (!this._config.stack.some((e) => e.name === branch)) {
			throw new ConfigError(`Branch "${branch}" is not in the stack`)
		}
		const previous = this._config.assignments[key]
		this._config.assignments[key] = branch
		await this._writeToDisk()
		this._onDidChangeAssignment.fire({ relativePath: key, branch, previousBranch: previous })
	}

	async removeAssignment(relativePath: string): Promise<void> {
		const key = normalisePath(relativePath)
		const previous = this._config.assignments[key]
		if (previous === undefined) {
			return
		}
		delete this._config.assignments[key]
		await this._writeToDisk()
		this._onDidChangeAssignment.fire({ relativePath: key, branch: undefined, previousBranch: previous })
	}

	async addBranch(entry: Omit<BranchStackEntry, 'order'> & { order?: number }): Promise<void> {
		if (this._config.stack.some((e) => e.name === entry.name)) {
			throw new ConfigError(`Branch "${entry.name}" already exists in the stack`)
		}
		const maxOrder = this._config.stack.reduce((m, e) => Math.max(m, e.order), 0)
		const newEntry: BranchStackEntry = {
			...entry,
			order: entry.order ?? maxOrder + 1,
		}
		this._config.stack.push(newEntry)
		await this._writeToDisk()
		this._onDidChangeStack.fire({ type: 'add', branch: entry.name })
	}

	async removeBranch(name: string): Promise<void> {
		const idx = this._config.stack.findIndex((e) => e.name === name)
		if (idx === -1) {
			return
		}
		this._config.stack.splice(idx, 1)
		// Remove all file assignments for this branch
		for (const key of Object.keys(this._config.assignments)) {
			if (this._config.assignments[key] === name) {
				delete this._config.assignments[key]
			}
		}
		await this._writeToDisk()
		this._onDidChangeStack.fire({ type: 'remove', branch: name })
	}

	async reorderStack(orderedNames: string[]): Promise<void> {
		for (let i = 0; i < orderedNames.length; i++) {
			const entry = this._config.stack.find((e) => e.name === orderedNames[i])
			if (entry) {
				entry.order = i + 1
			}
		}
		await this._writeToDisk()
		this._onDidChangeStack.fire({ type: 'reorder', branch: orderedNames[0] ?? '' })
	}

	// ─── Private helpers ──────────────────────────────────────────────────────

	private async _readFromDisk(): Promise<BranchConfig> {
		if (!this._configPath) {
			return emptyConfig()
		}
		try {
			const raw = await fs.promises.readFile(this._configPath, 'utf-8')
			try {
				const stat = await fs.promises.stat(this._configPath)
				this._lastSeenMtimeMs = stat.mtimeMs
			} catch {
				this._lastSeenMtimeMs = undefined
			}
			const parsed: unknown = JSON.parse(raw)
			if (!isValidConfig(parsed)) {
				log.warn('ConfigService: config file has unexpected structure, using empty config')
				return emptyConfig()
			}
			return migrateConfig(parsed)
		} catch (e: unknown) {
			if (isNodeError(e) && e.code === 'ENOENT') {
				// Missing file is fine — user hasn't set up a stack yet
				log.info('ConfigService: no config file found, starting with empty config')
				this._lastSeenMtimeMs = undefined
				return emptyConfig()
			}
			if (e instanceof SyntaxError) {
				log.warn('ConfigService: malformed JSON in config file, using empty config: ' + e.message)
				return emptyConfig()
			}
			throw new ConfigError('Failed to read config: ' + String(e))
		}
	}

	/**
	 * Write the current in-memory config to disk atomically.
	 *
	 * Optimistic concurrency (T21): if another VS Code window writes to
	 * `local-config.json` between our last read and this write, we reload
	 * from disk, merge the external changes conservatively, and retry.
	 *
	 * Merge strategy (best-effort, non-interactive):
	 *   - Stack order: prefer the longer stack; if equal length, use ours.
	 *   - Assignments: union (our value wins on key conflict).
	 *   - Hunk assignments: union (ours wins on conflict).
	 *
	 * After {@link MAX_WRITE_RETRIES} collisions we throw `ConfigError` so
	 * the user can investigate rather than entering a retry loop.
	 */
	private _writeToDisk(): Promise<void> {
		// Coalesce rapid mutations into one on-disk flush (T48).  Multiple
		// awaited calls within FLUSH_DEBOUNCE_MS share a single write and all
		// resolve when that write completes.  The snapshot captured at flush
		// time reflects all mutations accumulated in the coalescing window.
		if (!this._flushResolver) {
			this._flushPromise = new Promise<void>((resolve, reject) => {
				this._flushResolver = () => resolve()
				this._flushRejector = reject
			})
		}
		if (this._flushTimer) {
			clearTimeout(this._flushTimer)
		}
		this._flushTimer = setTimeout(() => { void this._performFlush() }, FLUSH_DEBOUNCE_MS)
		return this._flushPromise
	}

	/**
	 * Immediately flush any pending write.  Callers that need a synchronous
	 * "the file is on disk NOW" guarantee — e.g. before extension
	 * deactivation — can await this.
	 */
	async flushPendingWrites(): Promise<void> {
		if (this._flushTimer) {
			clearTimeout(this._flushTimer)
			this._flushTimer = undefined
			await this._performFlush()
		}
	}

	private async _performFlush(): Promise<void> {
		this._flushTimer = undefined
		const resolver = this._flushResolver
		const rejector = this._flushRejector
		this._flushResolver = undefined
		this._flushRejector = undefined

		try {
			await this._writeNow()
			resolver?.()
		} catch (e) {
			rejector?.(e)
		}
	}

	private async _writeNow(): Promise<void> {
		if (!this._configPath) {
			throw new ConfigError('ConfigService not initialised — call load() first')
		}
		const dir = path.dirname(this._configPath)
		await fs.promises.mkdir(dir, { recursive: true })

		for (let attempt = 0; attempt < MAX_WRITE_RETRIES; attempt++) {
			const conflictDetected = this._detectDiskConflict()
			if (conflictDetected) {
				log.warn(`ConfigService: detected concurrent write (attempt ${String(attempt + 1)}/${String(MAX_WRITE_RETRIES)}); merging`)
				const external = await this._readFromDisk()
				this._config = mergeConfigs(external, this._config)
				continue
			}

			const content = JSON.stringify(this._config, null, 2) + '\n'
			const tmpPath = this._configPath + '.tmp'
			await fs.promises.writeFile(tmpPath, content, 'utf-8')
			await fs.promises.rename(tmpPath, this._configPath)

			try {
				const stat = await fs.promises.stat(this._configPath)
				this._lastSeenMtimeMs = stat.mtimeMs
			} catch {
				// stat failure is non-fatal
			}

			await this._ensureGitignore()
			return
		}

		throw new ConfigError(
			`Failed to write local-config.json after ${String(MAX_WRITE_RETRIES)} retries due to concurrent modification. ` +
			'Close other VS Code windows on this repository or edit the file manually.',
		)
	}

	/** Returns true if the on-disk file has been modified since our last read. */
	private _detectDiskConflict(): boolean {
		if (!this._configPath || this._lastSeenMtimeMs === undefined) {
			return false
		}
		try {
			const stat = fs.statSync(this._configPath)
			// 1 ms epsilon to tolerate filesystems with second-level resolution
			return stat.mtimeMs > this._lastSeenMtimeMs + 1
		} catch {
			return false
		}
	}

	/**
	 * Ensure `.worktrees/` appears in the repo root `.gitignore`.
	 * Creates or appends silently — this must never be committed.
	 *
	 * This is the sole writer of the `.worktrees/` entry (the duplicate in
	 * `extension.ts` was removed in T24).  Preserves the existing line-ending
	 * style so Windows repos with CRLF don't end up with mixed endings.
	 */
	private async _ensureGitignore(): Promise<void> {
		if (!this._configPath) {
			return
		}
		// Walk up from .worktrees to the workspace root
		const worktreesDir = path.dirname(this._configPath)
		const repoRoot = path.dirname(worktreesDir)
		const gitignorePath = path.join(repoRoot, '.gitignore')

		const entry = '.worktrees/'
		const MARKER = '## gitbraid: manage .worktrees/ (do not remove this line)'
		try {
			const existing = await fs.promises.readFile(gitignorePath, 'utf-8')
			if (existing.split(/\r?\n/).some((l) => l.trim() === entry || l.trim() === '.worktrees')) {
				return
			}
			// Detect CRLF vs LF line ending and match it so the file stays
			// consistent after append.
			const eol = existing.includes('\r\n') ? '\r\n' : '\n'
			const separator = existing.endsWith('\n') || existing.endsWith('\r\n') ? '' : eol
			await fs.promises.appendFile(gitignorePath, `${separator}${MARKER}${eol}${entry}${eol}`, 'utf-8')
			log.info('ConfigService: added .worktrees/ to .gitignore')
		} catch (e: unknown) {
			if (isNodeError(e) && e.code === 'ENOENT') {
				await fs.promises.writeFile(gitignorePath, `${MARKER}\n${entry}\n`, 'utf-8')
				log.info('ConfigService: created .gitignore with .worktrees/ entry')
				return
			}
			log.warn('ConfigService: could not update .gitignore: ' + String(e))
		}
	}
}

function normalisePath(p: string): string {
	return p.replace(/\\/g, '/')
}

function isNodeError(e: unknown): e is NodeJS.ErrnoException {
	return e instanceof Error && 'code' in e
}
