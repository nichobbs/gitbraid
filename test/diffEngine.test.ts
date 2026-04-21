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

})
