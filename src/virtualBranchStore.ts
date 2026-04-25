import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { log } from './channelLogger'

const WORKTREES_DIR = '.worktrees'
const VIRTUAL_DIR = 'virtual'
/**
 * Files larger than this are truncated with a warning rather than round-tripped
 * through the JSONL log.  Virtual branches are meant for in-progress work; a
 * 10 MB asset landing here almost certainly signals a misconfiguration (think
 * committed videos or sqlite dumps).
 */
const MAX_FILE_BYTES = 10 * 1024 * 1024

/** One entry per file mutation.  `content` is absent for deletions. */
export interface VirtualFileEntry {
	/** Workspace-relative path (forward slashes). */
	path: string
	/** Base64-encoded content.  Absent / empty string marks a deletion. */
	contentBase64?: string
	/** ms-epoch timestamp of the mutation. */
	ts: number
	/** When true this entry represents a deletion. */
	deleted?: boolean
}

/**
 * In-memory state for a single virtual branch: latest known content for every
 * path the branch has ever touched this session, plus a set of paths that were
 * deleted on the branch (so the materialiser knows to skip them).
 */
interface VirtualBranchState {
	files: Map<string, Uint8Array>
	deleted: Set<string>
}

/**
 * Append-only JSONL-backed store for virtual branches.
 *
 * Each virtual branch gets its own file at
 * `.worktrees/virtual/<dirSlug>.jsonl`.  Every save on a virtual-assigned file
 * appends one line; compaction happens lazily when the log exceeds a fixed
 * multiple of the live working set.
 *
 * The store is crash-safe by virtue of being append-only — an interrupted
 * write at worst discards the in-flight line, never corrupts previous
 * mutations.  See `docs/plans/08-virtual-branches.md#data-model`.
 */
export class VirtualBranchStore implements vscode.Disposable {

	private _workspaceRoot: vscode.Uri | undefined
	private readonly _state = new Map<string, VirtualBranchState>()
	/** Count of appended lines per branch — compaction trigger. */
	private readonly _appendCount = new Map<string, number>()
	/**
	 * Branch-scoped write mutex.  Ensures concurrent `writeFile` / `deleteFile`
	 * calls for the same branch don't interleave appendFile/compact operations.
	 */
	private readonly _writeLocks = new Map<string, Promise<void>>()
	private _loaded = false

	dispose(): void {
		this._state.clear()
		this._appendCount.clear()
		this._writeLocks.clear()
	}

	// ─── Lifecycle ───────────────────────────────────────────────────────────

	/**
	 * Load known virtual branches' JSONL files into memory.
	 *
	 * The caller supplies the list of branch names from `ConfigService` — the
	 * encoded filename slug is lossy (slashes become dashes) so we can't
	 * reliably recover branch names from disk alone.  Unknown JSONL files
	 * under `.worktrees/virtual/` are left untouched; they'll be pruned when
	 * their matching branch name is passed to `removeBranch`.
	 */
	async load(workspaceRoot: vscode.Uri, branches: readonly string[] = []): Promise<void> {
		this._workspaceRoot = workspaceRoot
		this._state.clear()
		this._appendCount.clear()
		const virtualDir = this._virtualDir()
		if (!virtualDir) return
		if (!fs.existsSync(virtualDir)) {
			this._loaded = true
			return
		}
		for (const branch of branches) {
			const file = this._fileForBranch(branch)
			if (!file || !fs.existsSync(file)) continue
			await this._loadBranchFile(branch, file)
		}
		this._loaded = true
		log.info(`VirtualBranchStore: loaded ${this._state.size} virtual branch(es)`)
	}

	/** Has `load()` completed?  Used by tests to assert initialisation order. */
	get isLoaded(): boolean { return this._loaded }

	// ─── Queries ─────────────────────────────────────────────────────────────

	/** List branches that have at least one recorded entry in the store. */
	listBranches(): string[] {
		return [...this._state.keys()]
	}

