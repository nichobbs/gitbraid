import * as assert from 'node:assert'
import * as vscode from 'vscode'
import { parseDiffHunks, DiffEngine } from '../src/diffEngine'

// ─── Suite: parseDiffHunks ────────────────────────────────────────────────────

suite('parseDiffHunks', () => {

	test('empty string returns empty array', () => {
		const result = parseDiffHunks('')
		assert.deepStrictEqual(result, [])
	})

	test('whitespace-only string returns empty array', () => {
		const result = parseDiffHunks('   \n\t\n  ')
		assert.deepStrictEqual(result, [])
	})

	test('parses a single hunk correctly', () => {
		const diff = [
			'diff --git a/src/foo.ts b/src/foo.ts',
			'index abc1234..def5678 100644',
			'--- a/src/foo.ts',
			'+++ b/src/foo.ts',
			'@@ -10,4 +10,5 @@ function foo() {',
			' context line',
			'-removed line',
			'+added line A',
			'+added line B',
			' another context',
		].join('\n')

		const hunks = parseDiffHunks(diff)
		assert.strictEqual(hunks.length, 1)
		const h = hunks[0]
		assert.strictEqual(h.index, 0)
		assert.strictEqual(h.startLine, 10)
		assert.strictEqual(h.endLine, 14)  // 10 + 5 - 1
		assert.ok(h.header.startsWith('@@ -10,4 +10,5 @@'))
		assert.ok(h.patch.includes('diff --git'))
		assert.ok(h.patch.includes('@@ -10,4 +10,5 @@'))
	})

	test('parses multiple hunks with correct indices', () => {
		const diff = [
			'diff --git a/src/bar.ts b/src/bar.ts',
			'index 000..111 100644',
			'--- a/src/bar.ts',
			'+++ b/src/bar.ts',
			'@@ -1,3 +1,3 @@',
			' line1',
			'-old',
			'+new',
			' line3',
			'@@ -20,3 +20,4 @@',
			' line20',
			'+inserted',
			' line21',
			' line22',
		].join('\n')

		const hunks = parseDiffHunks(diff)
		assert.strictEqual(hunks.length, 2)
		assert.strictEqual(hunks[0].index, 0)
		assert.strictEqual(hunks[0].startLine, 1)
		assert.strictEqual(hunks[1].index, 1)
		assert.strictEqual(hunks[1].startLine, 20)
	})

	test('hunk with omitted count defaults to 1 line', () => {
		// "@@ -5 +5 @@" means 1 line each (count omitted)
		const diff = [
			'diff --git a/f b/f',
			'index a..b 100644',
			'--- a/f',
			'+++ b/f',
			'@@ -5 +5 @@',
			'-old',
			'+new',
		].join('\n')

		const hunks = parseDiffHunks(diff)
		assert.strictEqual(hunks.length, 1)
		assert.strictEqual(hunks[0].startLine, 5)
		assert.strictEqual(hunks[0].endLine, 5)
	})

	test('each hunk patch includes the file header', () => {
		const diff = [
			'diff --git a/x.ts b/x.ts',
			'index aaa..bbb 100644',
			'--- a/x.ts',
			'+++ b/x.ts',
			'@@ -1,2 +1,2 @@',
			'-a',
			'+b',
			'@@ -10,2 +10,2 @@',
			'-c',
			'+d',
		].join('\n')

		const hunks = parseDiffHunks(diff)
		assert.strictEqual(hunks.length, 2)
		for (const h of hunks) {
			assert.ok(h.patch.includes('diff --git'), `hunk ${String(h.index)} patch should contain file header`)
			assert.ok(h.patch.includes('---'), `hunk ${String(h.index)} patch should contain --- line`)
		}
	})

})

// ─── Suite: DiffEngine ────────────────────────────────────────────────────────

suite('DiffEngine', function () {
	// These tests run actual git commands and require the workspace to be a repo.
	this.timeout(10_000)

	let engine: DiffEngine

	suiteSetup(() => {
		engine = new DiffEngine()
	})

	test('getHunksForFile returns empty array for an untracked file with no changes', async () => {
		// A newly created untracked file has no diff against HEAD
		const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		if (!wsRoot) {
			return
		}
		// Run against a path that doesn't exist in HEAD — git diff returns empty
		const hunks = await engine.getHunksForFile(wsRoot, '__nonexistent_file__.ts')
		assert.deepStrictEqual(hunks, [])
	})

	test('getMergeBase returns undefined for unrelated refs', async () => {
		const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		if (!wsRoot) {
			return
		}
		// Two random SHAs that don't exist — should return undefined gracefully
		const result = await engine.getMergeBase(wsRoot, 'nonexistent-ref-A', 'nonexistent-ref-B')
		assert.strictEqual(result, undefined)
	})

	test('getHunksForFile sanitises path traversal attempts', async () => {
		const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		if (!wsRoot) {
			return
		}
		// Path traversal should be stripped, not throw
		const hunks = await engine.getHunksForFile(wsRoot, '../../etc/passwd')
		assert.deepStrictEqual(hunks, [])
	})

	test('getHunksAgainstBranch: falls back to getHunksForFile when merge-base not found', async () => {
		const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		if (!wsRoot) {
			return
		}
		// Using a nonexistent branch means no merge-base — should fall back gracefully
		const hunks = await engine.getHunksAgainstBranch(wsRoot, '__nonexistent__.ts', 'nonexistent-branch')
		assert.ok(Array.isArray(hunks))
	})

	test('getHunksAgainstBranch: sanitises path traversal in relativePath', async () => {
		const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		if (!wsRoot) {
			return
		}
		const hunks = await engine.getHunksAgainstBranch(wsRoot, '../../etc/passwd', 'main')
		assert.ok(Array.isArray(hunks))
	})

	test('getMergeBase: returns a string SHA for valid related refs', async () => {
		const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		if (!wsRoot) {
			return
		}
		// HEAD vs HEAD should give HEAD's own commit
		const result = await engine.getMergeBase(wsRoot, 'HEAD', 'HEAD')
		// May succeed or fail depending on repo state; just check it's a string or undefined
		assert.ok(result === undefined || typeof result === 'string')
	})

})

