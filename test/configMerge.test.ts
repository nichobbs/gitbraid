import * as assert from 'node:assert'
import { canonicalJson, mergeConfigs3 } from '../src/configMerge'
import type { BranchConfig, BranchStackEntry } from '../src/configTypes'

function entry(name: string, order: number, extra: Partial<BranchStackEntry> = {}): BranchStackEntry {
	return { name, color: '#111111', order, base: 'main', ...extra }
}

function cfg(over: Partial<BranchConfig> = {}): BranchConfig {
	return {
		version: 3,
		rev: 1,
		stack: [entry('a', 1), entry('b', 2)],
		assignments: { 'src/x.ts': 'a', 'src/y.ts': 'b' },
		hunkAssignments: {},
		hunkAnchors: {},
		...over,
	}
}

function clone<T>(x: T): T { return JSON.parse(JSON.stringify(x)) as T }

suite('canonicalJson', () => {
	test('is independent of key order, at every depth', () => {
		assert.strictEqual(canonicalJson({ a: 1, b: { c: 2, d: 3 } }), canonicalJson({ b: { d: 3, c: 2 }, a: 1 }))
	})
	test('keeps array order significant', () => {
		assert.notStrictEqual(canonicalJson([1, 2]), canonicalJson([2, 1]))
	})
	test('handles undefined', () => {
		assert.strictEqual(canonicalJson(undefined), canonicalJson(undefined))
	})
})

suite('mergeConfigs3: assignments', () => {
	test('no changes anywhere leaves the config as it was', () => {
		const base = cfg()
		const { config, conflicts } = mergeConfigs3(base, clone(base), clone(base))
		assert.deepStrictEqual(config.assignments, base.assignments)
		assert.deepStrictEqual(conflicts, [])
	})

	test('a change on only one side is taken, whichever side it is', () => {
		const base = cfg()
		const ours = cfg({ assignments: { ...base.assignments, 'src/new.ts': 'a' } })
		const theirs = cfg({ assignments: { ...base.assignments, 'src/other.ts': 'b' } })
		const { config, conflicts } = mergeConfigs3(base, ours, theirs)
		assert.deepStrictEqual(config.assignments, {
			'src/x.ts': 'a', 'src/y.ts': 'b', 'src/new.ts': 'a', 'src/other.ts': 'b',
		})
		assert.deepStrictEqual(conflicts, [])
	})

	test('REGRESSION: a deletion on our side is not undone by their older copy', () => {
		// This is what the old union merge got wrong: it brought the key back.
		const base = cfg()
		const ours = cfg({ assignments: { 'src/y.ts': 'b' } }) // we unassigned x.ts
		const theirs = clone(base) // other window did not touch it
		const { config, conflicts } = mergeConfigs3(base, ours, theirs)
		assert.deepStrictEqual(config.assignments, { 'src/y.ts': 'b' })
		assert.deepStrictEqual(conflicts, [])
	})

	test('a deletion on their side is honoured too', () => {
		const base = cfg()
		const theirs = cfg({ assignments: { 'src/x.ts': 'a' } }) // they unassigned y.ts
		const { config } = mergeConfigs3(base, clone(base), theirs)
		assert.deepStrictEqual(config.assignments, { 'src/x.ts': 'a' })
	})

	test('both sides delete the same key: stays deleted, no conflict', () => {
		const base = cfg()
		const gone = cfg({ assignments: { 'src/y.ts': 'b' } })
		const { config, conflicts } = mergeConfigs3(base, gone, clone(gone))
		assert.deepStrictEqual(config.assignments, { 'src/y.ts': 'b' })
		assert.deepStrictEqual(conflicts, [])
	})

	test('delete versus modify keeps the modification and reports it', () => {
		const base = cfg()
		const ours = cfg({ assignments: { 'src/y.ts': 'b' } }) // we deleted x.ts
		const theirs = cfg({ assignments: { 'src/x.ts': 'b', 'src/y.ts': 'b' } }) // they reassigned it
		const { config, conflicts } = mergeConfigs3(base, ours, theirs)
		assert.strictEqual(config.assignments['src/x.ts'], 'b', 'their modification must not be lost')
		assert.deepStrictEqual(conflicts.map((c) => [c.kind, c.key, c.kept]), [['assignment', 'src/x.ts', 'theirs']])
	})

	test('modify versus delete keeps our modification and reports it', () => {
		const base = cfg()
		const ours = cfg({ assignments: { 'src/x.ts': 'b', 'src/y.ts': 'b' } })
		const theirs = cfg({ assignments: { 'src/y.ts': 'b' } })
		const { config, conflicts } = mergeConfigs3(base, ours, theirs)
		assert.strictEqual(config.assignments['src/x.ts'], 'b')
		assert.deepStrictEqual(conflicts.map((c) => c.kept), ['ours'])
	})

	test('both add the same key with different values: ours wins, reported', () => {
		const base = cfg({ assignments: {} })
		const ours = cfg({ assignments: { 'src/n.ts': 'a' } })
		const theirs = cfg({ assignments: { 'src/n.ts': 'b' } })
		const { config, conflicts } = mergeConfigs3(base, ours, theirs)
		assert.strictEqual(config.assignments['src/n.ts'], 'a')
		assert.strictEqual(conflicts.length, 1)
	})

	test('both add the same key with the same value: no conflict', () => {
		const base = cfg({ assignments: {} })
		const both = cfg({ assignments: { 'src/n.ts': 'a' } })
		const { conflicts } = mergeConfigs3(base, both, clone(both))
		assert.deepStrictEqual(conflicts, [])
	})
})