	/** List the workspace-relative paths currently tracked for `branch`. */
	listFiles(branch: string): string[] {
		const state = this._state.get(branch)
		if (!state) return []
		return [...state.files.keys()]
	}

	/** Is `relativePath` currently tracked (i.e. not deleted) on `branch`? */
	hasFile(branch: string, relativePath: string): boolean {
		const key = normalisePath(relativePath)
		const state = this._state.get(branch)
		if (!state) return false
		return state.files.has(key)
	}

	/** Return the latest recorded content for `relativePath` on `branch`, or `undefined`. */
	readFile(branch: string, relativePath: string): Uint8Array | undefined {
		const key = normalisePath(relativePath)
		const state = this._state.get(branch)
		if (!state) return undefined
		return state.files.get(key)
	}

	/** Is the path recorded as deleted on this branch? */
	isDeleted(branch: string, relativePath: string): boolean {
		const key = normalisePath(relativePath)
		return this._state.get(branch)?.deleted.has(key) ?? false
	}

	// ─── Mutations ───────────────────────────────────────────────────────────

	/** Record that `relativePath` has content `content` on `branch`. */
	async writeFile(branch: string, relativePath: string, content: Uint8Array): Promise<void> {
		if (content.byteLength > MAX_FILE_BYTES) {
			log.warn(`VirtualBranchStore: skipping ${relativePath} on "${branch}" (${String(content.byteLength)} bytes > ${String(MAX_FILE_BYTES)})`)
			return
		}
		await this._withLock(branch, async () => {
			const key = normalisePath(relativePath)
			const state = this._stateFor(branch)
			state.files.set(key, content)
			state.deleted.delete(key)
			await this._appendEntry(branch, {
				path: key,
				contentBase64: Buffer.from(content).toString('base64'),
				ts: Date.now(),
			})
		})
	}

	/** Record that `relativePath` has been deleted on `branch`. */
	async deleteFile(branch: string, relativePath: string): Promise<void> {
		await this._withLock(branch, async () => {
			const key = normalisePath(relativePath)
			const state = this._stateFor(branch)
			state.files.delete(key)
			state.deleted.add(key)
			await this._appendEntry(branch, {
				path: key,
				deleted: true,
				ts: Date.now(),
			})
		})
	}

	/** Drop every entry for `branch` from memory AND disk. */
	async removeBranch(branch: string): Promise<void> {
		this._state.delete(branch)
		this._appendCount.delete(branch)
		const filePath = this._fileForBranch(branch)
		if (!filePath) return
		try {
			await fs.promises.unlink(filePath)
		} catch (e) {
			const err = e as NodeJS.ErrnoException
			if (err.code !== 'ENOENT') {
				log.warn(`VirtualBranchStore.removeBranch: ${err.message}`)
			}
		}
	}

	/** Rename a virtual branch's store (used when the branch itself is renamed). */
	async renameBranch(oldName: string, newName: string): Promise<void> {
		if (oldName === newName) return
		const state = this._state.get(oldName)
		if (state) {
			this._state.set(newName, state)
			this._state.delete(oldName)
		}
		const count = this._appendCount.get(oldName) ?? 0
		this._appendCount.delete(oldName)
		this._appendCount.set(newName, count)
		const oldPath = this._fileForBranch(oldName)
		const newPath = this._fileForBranch(newName)
		if (oldPath && newPath && fs.existsSync(oldPath)) {
			await fs.promises.mkdir(path.dirname(newPath), { recursive: true })
			await fs.promises.rename(oldPath, newPath)
		}
	}

	// ─── Private helpers ─────────────────────────────────────────────────────

	private _stateFor(branch: string): VirtualBranchState {
		let state = this._state.get(branch)
		if (!state) {
			state = { files: new Map(), deleted: new Set() }
			this._state.set(branch, state)
		}
		return state
	}

	private async _withLock(branch: string, task: () => Promise<void>): Promise<void> {
		const prev = this._writeLocks.get(branch) ?? Promise.resolve()
		const next = prev.then(task, task)
		this._writeLocks.set(branch, next.catch(() => undefined))
		await next
	}

