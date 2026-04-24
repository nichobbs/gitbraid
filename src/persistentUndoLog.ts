import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { log } from './channelLogger'

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

	constructor(worktreesDir: string, opts: PersistentUndoLogOptions = {}) {
		this._path = path.join(worktreesDir, 'undo-log.jsonl')
		this._max = Math.max(10, opts.maxEntries ?? 500)
	}

	get path(): string { return this._path }

	/**
	 * Load the log from disk.  Corrupt lines are skipped with a warning so
	 * a single stray byte doesn't destroy the whole history.
	 */
	async load(): Promise<UndoLogEntry[]> {
		let raw: string
		try {
			raw = await fsp.readFile(this._path, 'utf-8')
		} catch (e: unknown) {
			const err = e as NodeJS.ErrnoException
			if (err.code === 'ENOENT') return []
			log.warn('PersistentUndoLog.load: ' + errMsg(e))
			return []
		}
		return parseJsonl(raw)
	}

	/**
	 * Append a new entry.  Enforces the cap by rewriting the file when
	 * necessary.  Caller shouldn't rely on the file being sorted; entries are
	 * recorded in insertion order.
	 */
	async append(entry: UndoLogEntry): Promise<void> {
		try {
			await fsp.mkdir(path.dirname(this._path), { recursive: true })
			await fsp.appendFile(this._path, JSON.stringify(entry) + '\n', 'utf-8')
			await this._truncateIfNeeded()
		} catch (e) {
			log.warn('PersistentUndoLog.append: ' + errMsg(e))
		}
	}

	/**
	 * Remove and return the newest entry.  Used after `undo()` so the persistent
	 * log follows the in-memory ring.  Returns `undefined` if the file is empty
	 * or missing.
	 */
	async popLast(): Promise<UndoLogEntry | undefined> {
		const entries = await this.load()
		const last = entries.pop()
		if (!last) return undefined
		await this._writeAll(entries)
		return last
	}

	/** Erase the file. */
	async clear(): Promise<void> {
		try { await fsp.unlink(this._path) } catch { /* missing is fine */ }
	}

	/**
	 * Replace the entire log contents with `entries`.  Exposed for the
	 * replay flow which truncates the log to everything up to and
	 * including the replay target.
	 */
	async writeAll(entries: UndoLogEntry[]): Promise<void> {
		await this._writeAll(entries)
	}

	private async _truncateIfNeeded(): Promise<void> {
		const entries = await this.load()
		if (entries.length <= this._max) return
		const trimmed = entries.slice(entries.length - this._max)
		await this._writeAll(trimmed)
	}

	private async _writeAll(entries: UndoLogEntry[]): Promise<void> {
		const out = entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : '')
		await fsp.mkdir(path.dirname(this._path), { recursive: true })
		// Atomic replace via tempfile avoids a half-written file on crash.
		const tmp = this._path + '.tmp'
		await fsp.writeFile(tmp, out, 'utf-8')
		await fsp.rename(tmp, this._path)
	}
}

export function parseJsonl(raw: string): UndoLogEntry[] {
	if (!raw) return []
	const out: UndoLogEntry[] = []
	for (const line of raw.split(/\r?\n/)) {
		const s = line.trim()
		if (!s) continue
		try {
			const entry = JSON.parse(s) as unknown
			if (isEntry(entry)) out.push(entry)
			else log.debug('PersistentUndoLog: skipping unrecognised line')
		} catch {
			log.debug('PersistentUndoLog: skipping unparseable line')
		}
	}
	return out
}

function isEntry(x: unknown): x is UndoLogEntry {
	if (typeof x !== 'object' || x === null) return false
	const r = x as Record<string, unknown>
	return typeof r.ts === 'string' && typeof r.action === 'string' && typeof r.detail === 'object' && r.detail !== null
}

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e) }
