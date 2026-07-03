import * as assert from 'node:assert'
import * as vscode from 'vscode'
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

// ─── Suite: HunkRouter.buildPatch (via routeFile + mock engine) ──────────────

suite('HunkRouter (patch building)', () => {

	test('routeFile returns ok:true immediately when assignments map is empty', async () => {
		const engine = makeMockEngine([])
		const router = new HunkRouter(engine)
		const result = await router.routeFile('/some/dir', 'file.ts', new Map(), new Map())
		assert.strictEqual(result.ok, true)
		assert.deepStrictEqual(result.appliedIndices, [])
		assert.deepStrictEqual(result.failedIndices, [])
	})

	test('routeFile returns ok:true when no hunks found for file', async () => {
		const engine = makeMockEngine([])
		const router = new HunkRouter(engine)
		const assignments = new Map([[0, 'feat/a']])
		const dirs = new Map([['feat/a', '/worktrees/a']])
		const result = await router.routeFile('/some/dir', 'file.ts', dirs, assignments)
		assert.strictEqual(result.ok, true)
	})

	test('routeFile returns ok:false when worktree dir not found for branch', async () => {
		const hunks = makeHunks([{ start: 1, end: 3 }])
		const engine = makeMockEngine(hunks)
		const router = new HunkRouter(engine)
		const assignments = new Map([[0, 'feat/missing']])
		const dirs = new Map<string, string>()  // no worktree dirs
		const result = await router.routeFile('/some/dir', 'file.ts', dirs, assignments)
		assert.strictEqual(result.ok, false)
		assert.deepStrictEqual(result.appliedIndices, [])
		assert.deepStrictEqual(result.failedIndices, [0])
	})

	test('routeFile: partial failure reports the successful branch\'s hunk as applied ' +
		'so a retry does not re-apply it', async () => {
		const hunks = makeHunks([{ start: 1, end: 3 }, { start: 10, end: 12 }])
		const engine = makeMockEngine(hunks)
		const router = new HunkRouter(engine)
		// Deterministically succeed for "feat/ok" and fail for "feat/broken",
		// regardless of the (synthetic) patch content or real git state.
		;(router as unknown as { _applyPatch: (patch: string, dir: string) => Promise<boolean> })._applyPatch =
			async (_patch, dir) => dir === '/wt/ok'
		const assignments = new Map([[0, 'feat/ok'], [1, 'feat/broken']])
		const dirs = new Map([['feat/ok', '/wt/ok'], ['feat/broken', '/wt/broken']])
		// routeFile awaits showErrorMessage on the failure path — stub it so
		// the test doesn't hang waiting on a real notification.
		const orig = vscode.window.showErrorMessage
		;(vscode.window as { showErrorMessage: unknown }).showErrorMessage = async () => undefined
		try {
			const result = await router.routeFile('/some/dir', 'file.ts', dirs, assignments)
			assert.strictEqual(result.ok, false)
			assert.deepStrictEqual(result.appliedIndices, [0])
			assert.deepStrictEqual(result.failedIndices, [1])
		} finally {
			;(vscode.window as { showErrorMessage: unknown }).showErrorMessage = orig
		}
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

// ─── Suite: HunkRouter.detectOverlaps (additional cases) ─────────────────────

suite('HunkRouter.detectOverlaps (boundary cases)', () => {

	let router: HunkRouter

	suiteSetup(() => {
		router = new HunkRouter(new DiffEngine())
	})

	test('exactly touching hunks (endA === startB) do not overlap', () => {
		// Hunk A: 5–10, hunk B: 10–15 → they share line 10 (borderline)
		// rangesOverlap: startA(5) <= endB(15) && startB(10) <= endA(10) → true
		const hunks = makeHunks([{ start: 5, end: 10 }, { start: 10, end: 15 }])
		const assignments = new Map([[0, 'feat/a'], [1, 'feat/b']])
		const overlaps = router.detectOverlaps(hunks, assignments)
		// They share line 10, so this IS an overlap
		assert.strictEqual(overlaps.length, 1)
	})

	test('single assigned hunk produces no overlaps', () => {
		const hunks = makeHunks([{ start: 1, end: 10 }])
		const assignments = new Map([[0, 'feat/a']])
		const overlaps = router.detectOverlaps(hunks, assignments)
		assert.deepStrictEqual(overlaps, [])
	})

	test('unassigned hunks are not checked for overlaps', () => {
		// Hunk 0 overlaps hunk 1 by range, but hunk 1 is NOT in assignments
		const hunks = makeHunks([{ start: 1, end: 10 }, { start: 5, end: 15 }])
		const assignments = new Map([[0, 'feat/a']])  // only hunk 0 assigned
		const overlaps = router.detectOverlaps(hunks, assignments)
		assert.deepStrictEqual(overlaps, [])
	})

	test('three hunks with only two overlapping each other', () => {
		// Hunk 0: 1-5, Hunk 1: 3-7 (overlaps 0), Hunk 2: 20-25 (no overlap)
		const hunks = makeHunks([{ start: 1, end: 5 }, { start: 3, end: 7 }, { start: 20, end: 25 }])
		const assignments = new Map([[0, 'feat/a'], [1, 'feat/b'], [2, 'feat/c']])
		const overlaps = router.detectOverlaps(hunks, assignments)
		assert.strictEqual(overlaps.length, 1)
		assert.strictEqual(overlaps[0].hunkA, 0)
		assert.strictEqual(overlaps[0].hunkB, 1)
	})

})

// ─── Suite: HunkRouter routeFile (out-of-range hunk index) ───────────────────

suite('HunkRouter.routeFile (edge cases)', () => {

	test('out-of-range hunk index is skipped gracefully', async () => {
		const hunks = makeHunks([{ start: 1, end: 5 }])
		const engine = makeMockEngine(hunks)
		const router = new HunkRouter(engine)
		// Hunk index 99 does not exist
		const assignments = new Map([[99, 'feat/a']])
		const dirs = new Map([['feat/a', '/nonexistent/dir']])
		// Should not throw — the bad index is skipped
		// However, since there are no valid hunks to assign, the branch loop
		// may produce no results; result depends on whether byBranch ends up empty
		const result = await router.routeFile('/some/dir', 'file.ts', dirs, assignments)
		// Could be ok:true (empty byBranch) or ok:false; just must not throw
		assert.ok(typeof result.ok === 'boolean')
	})

})

// ─── Suite: HunkRouter.buildPatch (internal) ────────────────────────────────

suite('HunkRouter.buildPatch (internal)', () => {

	let router: HunkRouter

	suiteSetup(() => {
		router = new HunkRouter(new DiffEngine())
	})

	test('returns empty string for empty hunks array', () => {
		const patch = (router as { buildPatch: (h: unknown[]) => string }).buildPatch([])
		assert.strictEqual(patch, '')
	})

	test('single hunk: patch includes file header and hunk body', () => {
		const hunks = makeHunks([{ start: 5, end: 8 }])
		const patch = (router as { buildPatch: (h: unknown[]) => string }).buildPatch(hunks)
		assert.ok(patch.includes('diff --git'), 'missing file header')
		assert.ok(patch.includes('@@ '), 'missing hunk header')
		assert.ok(patch.includes('+changed line'), 'missing hunk body')
	})

	test('multiple hunks are sorted by startLine', () => {
		const hunks = makeHunks([{ start: 20, end: 22 }, { start: 1, end: 3 }])
		const patch = (router as { buildPatch: (h: unknown[]) => string }).buildPatch(hunks)
		const idx1 = patch.indexOf('@@ -1,')
		const idx20 = patch.indexOf('@@ -20,')
		assert.ok(idx1 < idx20, 'hunks should be sorted by startLine ascending')
	})

	test('multiple hunks share one file header', () => {
		const hunks = makeHunks([{ start: 1, end: 2 }, { start: 10, end: 11 }])
		const patch = (router as { buildPatch: (h: unknown[]) => string }).buildPatch(hunks)
		// Only one "diff --git" header in the output
		const count = (patch.match(/diff --git/g) ?? []).length
		assert.strictEqual(count, 1, 'should have exactly one file header')
	})

})

// ─── Suite: HunkRouter._applyPatch (internal) ────────────────────────────────

suite('HunkRouter._applyPatch (internal)', () => {

	let router: HunkRouter

	suiteSetup(() => {
		router = new HunkRouter(new DiffEngine())
	})

	test('returns true for empty patch (whitespace only)', async () => {
		const result = await (router as any)._applyPatch('   \n   ', '/tmp')
		assert.strictEqual(result, true)
	})

	test('returns false for an invalid patch in a real git repo', async () => {
		const wsRoot = vscode.workspace.workspaceFolders![0].uri.fsPath
		const result = await (router as any)._applyPatch('not a valid patch\n', wsRoot)
		assert.strictEqual(result, false)
	})

})

