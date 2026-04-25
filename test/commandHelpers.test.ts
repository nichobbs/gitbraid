import * as assert from 'node:assert'
import {
	reorderForMove,
	buildBaseList,
	buildAssignBranchPickItems,
	globToCandidates,
	buildAddBranchPickItems,
	filesAssignedTo,
	pluralise,
	toolDisplayName,
} from '../src/commands/_helpers'
import type { BranchStackEntry } from '../src/configTypes'

function entry(name: string, order: number, scratch?: boolean): BranchStackEntry {
	return { name, order, color: '#fff', base: 'main', ...(scratch === undefined ? {} : { scratch }) }
}

// ─── reorderForMove ─────────────────────────────────────────────────────────

suite('commandHelpers: reorderForMove', () => {
	test('moves a middle branch up', () => {
		const stack = [entry('a', 1), entry('b', 2), entry('c', 3)]
		assert.deepStrictEqual(reorderForMove(stack, 'b', 'up'), ['a', 'c', 'b'])
	})

	test('moves a middle branch down', () => {
		const stack = [entry('a', 1), entry('b', 2), entry('c', 3)]
		assert.deepStrictEqual(reorderForMove(stack, 'b', 'down'), ['b', 'a', 'c'])
	})

	test('returns undefined when the top branch tries to move up', () => {
		const stack = [entry('a', 1), entry('b', 2)]
		assert.strictEqual(reorderForMove(stack, 'b', 'up'), undefined)
	})

	test('returns undefined when the bottom branch tries to move down', () => {
		const stack = [entry('a', 1), entry('b', 2)]
		assert.strictEqual(reorderForMove(stack, 'a', 'down'), undefined)
	})

	test('returns undefined for an unknown branch', () => {
		const stack = [entry('a', 1), entry('b', 2)]
		assert.strictEqual(reorderForMove(stack, 'ghost', 'up'), undefined)
	})

	test('filters scratch entries out of the move set', () => {
		const stack = [entry('scratch', 0, true), entry('a', 1), entry('b', 2)]
		// scratch is dropped, then a and b swap.
		assert.deepStrictEqual(reorderForMove(stack, 'a', 'up'), ['b', 'a'])
	})

	test('handles unsorted input by sorting on order before swapping', () => {
		const stack = [entry('c', 3), entry('a', 1), entry('b', 2)]
		assert.deepStrictEqual(reorderForMove(stack, 'a', 'up'), ['b', 'a', 'c'])
	})

	test('returns undefined on a single-entry stack', () => {
		const stack = [entry('only', 1)]
		assert.strictEqual(reorderForMove(stack, 'only', 'up'), undefined)
		assert.strictEqual(reorderForMove(stack, 'only', 'down'), undefined)
	})
})

// ─── buildBaseList ──────────────────────────────────────────────────────────

suite('commandHelpers: buildBaseList', () => {
	test('default branch first, then non-default stack entries', () => {
		const stack = [entry('feat/a', 1), entry('feat/b', 2)]
		assert.deepStrictEqual(buildBaseList(stack, 'main'), ['main', 'feat/a', 'feat/b'])
	})

	test('de-dupes the default if it is also in the stack', () => {
		const stack = [entry('main', 0), entry('feat/a', 1)]
		assert.deepStrictEqual(buildBaseList(stack, 'main'), ['main', 'feat/a'])
	})

	test('empty stack → just the default', () => {
		assert.deepStrictEqual(buildBaseList([], 'main'), ['main'])
	})
})

// ─── buildAssignBranchPickItems ─────────────────────────────────────────────

suite('commandHelpers: buildAssignBranchPickItems', () => {
	test('current branch shown first when not in stack', () => {
		const stack = [entry('feat/a', 1)]
		const items = buildAssignBranchPickItems(stack, 'main', false)
		assert.strictEqual(items[0].label, 'main')
		assert.match(items[0].description ?? '', /stays in workspace/)
		assert.strictEqual(items[1].label, 'feat/a')
	})

	test('current branch is omitted when already in stack', () => {
		const stack = [entry('feat/a', 1)]
		const items = buildAssignBranchPickItems(stack, 'feat/a', true)
		assert.strictEqual(items.length, 1)
		assert.strictEqual(items[0].label, 'feat/a')
	})

	test('no current branch → just stack entries', () => {
		const stack = [entry('feat/a', 1), entry('feat/b', 2)]
		const items = buildAssignBranchPickItems(stack, undefined, true)
		assert.deepStrictEqual(items.map((i) => i.label), ['feat/a', 'feat/b'])
	})

	test('empty stack and no current → empty list', () => {
		assert.deepStrictEqual(buildAssignBranchPickItems([], undefined, true), [])
	})

	test('description is set to the colour for stack entries', () => {
		const stack = [{ name: 'feat/a', order: 1, color: '#abc', base: 'main' }]
		const items = buildAssignBranchPickItems(stack, undefined, true)
		assert.strictEqual(items[0].description, '#abc')
	})
})

// ─── globToCandidates ───────────────────────────────────────────────────────

