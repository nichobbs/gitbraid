import * as assert from 'node:assert'
import { parseDiffHunks, DiffHunk, DiffEngine } from '../src/diffEngine'
import { HunkRouter } from '../src/hunkRouter'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMockEngine(hunks: DiffHunk[]): DiffEngine {
	const engine = new DiffEngine()
	// Override getHunksForFile to return pre-canned hunks without hitting git
	engine.getHunksForFile = async (_wsRoot: string, _relativePath: string) => hunks
	return engine
}

function makeHunks(specs: Array<{ start: number; end: number }>): DiffHunk[] {
	return specs.map((s, i) => {
		const count = s.end - s.start + 1
		const patch = [
			`diff --git a/file.ts b/file.ts`,
			`index abc..def 100644`,
			`--- a/file.ts`,
			`+++ b/file.ts`,
			`@@ -${String(s.start)},${String(count)} +${String(s.start)},${String(count)} @@`,
			`+changed line`,
		].join('\n') + '\n'
		return { index: i, startLine: s.start, endLine: s.end, header: `@@ -${String(s.start)},${String(count)} +${String(s.start)},${String(count)} @@`, patch }
	})
}

// ─── Suite: HunkRouter.detectOverlaps ────────────────────────────────────────

suite('HunkRouter.detectOverlaps', () => {

	let router: HunkRouter

	suiteSetup(() => {
		router = new HunkRouter(new DiffEngine())
	})

	test('no overlaps when no assignments', () => {
		const hunks = makeHunks([{ start: 1, end: 5 }, { start: 10, end: 15 }])
		const assignments = new Map<number, string>()
		const overlaps = router.detectOverlaps(hunks, assignments)
		assert.deepStrictEqual(overlaps, [])
	})

	test('no overlaps when hunks on same branch touch the same lines', () => {
		const hunks = makeHunks([{ start: 1, end: 5 }, { start: 3, end: 8 }])
		const assignments = new Map([[0, 'feat/a'], [1, 'feat/a']])
		const overlaps = router.detectOverlaps(hunks, assignments)
		// Same branch → not an overlap
		assert.deepStrictEqual(overlaps, [])
	})

	test('no overlaps when hunks on different branches are non-overlapping', () => {
		const hunks = makeHunks([{ start: 1, end: 5 }, { start: 7, end: 10 }])
		const assignments = new Map([[0, 'feat/a'], [1, 'feat/b']])
		const overlaps = router.detectOverlaps(hunks, assignments)
		assert.deepStrictEqual(overlaps, [])
	})

	test('adjacent hunks (touching boundary) do not overlap', () => {
		// Hunk A ends at 5, hunk B starts at 6 — adjacent but not overlapping
		const hunks = makeHunks([{ start: 1, end: 5 }, { start: 6, end: 10 }])
		const assignments = new Map([[0, 'feat/a'], [1, 'feat/b']])
		const overlaps = router.detectOverlaps(hunks, assignments)
		assert.deepStrictEqual(overlaps, [])
	})

	test('detects overlap when hunks on different branches share a line', () => {
		// Hunk A: lines 1–10, hunk B: lines 8–15 → overlap at 8–10
		const hunks = makeHunks([{ start: 1, end: 10 }, { start: 8, end: 15 }])
		const assignments = new Map([[0, 'feat/a'], [1, 'feat/b']])
		const overlaps = router.detectOverlaps(hunks, assignments)
		assert.strictEqual(overlaps.length, 1)
		assert.strictEqual(overlaps[0].hunkA, 0)
		assert.strictEqual(overlaps[0].hunkB, 1)
	})

	test('detects multiple overlaps', () => {
		const hunks = makeHunks([
			{ start: 1, end: 20 },   // 0: assigned to feat/a — overlaps with 1 and 2
			{ start: 5, end: 10 },   // 1: assigned to feat/b — overlaps with 0
			{ start: 15, end: 25 },  // 2: assigned to feat/c — overlaps with 0
		])
		const assignments = new Map([[0, 'feat/a'], [1, 'feat/b'], [2, 'feat/c']])
		const overlaps = router.detectOverlaps(hunks, assignments)
		assert.strictEqual(overlaps.length, 2)
	})

})

// ─── Suite: HunkRouter._buildPatch (via routeFile + mock engine) ──────────────

suite('HunkRouter (patch building)', () => {

	test('routeFile returns true immediately when assignments map is empty', async () => {
		const engine = makeMockEngine([])
		const router = new HunkRouter(engine)
		const ok = await router.routeFile('/some/dir', 'file.ts', new Map(), new Map())
		assert.strictEqual(ok, true)
	})

	test('routeFile returns true when no hunks found for file', async () => {
		const engine = makeMockEngine([])
		const router = new HunkRouter(engine)
		const assignments = new Map([[0, 'feat/a']])
		const dirs = new Map([['feat/a', '/worktrees/a']])
		const ok = await router.routeFile('/some/dir', 'file.ts', dirs, assignments)
		assert.strictEqual(ok, true)
	})

	test('routeFile returns false when worktree dir not found for branch', async () => {
		const hunks = makeHunks([{ start: 1, end: 3 }])
		const engine = makeMockEngine(hunks)
		const router = new HunkRouter(engine)
		const assignments = new Map([[0, 'feat/missing']])
		const dirs = new Map<string, string>()  // no worktree dirs
		const ok = await router.routeFile('/some/dir', 'file.ts', dirs, assignments)
		assert.strictEqual(ok, false)
	})

	test('parseDiffHunks output produces valid patch structure for each hunk', () => {
		const diff = [
			'diff --git a/test.ts b/test.ts',
			'index aaa..bbb 100644',
			'--- a/test.ts',
			'+++ b/test.ts',
			'@@ -1,3 +1,4 @@',
			' line1',
			'+new line',
			' line2',
			' line3',
			'@@ -20,2 +21,2 @@',
			'-old line',
			'+new line',
			' context',
		].join('\n')

		const hunks = parseDiffHunks(diff)
		assert.strictEqual(hunks.length, 2)

		// Each hunk patch should be self-contained (includes file header)
		for (const h of hunks) {
			assert.ok(h.patch.includes('diff --git'), `hunk ${String(h.index)} missing file header`)
			assert.ok(h.patch.includes('@@ '), `hunk ${String(h.index)} missing hunk header`)
		}

		// Hunk patches should not include the OTHER hunk's content
		assert.ok(!hunks[0].patch.includes('@@ -20,2 +21,2 @@'), 'hunk 0 should not include hunk 1 header')
		assert.ok(!hunks[1].patch.includes('@@ -1,3 +1,4 @@'), 'hunk 1 should not include hunk 0 header')
	})

})
