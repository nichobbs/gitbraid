import * as vscode from 'vscode'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { log } from './channelLogger'
import { SyncError } from './errors'
import { ConfigService } from './configService'
import { worktreePath } from './branchStackService'
import { showError } from './errorSurfacer'
import type { IFileChangeBus } from './fileChangeBus'
import { getDefaultGitRunner } from './gitRunner'

const DEFAULT_DEBOUNCE_MS = 200
/** Hard cap on `_floatingDirty` so a long-running session can't leak memory. */
const FLOATING_DIRTY_CAP = 10_000

/** Read the workspace-level syncDebounceMs with a sane fallback. */
function getDebounceMs(): number {
	const raw = vscode.workspace.getConfiguration('gitbraid').get<number>('syncDebounceMs', DEFAULT_DEBOUNCE_MS)
	if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
		return DEFAULT_DEBOUNCE_MS
	}
	return raw
}

/**
 * Watches the workspace for file saves and copies modified files to the
 * owning branch's worktree.
 *
 * - **Assigned** files are copied to their branch worktree on every save.
 * - **Floating** files (no assignment) are tracked in `_floatingDirty` for
 *   warning purposes, but are not blocked.
 *
 * A `_syncing` flag prevents re-entrant triggers from the file-system watcher
 * picking up the writes we make to the worktrees.
 */
export class WorkspaceSync implements vscode.Disposable {

	private static _instance: WorkspaceSync | undefined

	private _workspaceRoot: vscode.Uri | undefined
	private _syncing = false
	/**
	 * Set of workspace-relative paths whose most recent save produced no
	 * assignment (yet).  Capped at {@link FLOATING_DIRTY_CAP} to bound
	 * memory use — paths evicted by the cap are just forgotten; the worst
	 * case is a lost notification, not a sync error (T51).
	 */
	private readonly _floatingDirty = new Set<string>()
	private readonly _disposables: vscode.Disposable[] = []

	/** Pending debounce timer handles keyed by workspace-relative path. */
	private readonly _pending = new Map<string, ReturnType<typeof setTimeout>>()

	/**
	 * Per-file generation counter used by the bidirectional-sync loop breaker.
	 * Every primary-originated write bumps the counter; worktree-change events
	 * whose recorded generation matches the current value are ignored
	 * (they are the echo of our own write).  See T13.
	 */
	private readonly _generations = new Map<string, number>()
	/** Pending debounce timer handles for reverse-sync operations. */
	private readonly _reversePending = new Map<string, ReturnType<typeof setTimeout>>()

	private readonly _onDidSyncFile = new vscode.EventEmitter<{ relativePath: string; branch: string }>()
	readonly onDidSyncFile: vscode.Event<{ relativePath: string; branch: string }> = this._onDidSyncFile.event

	private readonly _onDidFloatFile = new vscode.EventEmitter<{ relativePath: string }>()
	readonly onDidFloatFile: vscode.Event<{ relativePath: string }> = this._onDidFloatFile.event

	/**
	 * Public constructor — each `FolderContext` creates its own instance
	 * paired with that folder's `ConfigService`.  `getInstance()` /
	 * `resetInstance()` retained for back-compat with the test suite.
	 */
	constructor(private readonly _config: ConfigService) {}

	/** Legacy singleton, retained for tests. */
	static getInstance(config?: ConfigService): WorkspaceSync {
		if (!WorkspaceSync._instance) {
			config ??= ConfigService.getInstance()
			WorkspaceSync._instance = new WorkspaceSync(config)
		}
		return WorkspaceSync._instance
	}

	/** Reset the singleton — for use in tests only. */
	static resetInstance(): void {
		WorkspaceSync._instance?.dispose()
		WorkspaceSync._instance = undefined
	}

	dispose(): void {
		// Cancel all pending debounces (forward + reverse)
		for (const timer of this._pending.values()) {
			clearTimeout(timer)
		}
		this._pending.clear()
		for (const timer of this._reversePending.values()) {
			clearTimeout(timer)
		}
		this._reversePending.clear()
		this._onDidSyncFile.dispose()
		this._onDidFloatFile.dispose()
		for (const d of this._disposables) {
			d.dispose()
		}
	}