suite('mergeConfigs3: hunks and anchors', () => {
	const anchor = (n: number) => ({ startLine: n, endLine: n + 2, bodyHash: 'h' + String(n) })

	test('hunk assignments merge per file and per index', () => {
		const base = cfg({ hunkAssignments: { 'f.ts': { 0: 'a' } } })
		const ours = cfg({ hunkAssignments: { 'f.ts': { 0: 'a', 1: 'b' } } })
		const theirs = cfg({ hunkAssignments: { 'f.ts': { 0: 'a' }, 'g.ts': { 0: 'a' } } })
		const { config } = mergeConfigs3(base, ours, theirs)
		assert.deepStrictEqual(config.hunkAssignments, { 'f.ts': { 0: 'a', 1: 'b' }, 'g.ts': { 0: 'a' } })
	})

	test('removing the last hunk of a file removes the file entry', () => {
		const base = cfg({ hunkAssignments: { 'f.ts': { 0: 'a' } } })
		const ours = cfg({ hunkAssignments: {} })
		const { config } = mergeConfigs3(base, ours, clone(base))
		assert.deepStrictEqual(config.hunkAssignments, {})
	})

	test('REGRESSION: hunk anchors survive a merge (the old merge dropped them entirely)', () => {
		const base = cfg({ hunkAnchors: { 'f.ts': { 0: anchor(1) } } })
		const ours = cfg({ hunkAnchors: { 'f.ts': { 0: anchor(1), 1: anchor(10) } } })
		const { config } = mergeConfigs3(base, ours, clone(base))
		assert.deepStrictEqual(config.hunkAnchors, { 'f.ts': { 0: anchor(1), 1: anchor(10) } })
	})

	test('a file path containing "#" does not confuse the nested key handling', () => {
		const base = cfg({ hunkAssignments: {} })
		const ours = cfg({ hunkAssignments: { 'docs/C#/notes.md': { 3: 'a' } } })
		const { config } = mergeConfigs3(base, ours, clone(base))
		assert.deepStrictEqual(config.hunkAssignments, { 'docs/C#/notes.md': { 3: 'a' } })
	})

	test('conflicting hunk assignment reports path and index', () => {
		const base = cfg({ hunkAssignments: { 'f.ts': { 0: 'a' } } })
		const ours = cfg({ hunkAssignments: { 'f.ts': { 0: 'b' } } })
		const theirs = cfg({ hunkAssignments: { 'f.ts': { 0: 'c' } } })
		const { config, conflicts } = mergeConfigs3(base, ours, theirs)
		assert.strictEqual(config.hunkAssignments?.['f.ts']?.[0], 'b')
		assert.deepStrictEqual(conflicts.map((c) => c.key), ['f.ts#0'])
	})
})

