import * as fs from 'node:fs'
import * as path from 'node:path'
import { log } from './channelLogger'
import { withFileLock } from './fileLock'

/**
 * Plan 14: one append-only JSONL log primitive shared by `VirtualBranchStore`
 * and `PersistentUndoLog`, so crash safety, corrupt-line tolerance, locking
 * and compaction are implemented (and tested) once.
 */

export interface JsonlLogOptions<T> {
	path: string
	/** Validate and narrow a parsed line; return `undefined` to reject it. */
	parse: (raw: unknown) => T | undefined
	/**
	 * Optional compaction: given every entry, return the ones to keep.  Runs
	 * (and rewrites the file) only if it returns fewer entries than it was given.
	 */
	compact?: (entries: T[]) => T[]
	/** Run `compact` after this many appends from this instance. */
	compactEvery?: number
}

export interface JsonlLogStats {
	/** Valid entries seen by the last `readAll`. */
	lines: number
	/** Bytes read by the last `readAll`. */
	bytes: number
	/** Non-empty lines the last `readAll` could not use. */
	skipped: number
}

/** The operations available while the file lock is held (see {@link JsonlLog.withLock}). */
export interface LockedJsonlLog<T> {
	readAll(): Promise<T[]>
	append(entry: T): Promise<void>
	rewrite(entries: T[]): Promise<void>
}

export class JsonlLog<T> {

	private _queue: Promise<unknown> = Promise.resolve()
	private _tailChecked = false
	private _sinceCompact = 0
	private _stats: JsonlLogStats = { lines: 0, bytes: 0, skipped: 0 }

	constructor(private readonly _opts: JsonlLogOptions<T>) {}

	get path(): string { return this._opts.path }

	private get _lockPath(): string { return this._opts.path + '.lock' }
	private get _tmpPath(): string { return this._opts.path + '.tmp' }

	stats(): JsonlLogStats { return { ...this._stats } }

	/**
	 * Append one entry as a single line, under the cross-process file lock.
	 * Operations on one instance run in order; the line is written when this
	 * resolves.
	 */
	append(entry: T): Promise<void> {
		return this._enqueue(() => this._append(entry, false))
	}