	// ─── Initialisation ──────────────────────────────────────────────────────

	/**
	 * Begin watching the workspace. Call once at extension activation.
	 *
	 * Subscribes to the shared {@link IFileChangeBus} for file-change events
	 * instead of creating its own `FileSystemWatcher`.  The bus splits the
	 * primary save/delete channel from the worktree-change channel, so the
	 * re-entrancy guard and the bidirectional-sync path are driven from the
	 * same underlying watcher.
	 *
	 * A per-file generation counter is used to break any ping-pong between
	 * the two directions: every primary-originated write bumps the counter,
	 * worktree-originated events that would re-sync the same generation are
	 * ignored.
	 *
	 * For back-compat with existing tests the `bus` parameter is optional;
	 * if omitted, WorkspaceSync falls back to its legacy private watchers.
	 */
	init(workspaceRoot: vscode.Uri, bus?: IFileChangeBus): void {
		this._workspaceRoot = workspaceRoot

		if (bus) {
			// Shared-bus wiring (preferred): one watcher for the whole
			// extension, multiple subscribers.  See `src/fileChangeBus.ts`.
			this._disposables.push(
				bus.onDidSavePrimary((e) => this._onChanged(e.uri)),
				bus.onDidDeletePrimary((e) => this._onDeleted(e.uri)),
			)
			if (vscode.workspace.getConfiguration('gitbraid').get<boolean>('bidirectionalSync', false)) {
				this._disposables.push(
					bus.onDidChangeWorktree((e) => this._onWorktreeChanged(e.uri)),
				)
				log.info('WorkspaceSync: bidirectional sync enabled (via FileChangeBus)')
			}
			log.info('WorkspaceSync: subscribed to FileChangeBus for ' + workspaceRoot.fsPath)
		} else {
			// Fallback path — tests that construct WorkspaceSync without a
			// bus still get a working watcher.  Not used in production.
			const primary = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(workspaceRoot, '**/*'),
				false, false, false,
			)
			this._disposables.push(
				primary,
				primary.onDidChange((uri) => this._onChanged(uri)),
				primary.onDidCreate((uri) => this._onChanged(uri)),
				primary.onDidDelete((uri) => this._onDeleted(uri)),
			)
			if (vscode.workspace.getConfiguration('gitbraid').get<boolean>('bidirectionalSync', false)) {
				const wt = vscode.workspace.createFileSystemWatcher(
					new vscode.RelativePattern(workspaceRoot, '.worktrees/*/**'),
					false, false, false,
				)
				this._disposables.push(
					wt,
					wt.onDidChange((uri) => this._onWorktreeChanged(uri)),
					wt.onDidCreate((uri) => this._onWorktreeChanged(uri)),
				)
			}
			log.info('WorkspaceSync: watching ' + workspaceRoot.fsPath + ' (fallback; no bus)')
		}

		// Config-driven sync still comes from the service, not the bus.
		// Route through `_onChanged` so the debounce queue applies equally to
		// user saves and assignment-triggered syncs.
		this._disposables.push(
			this._config.onDidChangeAssignment((ev) => {
				if (ev.branch && ev.relativePath) {
					const uri = vscode.Uri.joinPath(workspaceRoot, ev.relativePath)
					this._onChanged(uri)
				}
			}),
		)

