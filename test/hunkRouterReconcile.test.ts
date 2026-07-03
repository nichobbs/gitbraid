import * as assert from 'node:assert'
import { DiffEngine, DiffHunk, parseDiffHunks } from '../src/diffEngine'
import { HunkRouter, anchorFor, hunkBodyHash } from '../src/hunkRouter'
import type { HunkAnchor } from '../src/configTypes'

// Covers reviews/02-bugs-and-correctness.md "Hunk indices are fragile
// identifiers" / remediation T8.  The router must reconcile persisted
// hunk assignments against the live diff at route time so an unrelated
// edit that renumbers the hunks doesn't cause the wrong branch to receive
// the wrong lines.

function buildHunks(diff: string): DiffHunk[] {
	return parseDiffHunks(diff)
}

function diffWith(hunkHeader: string, body: string): string {
	return [
		'diff --git a/src/foo.ts b/src/foo.ts',
		'index abc..def 100644',
		'--- a/src/foo.ts',
		'+++ b/src/foo.ts',
		hunkHeader,
		body,
	].join('\n')
}

suite('HunkRouter reconciliation (T8)', () => {

	test('hunkBodyHash: deterministic + order-insensitive for different bodies', () => {
		const a = buildHunks(diffWith('@@ -1,1 +1,1 @@', ' context\n-old\n+new'))[0]
		const b = buildHunks(diffWith('@@ -1,1 +1,1 @@', ' context\n-old\n+different'))[0]
		assert.notStrictEqual(hunkBodyHash(a), hunkBodyHash(b))
		assert.strictEqual(hunkBodyHash(a), hunkBodyHash(a))
	})

	test('anchorFor: captures startLine, endLine, and bodyHash', () => {
		const h = buildHunks(diffWith('@@ -10,3 +10,5 @@', ' a\n b\n+c\n+d\n c'))[0]
		const anchor = anchorFor(h)
		assert.strictEqual(anchor.startLine, 10)
		assert.strictEqual(anchor.endLine, 14)
		assert.strictEqual(anchor.bodyHash.length, 12)
	})

	test('reconcile: unchanged hunk remains assigned even if renumbered', async () => {
		// Two hunks at setup time.  Stored anchor points at hunk index 1 (the
		// second hunk).  Simulate a new hunk inserted above → old "1" is now
		// live-index 2 but carries the same body.
		const origDiff = diffWith('@@ -10,1 +10,1 @@', '-target\n+target-modified') // index 0
		const origHunks = buildHunks(origDiff)
		const anchor = anchorFor(origHunks[0])

		const laterDiff = [
			'diff --git a/src/foo.ts b/src/foo.ts',
			'index abc..def 100644',
			'--- a/src/foo.ts',
			'+++ b/src/foo.ts',
			'@@ -1,1 +1,1 @@',         // new hunk at the top — index 0
			'-alpha\n+alpha-modified',
			'@@ -10,1 +10,1 @@',        // our target — now index 1
			'-target\n+target-modified',
		].join('\n')
		const laterHunks = buildHunks(laterDiff)
		assert.strictEqual(laterHunks.length, 2)

		// Build assignments/anchors as the router will receive them.
		const assignments = new Map<number, string>([[0, 'feature/x']])
		const anchors = new Map<number, HunkAnchor>([[0, anchor]])

		// Manual reconciliation sanity-check via the HunkRouter helper surface.
		const router = new HunkRouter(new DiffEngine())
		const { resolved: reconciled, originalIndexOf } = (router as unknown as {
			_reconcileAssignments: (h: DiffHunk[], a: Map<number, string>, an?: Map<number, HunkAnchor>) =>
				{ resolved: Map<number, string>, originalIndexOf: Map<number, number> }
		})._reconcileAssignments(laterHunks, assignments, anchors)

		// The assignment should now point at live index 1, not 0.
		assert.strictEqual(reconciled.get(1), 'feature/x')
		assert.strictEqual(reconciled.has(0), false)
		// The original (persisted) index must still be recoverable so the
		// router can clear/report success against what's actually on disk.
		assert.strictEqual(originalIndexOf.get(1), 0)
	})

	test('reconcile: missing anchor falls back to legacy index behaviour', () => {
		const hunks = buildHunks(diffWith('@@ -5,1 +5,1 @@', '-x\n+y'))
		const assignments = new Map<number, string>([[0, 'feature/legacy']])
		const router = new HunkRouter(new DiffEngine())
		const { resolved: reconciled } = (router as unknown as {
			_reconcileAssignments: (h: DiffHunk[], a: Map<number, string>, an?: Map<number, HunkAnchor>) =>
				{ resolved: Map<number, string>, originalIndexOf: Map<number, number> }
		})._reconcileAssignments(hunks, assignments, undefined)
		assert.strictEqual(reconciled.get(0), 'feature/legacy')
	})

	test('reconcile: drops a stale assignment whose hunk is gone', () => {
		// Stored anchor references a body hash that no longer exists in the
		// live diff and lies outside any current hunk's range.
		const staleAnchor: HunkAnchor = {
			startLine: 100,
			endLine: 105,
			bodyHash: 'zzzzzzzzzzzz',
		}
		const liveHunks = buildHunks(diffWith('@@ -1,1 +1,1 @@', '-a\n+b'))
		const assignments = new Map<number, string>([[7, 'feature/stale']])
		const anchors = new Map<number, HunkAnchor>([[7, staleAnchor]])
		const router = new HunkRouter(new DiffEngine())
		const { resolved: reconciled } = (router as unknown as {
			_reconcileAssignments: (h: DiffHunk[], a: Map<number, string>, an?: Map<number, HunkAnchor>) =>
				{ resolved: Map<number, string>, originalIndexOf: Map<number, number> }
		})._reconcileAssignments(liveHunks, assignments, anchors)
		assert.strictEqual(reconciled.size, 0)
	})
})