	/**
	 * Read every valid entry.  Unparseable or rejected lines are skipped and
	 * counted in {@link stats}.  Not queued: a concurrent `rewrite` replaces the
	 * file atomically, so a read sees either the old or the new contents.
	 */
	async readAll(): Promise<T[]> {
		let raw: string
		try {
			raw = await fs.promises.readFile(this._opts.path, 'utf-8')
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
				this._stats = { lines: 0, bytes: 0, skipped: 0 }
				return []
			}
			throw e
		}
		const { entries, skipped } = parseJsonlLines(raw, this._opts.parse)
		this._stats = { lines: entries.length, bytes: Buffer.byteLength(raw), skipped }
		if (skipped > 0) log.debug(`JsonlLog: skipped ${String(skipped)} unusable line(s) in ${this._opts.path}`)
		return entries
	}

	/** Atomically replace the whole file (tmp file, fsync, rename) under the file lock. */
	rewrite(entries: T[]): Promise<void> {
		return this._enqueue(() => withFileLock(this._lockPath, () => this._rewrite(entries)))
	}

	/**
	 * Run `fn` with the cross-process file lock held and exclusive use of this
	 * instance's queue.  `fn` must use the handle it is given: calling the
	 * instance's own methods from inside would wait on the queue `fn` is
	 * already occupying.
	 */
	withLock<R>(fn: (locked: LockedJsonlLog<T>) => Promise<R>): Promise<R> {
		return this._enqueue(() => withFileLock(this._lockPath, () => fn({
			readAll: () => this.readAll(),
			append: (entry) => this._append(entry, true),
			rewrite: (entries) => this._rewrite(entries),
		})))
	}

	/** Delete the log file.  Missing is not an error. */
	remove(): Promise<void> {
		return this._enqueue(async () => {
			for (const file of [this._opts.path, this._tmpPath]) {
				try {
					await fs.promises.unlink(file)
				} catch (e) {
					if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
				}
			}
			this._tailChecked = false
			this._sinceCompact = 0
		})
	}

	// ─── Internals ───────────────────────────────────────────────────────────

	private _enqueue<R>(task: () => Promise<R>): Promise<R> {
		const next = this._queue.then(task, task)
		this._queue = next.catch(() => undefined)
		return next
	}

	/**
	 * `alreadyLocked`: the caller holds the file lock (see `withLock`), so this
	 * must neither take it again nor compact.
	 *
	 * Every append takes the file lock, however short the line.  An unlocked
	 * append would not be atomic with a locked read-modify-write elsewhere
	 * (`rewrite`, compaction, `withLock`): a rewrite that read the file before
	 * the append and renamed over it afterwards would silently drop the line.
	 */
	private async _append(entry: T, alreadyLocked: boolean): Promise<void> {
		const line = JSON.stringify(entry) + '\n'
		await fs.promises.mkdir(path.dirname(this._opts.path), { recursive: true })
		if (alreadyLocked) {
			await this._writeLine(line)
			return
		}
		await withFileLock(this._lockPath, async () => {
			await this._writeLine(line)
			this._sinceCompact++
			const { compact, compactEvery } = this._opts
			if (compact && compactEvery && this._sinceCompact >= compactEvery) {
				this._sinceCompact = 0
				await this._compact(compact)
			}
		})
	}

	private async _writeLine(line: string): Promise<void> {
		let prefix = ''
		if (!this._tailChecked) {
			// A crash mid-append can leave a final line without its newline.  Start
			// on a fresh line so the next entry is not glued to the torn one.
			if (!(await this._endsWithNewline())) prefix = '\n'
			this._tailChecked = true
		}
		await fs.promises.appendFile(this._opts.path, prefix + line, 'utf-8')
	}

	private async _endsWithNewline(): Promise<boolean> {
		let fh: fs.promises.FileHandle
		try {
			fh = await fs.promises.open(this._opts.path, 'r')
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true
			throw e
		}
		try {
			const { size } = await fh.stat()
			if (size === 0) return true
			const buf = Buffer.alloc(1)
			await fh.read(buf, 0, 1, size - 1)
			return buf[0] === 0x0a
		} finally {
			await fh.close()
		}
	}

	private async _compact(compact: (entries: T[]) => T[]): Promise<void> {
		const entries = await this.readAll()
		const kept = compact(entries)
		if (kept.length < entries.length) await this._rewrite(kept)
	}

	private async _rewrite(entries: T[]): Promise<void> {
		await fs.promises.mkdir(path.dirname(this._opts.path), { recursive: true })
		const out = entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : '')
		const fh = await fs.promises.open(this._tmpPath, 'w')
		try {
			await fh.writeFile(out, 'utf-8')
			await fh.sync()
		} finally {
			await fh.close()
		}
		await fs.promises.rename(this._tmpPath, this._opts.path)
		// The rewritten file always ends in a newline (or is empty).
		this._tailChecked = true
	}
}

/**
 * Parse JSONL text, skipping blank lines.  A line that is not valid JSON, or
 * that `parse` rejects, is dropped and counted.  A final line without a newline
 * is used if it parses (a complete value is complete regardless of its newline).
 */
export function parseJsonlLines<T>(
	raw: string,
	parse: (value: unknown) => T | undefined,
): { entries: T[], skipped: number } {
	const entries: T[] = []
	let skipped = 0
	if (!raw) return { entries, skipped }
	for (const rawLine of raw.split('\n')) {
		const line = rawLine.trim()
		if (!line) continue
		try {
			const entry = parse(JSON.parse(line) as unknown)
			if (entry === undefined) skipped++
			else entries.push(entry)
		} catch {
			skipped++
		}
	}
	return { entries, skipped }
}