suite('mergeConfigs3: stack', () => {
	test('a branch added in the other window is kept, and orders stay contiguous', () => {
		const base = cfg()
		const theirs = cfg({ stack: [entry('a', 1), entry('b', 2), entry('c', 3)] })
		const { config } = mergeConfigs3(base, clone(base), theirs)
		assert.deepStrictEqual(config.stack.map((e) => [e.name, e.order]), [['a', 1], ['b', 2], ['c', 3]])
	})

	test('REGRESSION: a branch we removed is not resurrected by their older copy', () => {
		const base = cfg()
		const ours = cfg({ stack: [entry('a', 1)] })
		const { config, conflicts } = mergeConfigs3(base, ours, clone(base))
		assert.deepStrictEqual(config.stack.map((e) => e.name), ['a'])
		assert.deepStrictEqual(conflicts, [])
	})

	test('a branch they removed is removed here too', () => {
		const base = cfg()
		const theirs = cfg({ stack: [entry('b', 1)] })
		const { config } = mergeConfigs3(base, clone(base), theirs)
		assert.deepStrictEqual(config.stack.map((e) => e.name), ['b'])
		assert.strictEqual(config.stack[0].order, 1, 'orders renumbered after the removal')
	})

	test('removed on one side but modified on the other keeps the modification', () => {
		const base = cfg()
		const ours = cfg({ stack: [entry('a', 1)] }) // we removed b
		const theirs = cfg({ stack: [entry('a', 1), entry('b', 2, { color: '#ff0000' })] })
		const { config, conflicts } = mergeConfigs3(base, ours, theirs)
		assert.strictEqual(config.stack.find((e) => e.name === 'b')?.color, '#ff0000')
		assert.deepStrictEqual(conflicts.map((c) => [c.kind, c.key, c.kept]), [['stack', 'b', 'theirs']])
	})

	test('different fields of one branch changed in each window both survive', () => {
		const base = cfg()
		const ours = cfg({ stack: [entry('a', 1, { color: '#00ff00' }), entry('b', 2)] })
		const theirs = cfg({ stack: [entry('a', 1, { prNumber: 42 }), entry('b', 2)] })
		const { config, conflicts } = mergeConfigs3(base, ours, theirs)
		const a = config.stack.find((e) => e.name === 'a')
		assert.strictEqual(a?.color, '#00ff00')
		assert.strictEqual(a?.prNumber, 42)
		assert.deepStrictEqual(conflicts, [])
	})

	test('the same field changed differently: ours wins, reported as branch.field', () => {
		const base = cfg()
		const ours = cfg({ stack: [entry('a', 1, { color: '#00ff00' }), entry('b', 2)] })
		const theirs = cfg({ stack: [entry('a', 1, { color: '#0000ff' }), entry('b', 2)] })
		const { config, conflicts } = mergeConfigs3(base, ours, theirs)
		assert.strictEqual(config.stack.find((e) => e.name === 'a')?.color, '#00ff00')
		assert.deepStrictEqual(conflicts.map((c) => c.key), ['a.color'])
	})

	test('a reorder here and an addition there produce a contiguous, collision-free order', () => {
		const base = cfg()
		const ours = cfg({ stack: [entry('b', 1), entry('a', 2)] }) // swapped
		const theirs = cfg({ stack: [entry('a', 1), entry('b', 2), entry('c', 3)] })
		const { config } = mergeConfigs3(base, ours, theirs)
		const orders = config.stack.map((e) => e.order).sort((x, y) => x - y)
		assert.deepStrictEqual(orders, [1, 2, 3])
		assert.strictEqual(new Set(config.stack.map((e) => e.name)).size, 3)
		const ordered = [...config.stack].sort((x, y) => x.order - y.order).map((e) => e.name)
		assert.ok(ordered.indexOf('b') < ordered.indexOf('a'), 'our swap is preserved')
	})
})

suite('mergeConfigs3: properties', () => {
	/** Small deterministic PRNG so a failure is reproducible from the seed. */
	function prng(seed: number): () => number {
		let s = seed >>> 0
		return () => {
			s = (s + 0x6d2b79f5) >>> 0
			let t = s
			t = Math.imul(t ^ (t >>> 15), t | 1)
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296
		}
	}

	test('edits to disjoint keys on each side always combine to "apply both"', () => {
		for (let seed = 1; seed <= 200; seed++) {
			const rnd = prng(seed)
			const branches = ['a', 'b', 'c']
			const keys = Array.from({ length: 12 }, (_, i) => `src/f${String(i)}.ts`)
			const baseAssign: Record<string, string> = {}
			for (const k of keys) if (rnd() < 0.5) baseAssign[k] = branches[Math.floor(rnd() * 3)]
			const base = cfg({
				stack: [entry('a', 1), entry('b', 2), entry('c', 3)],
				assignments: baseAssign,
			})

			// Each key is owned by at most one side, which edits it (set, change, or delete).
			const ours = clone(base)
			const theirs = clone(base)
			const expected = { ...baseAssign }
			for (const k of keys) {
				const owner = rnd()
				if (owner < 0.33) continue // untouched
				const target = owner < 0.66 ? ours : theirs
				if (rnd() < 0.4) {
					delete target.assignments[k]
					delete expected[k]
				} else {
					const v = branches[Math.floor(rnd() * 3)]
					target.assignments[k] = v
					expected[k] = v
				}
			}

			const { config, conflicts } = mergeConfigs3(base, ours, theirs)
			assert.deepStrictEqual(
				Object.fromEntries(Object.entries(config.assignments).sort()),
				Object.fromEntries(Object.entries(expected).sort()),
				`seed ${String(seed)}`,
			)
			assert.deepStrictEqual(conflicts, [], `seed ${String(seed)}: disjoint edits must not conflict`)
		}
	})

	test('merging identical states is a no-op (idempotent)', () => {
		const base = cfg()
		const x = cfg({ assignments: { 'src/x.ts': 'b' }, stack: [entry('a', 1, { color: '#abcdef' }), entry('b', 2)] })
		const { config, conflicts } = mergeConfigs3(base, clone(x), clone(x))
		assert.strictEqual(canonicalJson(config.assignments), canonicalJson(x.assignments))
		assert.strictEqual(canonicalJson(config.stack), canonicalJson(x.stack))
		assert.deepStrictEqual(conflicts, [])
	})

	test('does not mutate its inputs', () => {
		const base = cfg()
		const ours = cfg({ assignments: { 'src/z.ts': 'a' } })
		const theirs = cfg({ stack: [entry('a', 1), entry('b', 2), entry('c', 3)] })
		const snapshot = canonicalJson([base, ours, theirs])
		mergeConfigs3(base, ours, theirs)
		assert.strictEqual(canonicalJson([base, ours, theirs]), snapshot)
	})
})
