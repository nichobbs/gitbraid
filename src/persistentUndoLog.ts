import * as path from 'node:path'
import { log } from './channelLogger'
import { JsonlLog, parseJsonlLines } from './jsonlLog'

/**
 * Plan 09 — a small JSONL-backed mirror of the in-memory undo ring so that
 * VS Code restarts don't wipe the user's recent actions.
 *
 * The persisted log is strictly informational — replay is not automatic.
 * {@link UndoStack} remains the source of truth inside a session.  The log is
 * useful for the "show undo log" QuickPick, which lets the user see recent
 * actions with relative timestamps (including across reloads).
 */

export interface UndoLogEntry {
	ts: string
	action: string
	/** Arbitrary details — typed as Record for JSON round-tripping. */
	detail: Record<string, unknown>
}

export interface PersistentUndoLogOptions {
	/** Hard cap on retained entries.  Default: 500. */
	maxEntries?: number
}

export class PersistentUndoLog {

	private readonly _path: string
	private readonly _max: number
	private readonly _log: JsonlLog<UndoLogEntry>

	constructor(worktreesDir: string, opts: PersistentUndoLogOptions = {}) {
		this._path = path.join(worktreesDir, 'undo-log.jsonl')
		this._max = Math.max(10, opts.maxEntries ?? 500)
		// The cap is applied logically in load() and enforced physically by
		// compaction every half-cap appends, so a full log is rewritten once per
		// _max / 2 appends rather than on every append.
		this._log = new JsonlLog<UndoLogEntry>({
			path: this._path,
			parse: toEntry,
			compact: (entries) => entries.slice(-this._max),
			compactEvery: Math.max(1, Math.floor(this._max / 2)),
		})
	}

	get path(): string { return this._path }

	/**
	 * Load the newest `maxEntries` entries from disk.  Corrupt lines are skipped
	 * so a single stray byte doesn't destroy the whole history.
	 */
	async load(): Promise<UndoLogEntry[]> {
		try {
			return (await this._log.readAll()).slice(-this._max)
		} catch (e: unknown) {
			log.warn('PersistentUndoLog.load: ' + errMsg(e))
			return []
		}
	}

	/** Append a new entry.  Failures are logged, never thrown. */
	async append(entry: UndoLogEntry): Promise<void> {
		try {
			await this._log.append(entry)
		} catch (e) {
			log.warn('PersistentUndoLog.append: ' + errMsg(e))
		}
	}

	/**
	 * Remove and return the newest entry.  Used after `undo()` so the persistent
	 * log follows the in-memory ring.  Returns `undefined` if the file is empty
	 * or missing.  Runs under the file lock so a concurrent append from another
	 * window cannot be lost between the read and the rewrite.
	 */
	async popLast(): Promise<UndoLogEntry | undefined> {
		return this._log.withLock(async (locked) => {
			const entries = await locked.readAll()
			const last = entries.pop()
			if (!last) return undefined
			await locked.rewrite(entries)
			return last
		})
	}

	/** Erase the file. */
	async clear(): Promise<void> {
		try { await this._log.remove() } catch { /* missing is fine */ }
	}

	/**
	 * Replace the entire log contents with `entries`.  Exposed for the
	 * replay flow which truncates the log to everything up to and
	 * including the replay target.
	 */
	async writeAll(entries: UndoLogEntry[]): Promise<void> {
		await this._log.rewrite(entries)
	}
}

export function parseJsonl(raw: string): UndoLogEntry[] {
	return parseJsonlLines(raw, toEntry).entries
}

function toEntry(x: unknown): UndoLogEntry | undefined {
	if (typeof x !== 'object' || x === null) return undefined
	const r = x as Record<string, unknown>
	const ok = typeof r.ts === 'string' && typeof r.action === 'string' && typeof r.detail === 'object' && r.detail !== null
	return ok ? (x as UndoLogEntry) : undefined
}

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e) }