suite('commandHelpers: globToCandidates', () => {
	test('returns workspace-relative POSIX paths sorted', () => {
		const root = '/repo'
		const inputs = ['/repo/src/b.ts', '/repo/src/a.ts', '/repo/README.md']
		assert.deepStrictEqual(globToCandidates(inputs, root), ['README.md', 'src/a.ts', 'src/b.ts'])
	})

	test('drops paths outside the root', () => {
		const root = '/repo'
		const inputs = ['/repo/src/a.ts', '/elsewhere/x.ts']
		assert.deepStrictEqual(globToCandidates(inputs, root), ['src/a.ts'])
	})

	test('drops the root itself (relative === "")', () => {
		const root = '/repo'
		assert.deepStrictEqual(globToCandidates(['/repo'], root), [])
	})

	test('empty input → empty list', () => {
		assert.deepStrictEqual(globToCandidates([], '/repo'), [])
	})
})

// ─── buildAddBranchPickItems ────────────────────────────────────────────────

suite('commandHelpers: buildAddBranchPickItems', () => {
	test('empty input → empty list', () => {
		assert.deepStrictEqual(
			buildAddBranchPickItems('', [], [], new Set()),
			[],
		)
	})

	test('typed name with no matches → "create new branch" entry', () => {
		const items = buildAddBranchPickItems('feature/new', [], [], new Set())
		assert.strictEqual(items.length, 1)
		assert.strictEqual(items[0].isNew, true)
		assert.strictEqual(items[0].detail, 'feature/new')
		assert.match(items[0].label, /\$\(plus\)/)
	})

	test('typed name matching an existing local branch → no "create new" entry', () => {
		const items = buildAddBranchPickItems('feature/x', ['feature/x'], [], new Set())
		assert.ok(!items.some((i) => i.isNew === true))
		// Local separator + the match
		assert.ok(items.some((i) => i.kind === 'separator' && i.label === 'Local'))
		assert.ok(items.some((i) => i.label === 'feature/x' && i.description === 'local'))
	})

	test('local matches are filtered by the typed substring', () => {
		const items = buildAddBranchPickItems('feat', ['feature/x', 'unrelated'], [], new Set())
		const labels = items.filter((i) => i.kind !== 'separator').map((i) => i.label)
		assert.ok(labels.includes('feature/x'))
		assert.ok(!labels.includes('unrelated'))
	})

	test('remote matches already in the stack are filtered out', () => {
		const items = buildAddBranchPickItems(
			'feat',
			[],
			['feature/x', 'feature/y'],
			new Set(['feature/y']),
		)
		const remoteLabels = items
			.filter((i) => i.description === 'remote')
			.map((i) => i.label)
		assert.deepStrictEqual(remoteLabels, ['feature/x'])
	})

	test('whitespace-only input is treated as empty', () => {
		const items = buildAddBranchPickItems('   ', ['feat/a'], [], new Set())
		// No "create new" entry, but the local section still shows everything.
		assert.ok(!items.some((i) => i.isNew === true))
		assert.ok(items.some((i) => i.label === 'feat/a'))
	})

	test('separators only appear when their bucket has matches', () => {
		const onlyLocal = buildAddBranchPickItems('feat', ['feat/a'], [], new Set())
		assert.ok(onlyLocal.some((i) => i.kind === 'separator' && i.label === 'Local'))
		assert.ok(!onlyLocal.some((i) => i.kind === 'separator' && i.label === 'Remote'))

		const onlyRemote = buildAddBranchPickItems('feat', [], ['feat/r'], new Set())
		assert.ok(!onlyRemote.some((i) => i.kind === 'separator' && i.label === 'Local'))
		assert.ok(onlyRemote.some((i) => i.kind === 'separator' && i.label === 'Remote'))
	})
})

// ─── filesAssignedTo ────────────────────────────────────────────────────────

suite('commandHelpers: filesAssignedTo', () => {
	test('returns paths with matching branch', () => {
		const all = { 'a.ts': 'feat/a', 'b.ts': 'feat/b', 'c.ts': 'feat/a' }
		assert.deepStrictEqual(
			filesAssignedTo(all, 'feat/a').sort(),
			['a.ts', 'c.ts'],
		)
	})

	test('returns [] when no files match', () => {
		assert.deepStrictEqual(filesAssignedTo({}, 'feat/a'), [])
		assert.deepStrictEqual(filesAssignedTo({ 'a.ts': 'feat/b' }, 'feat/a'), [])
	})
})

// ─── pluralise ──────────────────────────────────────────────────────────────

suite('commandHelpers: pluralise', () => {
	test('singular when count is 1', () => {
		assert.strictEqual(pluralise(1, 'file'), '1 file')
	})

	test('plural via default "+s" rule', () => {
		assert.strictEqual(pluralise(0, 'file'), '0 files')
		assert.strictEqual(pluralise(3, 'file'), '3 files')
	})

	test('plural via explicit override', () => {
		assert.strictEqual(pluralise(2, 'branch', 'branches'), '2 branches')
		assert.strictEqual(pluralise(1, 'branch', 'branches'), '1 branch')
	})
})

// ─── toolDisplayName ────────────────────────────────────────────────────────

suite('commandHelpers: toolDisplayName', () => {
	test('maps every supported kind to its label', () => {
		assert.strictEqual(toolDisplayName('graphite'), 'Graphite')
		assert.strictEqual(toolDisplayName('git-spr'), 'git-spr')
		assert.strictEqual(toolDisplayName('git-stack'), 'git-stack')
		assert.strictEqual(toolDisplayName('gitbutler'), 'GitButler')
		assert.strictEqual(toolDisplayName('upstream'), 'Upstream tracking')
	})
})