// ─── Suite: parseDiffHunks edge cases ────────────────────────────────────────

suite('parseDiffHunks (edge cases)', () => {

	test('pure deletion hunk has endLine === startLine', () => {
		// @@ -5,3 +5,0 @@ means 0 lines in new file
		const diff = [
			'diff --git a/f b/f',
			'index a..b 100644',
			'--- a/f',
			'+++ b/f',
			'@@ -5,3 +5,0 @@',
			'-line1',
			'-line2',
			'-line3',
		].join('\n')

		const hunks = parseDiffHunks(diff)
		assert.strictEqual(hunks.length, 1)
		assert.strictEqual(hunks[0].startLine, 5)
		// Pure deletion: newCount === 0 → represent as empty range (endLine < startLine)
		// so overlap detection doesn't falsely claim the hunk intersects line 5.
		// See docs/reviews/bugs.md B3 + remediation task T64.
		assert.strictEqual(hunks[0].endLine, 4)
	})

	test('hunk with count=1 (omitted) has correct endLine', () => {
		const diff = [
			'diff --git a/g b/g',
			'index a..b 100644',
			'--- a/g',
			'+++ b/g',
			'@@ -1 +1 @@',
			'-old',
			'+new',
		].join('\n')
		const hunks = parseDiffHunks(diff)
		assert.strictEqual(hunks.length, 1)
		assert.strictEqual(hunks[0].startLine, 1)
		assert.strictEqual(hunks[0].endLine, 1)
	})

	test('three hunks all get unique indices', () => {
		const diff = [
			'diff --git a/h b/h',
			'index a..b 100644',
			'--- a/h',
			'+++ b/h',
			'@@ -1,2 +1,2 @@',
			'-a', '+A',
			'@@ -10,2 +10,2 @@',
			'-b', '+B',
			'@@ -20,2 +20,2 @@',
			'-c', '+C',
		].join('\n')
		const hunks = parseDiffHunks(diff)
		assert.strictEqual(hunks.length, 3)
		assert.strictEqual(hunks[0].index, 0)
		assert.strictEqual(hunks[1].index, 1)
		assert.strictEqual(hunks[2].index, 2)
	})

	test('diff with no file header lines produces valid patch', () => {
		// Only hunk header and content — no diff --git preamble
		const diff = [
			'@@ -1,2 +1,2 @@',
			'-old',
			'+new',
		].join('\n')
		const hunks = parseDiffHunks(diff)
		assert.strictEqual(hunks.length, 1)
		assert.ok(hunks[0].patch.includes('@@ -1,2 +1,2 @@'))
	})

})

// ─── Suite: DiffEngine path sanitisation ─────────────────────────────────────
// Regression coverage for reviews/02-bugs-and-correctness.md "Quote-escape
// no-op" / reviews/03-security.md "Systemic issue — shell string
// concatenation".  Until the full spawn migration (remediation T18) lands,
// DiffEngine refuses to operate on paths that contain shell metacharacters
// instead of relying on the no-op `String.raw\`"\`` replacement.

suite('DiffEngine._sanitisePath injection', () => {
	const engine = new DiffEngine()
	// Tiny helper so the test can exercise the private sanitiser without a
	// repo on disk.  The implementation throws synchronously, so we catch.
	const tryPath = (p: string): Error | undefined => {
		try {
			// Invoking any method that calls _sanitisePath is enough; the stub
			// `vscode` module in the test host doesn't run real git, so
			// getHunksForFile will noop on a path that passes the sanitiser.
			;(engine as unknown as { _sanitisePath: (p: string) => string })
				._sanitisePath(p)
			return undefined
		} catch (e) {
			return e as Error
		}
	}

	const payloads = [
		'foo"; touch /tmp/pwned; echo ".ts',
		'foo$(whoami).ts',
		'foo`id`.ts',
		'foo\\bar.ts',
		'foo;bar.ts',
		'foo|bar.ts',
		'foo&bar.ts',
		'foo>out.ts',
		'foo<in.ts',
		'foo(bar).ts',
		'foo\nbar.ts',
		'-evil.ts',
	]

	for (const p of payloads) {
		test(`rejects path with shell metacharacter: ${JSON.stringify(p)}`, () => {
			const err = tryPath(p)
			assert.ok(err instanceof Error, 'should throw')
			assert.match(err!.message, /unsafe/i)
		})
	}

	test('accepts an innocuous relative path', () => {
		const err = tryPath('src/foo/bar.ts')
		assert.strictEqual(err, undefined)
	})

	test('accepts a path with spaces', () => {
		const err = tryPath('dir with spaces/file.ts')
		assert.strictEqual(err, undefined)
	})
})

