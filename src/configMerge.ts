import type { BranchConfig, BranchStackEntry, HunkAnchor } from './configTypes'

/**
 * Plan 13: three-way merge of `gitbraid-config.json`.
 *
 * `base` is the document this window last read or wrote, `ours` is this
 * window's in-memory state, `theirs` is what is on disk now.  Comparing each
 * side to `base` tells a deletion apart from "never had it", which a plain
 * union cannot: with a union, a key removed in one window is brought back by
 * the other window's older copy.
 *
 * Pure and free of `vscode` imports so it can be unit tested directly.
 */

export type MergeConflictKind = 'assignment' | 'hunkAssignment' | 'hunkAnchor' | 'stack'

/** A key both sides changed differently. We keep one side; see {@link MergeConflict.kept}. */
export interface MergeConflict {
	kind: MergeConflictKind
	/** Path, `path#hunk`, or `branch.field`, for logs and the user notice. */
	key: string
	/** Which side was kept. Ours wins unless it had deleted a key theirs modified. */
	kept: 'ours' | 'theirs'
}

export interface MergeResult {
	config: BranchConfig
	conflicts: MergeConflict[]
}

/** JSON with object keys sorted, so equal values compare equal regardless of key order. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, v: unknown) => {
		if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
			const sorted: Record<string, unknown> = {}
			for (const k of Object.keys(v as Record<string, unknown>).sort()) {
				sorted[k] = (v as Record<string, unknown>)[k]
			}
			return sorted
		}
		return v
	}) ?? 'undefined'
}

function same(a: unknown, b: unknown): boolean {
	return canonicalJson(a) === canonicalJson(b)
}

/**
 * Merge one level of a key/value map.  For each key, compare both sides to
 * `base`: a side that did not change defers to the side that did, including
 * when the change is a deletion.  When both changed, ours wins (it is the
 * user's latest action in this window) - except that a deletion never beats
 * a modification, so nothing the other window wrote is silently discarded.
 */
function merge3Record<V>(
	base: Record<string, V>,
	ours: Record<string, V>,
	theirs: Record<string, V>,
	kind: MergeConflictKind,
	conflicts: MergeConflict[],
	label: (key: string) => string = (k) => k,
): Record<string, V> {
	const out: Record<string, V> = {}
	const keys = new Set([...Object.keys(ours), ...Object.keys(theirs), ...Object.keys(base)])
	// Keep a stable order: ours first, then keys only the other side has.
	const ordered = [...Object.keys(ours), ...Object.keys(theirs), ...Object.keys(base)]
		.filter((k, i, all) => keys.has(k) && all.indexOf(k) === i)
	for (const k of ordered) {
		const b = base[k]
		const o = ours[k]
		const t = theirs[k]
		let pick: V | undefined
		if (same(o, t)) {
			pick = o
		} else if (same(o, b)) {
			pick = t
		} else if (same(t, b)) {
			pick = o
		} else {
			// Both sides changed this key, differently.
			const keepOurs = o !== undefined
			pick = keepOurs ? o : t
			conflicts.push({ kind, key: label(k), kept: keepOurs ? 'ours' : 'theirs' })
		}
		if (pick !== undefined) out[k] = pick
	}
	return out
}

const SEP = '\u0000'

/** `{file: {idx: v}}` -> `{"file\0idx": v}` so nested maps can reuse {@link merge3Record}. */
function flatten<V>(nested: Record<string, Record<string, V>> | undefined): Record<string, V> {
	const flat: Record<string, V> = {}
	for (const [file, inner] of Object.entries(nested ?? {})) {
		for (const [idx, v] of Object.entries(inner)) flat[file + SEP + idx] = v
	}
	return flat
}

function unflatten<V>(flat: Record<string, V>): Record<string, Record<string, V>> {
	const nested: Record<string, Record<string, V>> = {}
	for (const [key, v] of Object.entries(flat)) {
		const at = key.lastIndexOf(SEP)
		const file = key.slice(0, at)
		;(nested[file] ??= {})[key.slice(at + 1)] = v
	}
	return nested
}

function mergeNested<V>(
	base: Record<string, Record<string, V>> | undefined,
	ours: Record<string, Record<string, V>> | undefined,
	theirs: Record<string, Record<string, V>> | undefined,
	kind: MergeConflictKind,
	conflicts: MergeConflict[],
): Record<string, Record<string, V>> {
	return unflatten(merge3Record(
		flatten(base), flatten(ours), flatten(theirs), kind, conflicts,
		(k) => k.replace(SEP, '#'),
	))
}

function mergeStack(
	base: BranchStackEntry[],
	ours: BranchStackEntry[],
	theirs: BranchStackEntry[],
	conflicts: MergeConflict[],
): BranchStackEntry[] {
	const byName = (list: BranchStackEntry[]) => new Map(list.map((e) => [e.name, e]))
	const b = byName(base)
	const o = byName(ours)
	const t = byName(theirs)
	const names = [...ours.map((e) => e.name), ...theirs.map((e) => e.name)]
		.filter((n, i, all) => all.indexOf(n) === i)

	const merged: BranchStackEntry[] = []
	for (const name of names) {
		const be = b.get(name)
		const oe = o.get(name)
		const te = t.get(name)
		let pick: BranchStackEntry | undefined
		if (same(oe, te)) {
			pick = oe
		} else if (same(oe, be)) {
			pick = te
		} else if (same(te, be)) {
			pick = oe
		} else if (!oe || !te) {
			// One side removed the branch, the other modified it: keep the modification.
			pick = oe ?? te
			conflicts.push({ kind: 'stack', key: name, kept: oe ? 'ours' : 'theirs' })
		} else {
			// Both modified it: merge field by field, so (for example) a colour change here
			// and a cached PR number there both survive.
			const fields = merge3Record<unknown>(
				(be ?? {}) as unknown as Record<string, unknown>,
				oe as unknown as Record<string, unknown>,
				te as unknown as Record<string, unknown>,
				'stack',
				conflicts,
				(f) => `${name}.${f}`,
			)
			pick = fields as unknown as BranchStackEntry
		}
		if (pick) merged.push(pick)
	}

	// Order values from two windows can collide or leave gaps; renumber them
	// contiguously. When they already were contiguous this changes nothing.
	merged.sort((x, y) => (x.order - y.order) || x.name.localeCompare(y.name))
	return merged.map((e, i) => (e.order === i + 1 ? e : { ...e, order: i + 1 }))
}

/** Merge `ours` and `theirs` relative to their common ancestor `base`. */
export function mergeConfigs3(base: BranchConfig, ours: BranchConfig, theirs: BranchConfig): MergeResult {
	const conflicts: MergeConflict[] = []
	const config: BranchConfig = {
		...theirs,
		...ours,
		stack: mergeStack(base.stack, ours.stack, theirs.stack, conflicts),
		assignments: merge3Record(base.assignments, ours.assignments, theirs.assignments, 'assignment', conflicts),
		hunkAssignments: mergeNested(base.hunkAssignments, ours.hunkAssignments, theirs.hunkAssignments, 'hunkAssignment', conflicts),
		hunkAnchors: mergeNested<HunkAnchor>(base.hunkAnchors, ours.hunkAnchors, theirs.hunkAnchors, 'hunkAnchor', conflicts),
	}
	return { config, conflicts }
}
