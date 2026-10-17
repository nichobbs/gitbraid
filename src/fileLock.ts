import * as fs from 'node:fs'
import { log } from './channelLogger'

export interface FileLockOptions {
	/** A lock file older than this is treated as left behind by a crashed holder. */
	staleMs?: number
	/** Delay between acquisition attempts. */
	retryDelayMs?: number
	/** Attempts before giving up. */
	maxRetries?: number
}

const DEFAULTS = { staleMs: 30_000, retryDelayMs: 20, maxRetries: 500 } as const

/**
 * Run `fn` while holding an advisory cross-process lock at `lockPath`.
 *
 * The lock is a file created with `O_EXCL` (`'wx'`), so only one process
 * can hold it at a time.  A lock older than `staleMs` is assumed to belong to
 * a crashed holder and is removed.  Staleness is time-based, so `staleMs`
 * must comfortably exceed the longest critical section; two waiters that
 * both judge the same lock stale can each remove the other's fresh lock,
 * which is the same trade-off `ConfigService` makes.
 */
export async function withFileLock<T>(
	lockPath: string,
	fn: () => Promise<T>,
	opts: FileLockOptions = {},
): Promise<T> {
	const { staleMs, retryDelayMs, maxRetries } = { ...DEFAULTS, ...opts }
	await acquire(lockPath, staleMs, retryDelayMs, maxRetries)
	try {
		return await fn()
	} finally {
		try {
			await fs.promises.unlink(lockPath)
		} catch {
			// Already gone (for example removed as stale by another process).
		}
	}
}

async function acquire(lockPath: string, staleMs: number, retryDelayMs: number, maxRetries: number): Promise<void> {
	for (let i = 0; i < maxRetries; i++) {
		try {
			const fh = await fs.promises.open(lockPath, 'wx')
			await fh.close()
			return
		} catch (e: unknown) {
			const err = e as NodeJS.ErrnoException
			if (err.code !== 'EEXIST') throw err
			try {
				const stat = await fs.promises.stat(lockPath)
				if (Date.now() - stat.mtimeMs > staleMs) {
					log.warn(`fileLock: removing stale lock ${lockPath}`)
					await fs.promises.unlink(lockPath)
					continue
				}
			} catch {
				// Removed between our EEXIST and the stat: retry straight away.
				continue
			}
			await new Promise<void>((r) => setTimeout(r, retryDelayMs))
		}
	}
	throw new Error(`could not acquire lock ${lockPath} after ${String(maxRetries)} attempts`)
}
