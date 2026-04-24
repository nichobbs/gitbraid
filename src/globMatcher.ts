import { Minimatch } from 'minimatch'

/**
 * Thin wrapper around `minimatch` for `files.watcherExclude`-style patterns.
 *
 * Uses minimatch with `{ dot: true }` so patterns match hidden paths such
 * as `.git/objects/…` the same way VS Code's own globbing does.  The full
 * glob syntax is supported — double-star, single-star, `?`, braces
 * `{a,b}`, character classes `[abc]`, and negation `!pattern` — so
 * user-written excludes in `settings.json` behave as documented in the
 * VS Code reference.
 *
 * Compiled `Minimatch` instances are cached per pattern string so the bus
 * doesn't pay parsing overhead on every file event.  A small cache cap
 * prevents unbounded growth when a consumer passes a large number of
 * distinct patterns (e.g. someone recomputing globs from per-event state).
 *
 * Test coverage: `test/globMatcher.test.ts` pins unit-level behaviour and
 * runs a parametric suite against the default VS Code exclude patterns.
 * Previously this module translated globs to regex by hand; the custom
 * translator missed every separator-crossing pattern (e.g. the default
 * `watcherExclude` globs for `.git/objects`, nested `node_modules`), so
 * git plumbing churn was being re-dispatched through the bus on every
 * commit.  Delegating to `minimatch` closes the audit gap and removes
 * ~200 LOC of bespoke regex-generation code.
 */

const CACHE = new Map<string, Minimatch>()
const CACHE_LIMIT = 256

/**
 * Returns true if the workspace-relative path `rel` matches the glob.
 * Both arguments use forward-slash separators; callers normalise Windows
 * paths before invoking.
 */
export function matchGlob(glob: string, rel: string): boolean {
	return compileGlob(glob).match(rel)
}

/** Expose the compiled matcher for tests / debugging. */
export function compileGlob(glob: string): Minimatch {
	const cached = CACHE.get(glob)
	if (cached) return cached
	if (CACHE.size >= CACHE_LIMIT) {
		// Simple FIFO eviction — keeps the cache bounded without dragging
		// in an LRU dependency for a cold-path concern.
		const firstKey = CACHE.keys().next().value as string | undefined
		if (firstKey !== undefined) CACHE.delete(firstKey)
	}
	const m = new Minimatch(glob, { dot: true })
	CACHE.set(glob, m)
	return m
}

/** Clear the compiled-matcher cache.  Exposed for tests. */
export function clearGlobCache(): void {
	CACHE.clear()
}