	private async _appendEntry(branch: string, entry: VirtualFileEntry): Promise<void> {
		const file = this._fileForBranch(branch)
		if (!file) return
		await fs.promises.mkdir(path.dirname(file), { recursive: true })
		const line = JSON.stringify(entry) + '\n'
		await fs.promises.appendFile(file, line, 'utf-8')
		const count = (this._appendCount.get(branch) ?? 0) + 1
		this._appendCount.set(branch, count)
		// Compact when the log grows to more than 2x the live working-set size.
		// Keeps the log bounded without compacting on every write (which would
		// defeat the append-only advantage).
		const live = this._state.get(branch)?.files.size ?? 0
		if (count > 16 && count > live * 2) {
			await this._compact(branch)
		}
	}

	private async _compact(branch: string): Promise<void> {
		const file = this._fileForBranch(branch)
		if (!file) return
		const state = this._state.get(branch)
		if (!state) return
		const tmp = file + '.tmp'
		const lines: string[] = []
		for (const [p, content] of state.files) {
			lines.push(JSON.stringify({
				path: p,
				contentBase64: Buffer.from(content).toString('base64'),
				ts: Date.now(),
			}))
		}
		for (const p of state.deleted) {
			lines.push(JSON.stringify({ path: p, deleted: true, ts: Date.now() }))
		}
		await fs.promises.writeFile(tmp, lines.join('\n') + (lines.length > 0 ? '\n' : ''), 'utf-8')
		await fs.promises.rename(tmp, file)
		this._appendCount.set(branch, lines.length)
		log.info(`VirtualBranchStore: compacted "${branch}" (${String(lines.length)} entries)`)
	}

	private async _loadBranchFile(branch: string, filePath: string): Promise<void> {
		let raw: string
		try {
			raw = await fs.promises.readFile(filePath, 'utf-8')
		} catch (e) {
			log.warn(`VirtualBranchStore: could not read ${filePath}: ${e instanceof Error ? e.message : String(e)}`)
			return
		}
		const state = this._stateFor(branch)
		let count = 0
		for (const rawLine of raw.split('\n')) {
			const line = rawLine.trim()
			if (!line) continue
			count++
			let entry: VirtualFileEntry
			try {
				entry = JSON.parse(line) as VirtualFileEntry
			} catch {
				// Skip malformed lines — append-only log may have a truncated
				// tail after a crash.  Previous entries are still valid.
				continue
			}
			if (!entry.path) continue
			const key = normalisePath(entry.path)
			if (entry.deleted) {
				state.files.delete(key)
				state.deleted.add(key)
				continue
			}
			if (typeof entry.contentBase64 !== 'string') continue
			try {
				state.files.set(key, Buffer.from(entry.contentBase64, 'base64'))
				state.deleted.delete(key)
			} catch {
				// Ignore malformed base64 payloads.
			}
		}
		this._appendCount.set(branch, count)
	}

	private _virtualDir(): string | undefined {
		if (!this._workspaceRoot) return undefined
		return path.join(this._workspaceRoot.fsPath, WORKTREES_DIR, VIRTUAL_DIR)
	}

	private _fileForBranch(branch: string): string | undefined {
		const dir = this._virtualDir()
		if (!dir) return undefined
		return path.join(dir, encodeBranchToFilename(branch) + '.jsonl')
	}
}

// ─── Filename encoding ───────────────────────────────────────────────────────

/**
 * Build a collision-proof filename fragment for a branch name, mirroring the
 * slug+hash pattern used by {@link branchToWorktreeDirName}.
 */
export function encodeBranchToFilename(branch: string): string {
	const slug = branch.replaceAll('/', '-').replaceAll(/[^a-zA-Z0-9._-]/g, '_')
	const suffix = crypto.createHash('sha1').update(branch).digest('hex').slice(0, 7)
	return `${slug}__${suffix}`
}

function normalisePath(p: string): string {
	return p.replaceAll('\\', '/')
}
