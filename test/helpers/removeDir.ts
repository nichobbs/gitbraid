import * as fs from 'node:fs'
import { log } from '../../src/channelLogger'

/**
 * Retry budget for removing temporary test directories.
 *
 * `fs.rmSync` retries with a linearly growing delay (`retryDelay * attempt`)
 * and blocks the thread while it waits, so the worst case is
 * `retryDelay * maxRetries * (maxRetries + 1) / 2`.  The previous settings
 * (10 retries, 200 ms) block for about 11 s, which is longer than mocha's 10 s
 * hook timeout: on Windows, where AV scanning or a lingering handle can hold
 * `.git` open, the hook then fails with a timeout even though the error was
 * swallowed.  These settings cap the worst case at about 1.5 s.
 */
export const RM_RETRY_OPTIONS = { maxRetries: 5, retryDelay: 100 } as const

/** Worst-case time `rmSync` can block with {@link RM_RETRY_OPTIONS}, in ms. */
export function worstCaseRemoveMs(opts: { maxRetries: number, retryDelay: number } = RM_RETRY_OPTIONS): number {
	return opts.retryDelay * (opts.maxRetries * (opts.maxRetries + 1)) / 2
}

/**
 * Remove a temporary directory without ever failing or blocking for long.
 *
 * Cleanup of an ephemeral temp dir is not worth failing a test run over: the
 * assertions have already run, and the OS reclaims the directory anyway.
 */
export function removeDirBestEffort(dir: string, label = 'test'): void {
	try {
		fs.rmSync(dir, { recursive: true, force: true, ...RM_RETRY_OPTIONS })
	} catch (e) {
		log.warn(`${label}: could not remove temp dir at ${dir}: ${e instanceof Error ? e.message : String(e)}`)
	}
}