		// Seed the floating-dirty set from the current git status so that files
		// already modified before the extension loaded (or changed externally
		// without a VS Code save event) are visible in the floating list.
		void this._seedFromGitStatus(workspaceRoot)
	}

	// ─── Startup scan ────────────────────────────────────────────────────────

	/**
	 * Scan `git status` in the workspace root and seed `_floatingDirty` with
	 * any dirty files that have no branch assignment.  This covers files that
	 * were already modified before the extension loaded — the file-system
	 * watcher would never fire for those.
	 */
	private async _seedFromGitStatus(workspaceRoot: vscode.Uri): Promise<void> {
		try {
			const runner = getDefaultGitRunner()
			const { stdout, exitCode } = await runner.run(
				['status', '--porcelain=v1', '-z'],
				{ cwd: workspaceRoot.fsPath },
			)
			if (exitCode !== 0) return

			const entries = stdout.split('\0').filter((s) => s.length > 0)
			let seeded = 0
			for (const entry of entries) {
				// Valid porcelain v1 format: "XY path" — 2 status chars + space + path.
				// Rename/copy entries produce a second NUL-delimited token that is
				// just the old name without an XY prefix; the entry[2] !== ' ' guard
				// skips those.
				if (entry.length < 4 || entry[2] !== ' ') continue
				const relativePath = entry.slice(3)
				if (relativePath.startsWith('.worktrees/') || relativePath.startsWith('.git/')) continue
				// Skip files already assigned — rehideAssignedFiles handles those.
				if (this._config.getAssignment(relativePath)) continue

				const key = normalisePath(relativePath)
				if (!this._floatingDirty.has(key)) {
					if (this._floatingDirty.size >= FLOATING_DIRTY_CAP) {
						const oldest = this._floatingDirty.values().next().value
						if (oldest !== undefined) this._floatingDirty.delete(oldest)
					}
					this._floatingDirty.add(key)
					this._onDidFloatFile.fire({ relativePath: key })
					seeded++
				}
			}
			if (seeded > 0) {
				log.info(`WorkspaceSync: seeded ${seeded} pre-existing floating file(s) from git status`)
			}
		} catch (e) {
			log.warn(`WorkspaceSync._seedFromGitStatus: ${e instanceof Error ? e.message : String(e)}`)
		}
	}

	// ─── Queries ─────────────────────────────────────────────────────────────

	/** Returns true if the file currently has unsaved floating status. */
	isFloating(relativePath: string): boolean {
		return this._floatingDirty.has(normalisePath(relativePath))
	}

	/** Returns a snapshot of all currently floating dirty paths. */
	getFloatingDirty(): ReadonlyArray<string> {
		return [...this._floatingDirty]
	}

	// ─── Private event handlers ───────────────────────────────────────────────

	private _onChanged(uri: vscode.Uri): void {
		if (!this._workspaceRoot) {
			return
		}
		const rel = this._relativePath(uri)
		if (!rel || rel.startsWith('.worktrees/') || rel.startsWith('.git/')) {
			return
		}
		// A sync is in progress — re-queue so this save isn't silently dropped.
		// Track in _pending so a subsequent write for the same file can cancel
		// this retry (prevents ghost sync events after the syncing path).
		if (this._syncing) {
			const existing = this._pending.get(rel)
			if (existing) { clearTimeout(existing) }
			const retryTimer = setTimeout(() => {
				this._pending.delete(rel)
				this._onChanged(uri)
			}, getDebounceMs())
			this._pending.set(rel, retryTimer)
			return
		}

		// Debounce rapid saves
		const existing = this._pending.get(rel)
		if (existing) {
			clearTimeout(existing)
		}
		const timer = setTimeout(() => {
			this._pending.delete(rel)
			void this._handleSave(rel, uri)
		}, getDebounceMs())
		this._pending.set(rel, timer)
	}

	private _onDeleted(uri: vscode.Uri): void {
		if (!this._workspaceRoot || this._syncing) {
			return
		}
		const rel = this._relativePath(uri)
		if (!rel || rel.startsWith('.worktrees/') || rel.startsWith('.git/')) {
			return
		}
		const branch = this._config.getAssignment(rel)
		if (!branch) {
			this._floatingDirty.delete(normalisePath(rel))
			return
		}
		void this._propagateDeletion(rel, branch)
	}

	private async _handleSave(relativePath: string, uri: vscode.Uri): Promise<void> {
		// Skip gitignored files — they should never appear as floating or be synced.
		if (this._workspaceRoot) {
			try {
				const { exitCode } = await getDefaultGitRunner().run(
					['check-ignore', '-q', '--', relativePath],
					{ cwd: this._workspaceRoot.fsPath },
				)
				if (exitCode === 0) {
					// File is gitignored — clear any stale floating entry and bail.
					this._floatingDirty.delete(normalisePath(relativePath))
					return
				}
			} catch {
				// check-ignore failure is non-fatal; fall through to normal handling.
			}
		}

		const branch = this._config.getAssignment(relativePath)
		if (!branch) {
			const key = normalisePath(relativePath)
			// Bound memory (T51): evict the oldest entry once we hit the cap.
			// Set iteration order is insertion order, so `next().value` is
			// the oldest key.
			if (!this._floatingDirty.has(key) && this._floatingDirty.size >= FLOATING_DIRTY_CAP) {
				const oldest = this._floatingDirty.values().next().value
				if (oldest !== undefined) this._floatingDirty.delete(oldest)
			}
			this._floatingDirty.add(key)
			this._onDidFloatFile.fire({ relativePath: key })
			return
		}
		this._floatingDirty.delete(normalisePath(relativePath))
		// If the assigned branch has no worktree on disk (e.g. it IS the currently
		// checked-out branch whose files live in the primary workspace), the file is
		// already in the right place — no copy needed.
		if (this._workspaceRoot) {
			const wtPath = worktreePath(this._workspaceRoot, branch)
			if (!fs.existsSync(wtPath.fsPath)) {
				log.info(`WorkspaceSync: branch "${branch}" has no worktree — file stays in primary workspace`)
				return
			}
		}
		try {
			await this._syncFile(relativePath, uri, branch)
		} catch (e) {
			// Previously SyncError was thrown straight into the debounce
			// timer's `void` callback and lost; the user saw no feedback when
			// a sync silently failed.  Route through the shared surfacer so
			// the notification pattern matches the rest of the extension.
			await showError(`GitBraid: sync of ${relativePath} failed`, e)
		}
	}

	private async _syncFile(relativePath: string, uri: vscode.Uri, branch: string): Promise<void> {
		if (!this._workspaceRoot) {
			return
		}
		// Clear floating status — file is now assigned to a branch
		this._floatingDirty.delete(normalisePath(relativePath))
		const wtPath = worktreePath(this._workspaceRoot, branch)
		const destUri = vscode.Uri.joinPath(wtPath, relativePath)

		// Skip sync for files over the configured size limit to avoid reading
		// huge blobs into memory on every save (T52 in the remediation plan).
		const maxKb = vscode.workspace.getConfiguration('gitbraid').get<number>('maxSyncFileSizeKb', 10240)
		if (maxKb > 0) {
			try {
				const stat = await vscode.workspace.fs.stat(uri)
				if (stat.size > maxKb * 1024) {
					log.warn(`WorkspaceSync: skipping ${relativePath} (${Math.round(stat.size / 1024)} KB > ${maxKb} KB limit)`)
					return
				}
			} catch {
				// stat failed — file may not exist yet; fall through to read
			}
		}

		let content: Uint8Array
		try {
			content = await vscode.workspace.fs.readFile(uri)
		} catch {
			// File may have been deleted between event and read — skip
			return
		}

		// Ensure dest directory exists
		const destDir = vscode.Uri.file(path.dirname(destUri.fsPath))
		try {
			await vscode.workspace.fs.createDirectory(destDir)
		} catch {
			// Directory may already exist
		}

		this._syncing = true
		try {
			await vscode.workspace.fs.writeFile(destUri, content)
			// Bump the generation AFTER the worktree write so the upcoming
			// worktree-watcher event for this path is recognised as our own
			// echo and suppressed by `_onWorktreeChanged`.
			const genKey = normalisePath(relativePath)
			this._generations.set(genKey, (this._generations.get(genKey) ?? 0) + 1)
			log.info(`WorkspaceSync: synced ${relativePath} → ${branch}`)
			this._onDidSyncFile.fire({ relativePath: genKey, branch })
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : JSON.stringify(e)
			throw new SyncError(`Failed to sync "${relativePath}" to branch "${branch}": ${msg}`)
		} finally {
			this._syncing = false
		}
	}

	/**
	 * Bidirectional sync (T13): copy externally-made worktree edits back into
	 * the primary workspace when they actually differ from the workspace file.
	 * The generation counter prevents this path from looping with `_syncFile`.
	 */
	private _onWorktreeChanged(uri: vscode.Uri): void {
		if (!this._workspaceRoot) return
		if (this._syncing) return

		const rel = this._relativeInWorktree(uri)
		if (!rel) return
		const { branch, relativePath } = rel

		// Decrement the stored generation if this is an echo of our own write;
		// multiple worktree events can fire per write so we tolerate that too.
		const genKey = normalisePath(relativePath)
		const gen = this._generations.get(genKey)
		if (gen !== undefined && gen > 0) {
			this._generations.set(genKey, gen - 1)
			return
		}

		// Debounce reverse-sync per file so a rebase that touches many files
		// doesn't spike.
		const existing = this._reversePending.get(genKey)
		if (existing) clearTimeout(existing)
		const timer = setTimeout(() => {
			this._reversePending.delete(genKey)
			void this._reverseSync(branch, relativePath)
		}, getDebounceMs())
		this._reversePending.set(genKey, timer)
	}

	private async _reverseSync(branch: string, relativePath: string): Promise<void> {
		if (!this._workspaceRoot) return
		// Only pull back if this file is assigned to this branch — otherwise
		// the primary workspace shouldn't be overwritten by arbitrary worktree
		// edits (they might belong to another branch's layer).
		const owner = this._config.getAssignment(relativePath)
		if (owner !== branch) return

		const srcUri = vscode.Uri.joinPath(
			worktreePath(this._workspaceRoot, branch),
			relativePath,
		)
		const destUri = vscode.Uri.joinPath(this._workspaceRoot, relativePath)

		let content: Uint8Array
		try {
			content = await vscode.workspace.fs.readFile(srcUri)
		} catch {
			return
		}

		// Skip write when the destination file already matches — avoids
		// triggering the primary-watcher unnecessarily.
		try {
			const existing = await vscode.workspace.fs.readFile(destUri)
			if (bytesEqual(existing, content)) return
		} catch {
			// Destination missing is fine — we'll create it.
		}

		this._syncing = true
		try {
			const destDir = vscode.Uri.file(path.dirname(destUri.fsPath))
			try { await vscode.workspace.fs.createDirectory(destDir) } catch { /* ignore */ }
			await vscode.workspace.fs.writeFile(destUri, content)
			log.info(`WorkspaceSync: reverse-synced ${relativePath} ← ${branch}`)
		} catch (e) {
			log.warn(`WorkspaceSync: reverse-sync failed for ${relativePath}: ${e instanceof Error ? e.message : String(e)}`)
		} finally {
			this._syncing = false
		}
	}

	/** Decode `.worktrees/<branch-dir>/...` URIs into (branch, relativePath). */
	private _relativeInWorktree(uri: vscode.Uri): { branch: string, relativePath: string } | undefined {
		if (!this._workspaceRoot) return undefined
		const rel = path.relative(this._workspaceRoot.fsPath, uri.fsPath).replaceAll(path.sep, '/')
		const match = /^\.worktrees\/([^/]+)\/(.+)$/.exec(rel)
		if (!match) return undefined
		const dirName = match[1]
		const relativePath = match[2]
		// Find the branch owning that directory.  Done by prefix match since
		// `branchToWorktreeDirName` maps branch → dir deterministically.
		for (const entry of this._config.getStack()) {
			// We can't recompute dirs here without a circular import; ask the
			// config service for whichever branch matches this dir suffix.
			if (dirName.startsWith(entry.name.replaceAll('/', '-'))) {
				return { branch: entry.name, relativePath }
			}
		}
		return undefined
	}

	private async _propagateDeletion(relativePath: string, branch: string): Promise<void> {
		if (!this._workspaceRoot) {
			return
		}
		const wtPath = worktreePath(this._workspaceRoot, branch)
		const destUri = vscode.Uri.joinPath(wtPath, relativePath)

		this._syncing = true
		try {
			await vscode.workspace.fs.delete(destUri, { useTrash: false })
			log.info(`WorkspaceSync: deleted ${relativePath} from ${branch}`)
		} catch {
			// File may not exist in worktree — not an error
		} finally {
			this._syncing = false
		}
	}

	private _relativePath(uri: vscode.Uri): string | undefined {
		if (!this._workspaceRoot) {
			return undefined
		}
		const rel = path.relative(this._workspaceRoot.fsPath, uri.fsPath)
		if (rel.startsWith('..')) {
			// Outside workspace
			return undefined
		}
		return rel.replaceAll(path.sep, '/')
	}
}

function normalisePath(p: string): string {
	return p.replaceAll('\\', '/')
}

/** Byte-compare two Uint8Arrays. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false
	}
	return true
}
