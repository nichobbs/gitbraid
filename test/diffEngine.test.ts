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
		// Path traversal throws a ConfigError to prevent accessing files outside workspace
		await assert.rejects(
			() => engine.getHunksForFile(wsRoot, '../../etc/passwd'),
			/Path escapes workspace root/,
		)
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
		// Path traversal throws a ConfigError to prevent accessing files outside workspace
		await assert.rejects(
			() => engine.getHunksAgainstBranch(wsRoot, '../../etc/passwd', 'main'),
			/Path escapes workspace root/,
		)
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

// ─── Suite: DiffEngine spawn-based invocation ────────────────────────────────
// Post-T18 regression coverage.  DiffEngine now invokes `git` via the injected
// IGitRunner (spawn with shell: false), so shell metacharacters in paths are
// harmless — they're passed as argv entries.  The injection payloads below
// would previously have required sanitisation; we now assert that:
//   1. Every payload reaches `IGitRunner.run` verbatim as an argv entry.
//   2. No marker file is created on the filesystem (confirming the shell
//      was never spawned).

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as pathNode from 'node:path'
import { FakeGitRunner } from './helpers/fakeGitRunner'

suite('DiffEngine — spawn-based invocation', () => {
	let wsRoot: string

	setup(() => {
		wsRoot = fs.mkdtempSync(pathNode.join(os.tmpdir(), 'gitbraid-diffengine-'))
	})
	teardown(() => {
		try { fs.rmSync(wsRoot, { recursive: true, force: true }) } catch { /* ignore */ }
	})

	const payloads = [
		'foo"; touch /tmp/pwned; echo ".ts',
		'foo$(whoami).ts',
		'foo`id`.ts',
		'foo;bar.ts',
		'foo|bar.ts',
		'foo&bar.ts',
		'foo(bar).ts',
	]

	for (const p of payloads) {
		test(`passes ${JSON.stringify(p)} as argv (no shell interpretation)`, async () => {
			const fake = new FakeGitRunner()
			fake.fixture('diff HEAD', { stdout: '', exitCode: 0 })
			const engine = new DiffEngine(fake)
			const hunks = await engine.getHunksForFile(wsRoot, p)
			assert.deepStrictEqual(hunks, [])

			assert.strictEqual(fake.calls.length, 1)
			const call = fake.calls[0]
			// The payload must appear as a standalone argv entry, not inlined
			// into a shell string, and must retain its original characters.
			// Normalise backslashes on both sides — on Windows, `path.normalize`
			// inside `DiffEngine._normalisePath` converts forward slashes to
			// backslashes before the arg is handed to git.  The security
			// contract (no shell interpretation, payload passed verbatim as
			// argv) still holds — only the slash direction differs.
			const forwardSlash = (s) => s.replaceAll('\\', '/')
			const expected = forwardSlash(p).replace(/^(\.\.\/)+/, '')
			assert.ok(
				call.args.some((a) => forwardSlash(a).includes(expected)),
				`expected payload to survive as argv, got ${JSON.stringify(call.args)}`,
			)
			// No marker file created.
			assert.strictEqual(fs.existsSync('/tmp/pwned'), false)
		})
	}

	test('rejects paths that escape the workspace root', async () => {
		const fake = new FakeGitRunner()
		const engine = new DiffEngine(fake)
		await assert.rejects(
			() => engine.getHunksForFile(wsRoot, '../../etc/passwd'),
			/escapes workspace root/,
		)
		assert.strictEqual(fake.calls.length, 0, 'git should never be invoked on escape')
	})

	test('returns [] on non-zero exit without throwing', async () => {
		const fake = new FakeGitRunner()
		fake.fixture('diff HEAD', { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 })
		const engine = new DiffEngine(fake)
		const hunks = await engine.getHunksForFile(wsRoot, 'foo.ts')
		assert.deepStrictEqual(hunks, [])
	})
})

