import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { classifyFileHunks, isTrivialKind } from './hunkClassifier'
import type { HunkKind } from './hunkClassifier'
import type { DiffHunk } from './diffEngine'
import { log } from './channelLogger'
import { requireInside } from './pathGuard'

/** Files larger than this are not classified (everything is `logic`). */
const MAX_CLASSIFY_BYTES = 2 * 1024 * 1024

/**
 * Classify `hunks` of `relativePath` against the working-tree copy under
 * `wsRoot` (the file `git diff` compared).  Any failure to read the file
 * yields `logic` for every hunk: classification may only ever add safety.
 */
export async function classifyHunksOnDisk(
	wsRoot: string,
	relativePath: string,
	hunks: readonly DiffHunk[],
): Promise<HunkKind[]> {
	if (hunks.length === 0) return []
	try {
		const abs = path.join(wsRoot, relativePath)
		requireInside(wsRoot, relativePath)
		const st = await fsp.stat(abs)
		if (st.size > MAX_CLASSIFY_BYTES) return hunks.map(() => 'logic')
		const text = await fsp.readFile(abs, 'utf-8')
		return classifyFileHunks(hunks, text, relativePath)
	} catch (e) {
		log.debug(`hunkKinds: not classifying ${relativePath}: ${e instanceof Error ? e.message : String(e)}`)
		return hunks.map(() => 'logic')
	}
}

/** Copy of `hunks` with `classification` set. */
export async function withClassification(
	wsRoot: string,
	relativePath: string,
	hunks: readonly DiffHunk[],
): Promise<DiffHunk[]> {
	const kinds = await classifyHunksOnDisk(wsRoot, relativePath, hunks)
	return hunks.map((h, i) => ({ ...h, classification: kinds[i] }))
}

export type AutoRouteMode = 'off' | 'whitespace' | 'whitespace+comment'

/**
 * Trivial hunks with no assignment of their own inherit the branch of the
 * nearest assigned hunk (by line distance, ties go to the hunk above).
 * Never touches `logic`, `mixed` or `import` hunks, and never overrides an
 * explicit assignment.  Returns only the inherited entries.
 */
export function inheritTrivialAssignments(
	hunks: ReadonlyArray<Pick<DiffHunk, 'index' | 'startLine' | 'endLine' | 'classification'>>,
	assigned: ReadonlyMap<number, string>,
	mode: AutoRouteMode,
): Map<number, string> {
	const inherited = new Map<number, string>()
	if (mode === 'off') return inherited
	const eligible = (k: HunkKind | undefined): boolean =>
		k === 'whitespace' || (mode === 'whitespace+comment' && k === 'comment')
	const anchors = hunks.filter((h) => assigned.has(h.index))
	if (anchors.length === 0) return inherited

	for (const h of hunks) {
		if (assigned.has(h.index) || !eligible(h.classification) || !isTrivialKind(h.classification!)) continue
		let best: { branch: string, distance: number, above: boolean } | undefined
		for (const a of anchors) {
			const above = a.endLine < h.startLine
			const distance = above ? h.startLine - a.endLine : Math.max(0, a.startLine - h.endLine)
			const cand = { branch: assigned.get(a.index)!, distance, above }
			if (!best || cand.distance < best.distance || (cand.distance === best.distance && cand.above && !best.above)) best = cand
		}
		if (best) inherited.set(h.index, best.branch)
	}
	return inherited
}

/**
 * `assignments` plus the trivial hunks of `relativePath` that inherit a
 * neighbour's branch under `mode`.  Returns `assignments` itself when nothing
 * is inherited, so callers can compare by identity.
 */
export async function withInheritedTrivial(
	diffEngine: Pick<import('./diffEngine').DiffEngine, 'getHunksForFile'>,
	wsRoot: string,
	relativePath: string,
	assignments: ReadonlyMap<number, string>,
	mode: AutoRouteMode,
): Promise<ReadonlyMap<number, string>> {
	if (mode === 'off' || assignments.size === 0) return assignments
	const hunks = await withClassification(wsRoot, relativePath, await diffEngine.getHunksForFile(wsRoot, relativePath))
	const inherited = inheritTrivialAssignments(hunks, assignments, mode)
	if (inherited.size === 0) return assignments
	log.info(`hunkKinds: ${String(inherited.size)} trivial hunk(s) in ${relativePath} inherit a neighbour's branch`)
	return new Map([...assignments, ...inherited])
}

export function autoRouteMode(raw: unknown): AutoRouteMode {
	return raw === 'whitespace' || raw === 'whitespace+comment' ? raw : 'off'
}
