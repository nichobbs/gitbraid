import * as assert from 'node:assert'
import { parseBlameShas, dominantCommitForHunk, absorbFiles } from '../src/absorb'
import { FakeGitRunner } from './helpers/fakeGitRunner'
import { DiffEngine, DiffHunk } from '../src/diffEngine'

suite('absorb: parseBlameShas', () => {
	test('extracts shas from porcelain output', () => {
		const stdout = [
			'abcdef1234567890abcdef1234567890abcdef12 1 1 3',
			'author Nich',
			'\tfirst line',
			'abcdef1234567890abcdef1234567890abcdef12 2 2',
			'author Nich',
			'\tsecond line',
			'fedcba0987654321fedcba0987654321fedcba09 3 3',
			'author Other',
			'\tthird line',
		].join('\n')
		const shas = parseBlameShas(stdout)
		assert.deepStrictEqual(shas, [
			'abcdef1234567890abcdef1234567890abcdef12',
			'abcdef1234567890abcdef1234567890abcdef12',
			'fedcba0987654321fedcba0987654321fedcba09',
		])
	})

	test('returns empty for empty input', () => {
		assert.deepStrictEqual(parseBlameShas(''), [])
	})
})

const hunk: DiffHunk = {
	index: 0,
	startLine: 1,
	endLine: 5,
	header: '@@ -1,5 +1,5 @@',
	patch: 'diff ...',
}

const shaA = 'a'.repeat(40)
const shaB = 'b'.repeat(40)
const shaOld = 'c'.repeat(40)
const mergeBase = 'd'.repeat(40)

function fakeRunnerWithBlame(lines: string[], ancestors: Record<string, boolean>): FakeGitRunner {
	const r = new FakeGitRunner()
	r.fixture('blame --line-porcelain -L 1,5 -- file.ts', { stdout: lines.join('\n') })
	for (const [sha, isAncestor] of Object.entries(ancestors)) {
		r.fixture(`merge-base --is-ancestor ${sha} ${mergeBase}`, { exitCode: isAncestor ? 0 : 1 })
	}
	return r
}

suite('absorb: dominantCommitForHunk', () => {
	test('picks majority commit', async () => {
		const r = fakeRunnerWithBlame(
			[
				`${shaA} 1 1`,
				'\tline 1',
				`${shaA} 2 2`,
				'\tline 2',
				`${shaA} 3 3`,
				'\tline 3',
				`${shaB} 4 4`,
				'\tline 4',
				`${shaB} 5 5`,
				'\tline 5',
			],
			{ [shaA]: false, [shaB]: false },
		)
		const result = await dominantCommitForHunk('/tmp', 'file.ts', hunk, mergeBase, r)
		assert.strictEqual(result.kind, 'ok')
		if (result.kind === 'ok') {
			assert.strictEqual(result.sha, shaA)
		}
	})

	test('excludes commits outside the branch range (ancestor of merge-base)', async () => {
		const r = fakeRunnerWithBlame(
			[
				`${shaOld} 1 1`,
				'\tline 1',
				`${shaOld} 2 2`,
				'\tline 2',
				`${shaOld} 3 3`,
				'\tline 3',
				`${shaB} 4 4`,
				'\tline 4',
				`${shaB} 5 5`,
				'\tline 5',
			],
			{ [shaOld]: true, [shaB]: false },
		)
		const result = await dominantCommitForHunk('/tmp', 'file.ts', hunk, mergeBase, r)
		// shaOld is filtered out, so shaB wins.
		assert.strictEqual(result.kind, 'ok')
		if (result.kind === 'ok') {
			assert.strictEqual(result.sha, shaB)
		}
	})

	test('returns unresolved when blame is 2-way split', async () => {
		const r = fakeRunnerWithBlame(
			[
				`${shaA} 1 1`,
				'\tline 1',
				`${shaA} 2 2`,
				'\tline 2',
				`${shaB} 3 3`,
				'\tline 3',
				`${shaB} 4 4`,
				'\tline 4',
			],
			{ [shaA]: false, [shaB]: false },
		)
		const evenHunk: DiffHunk = { ...hunk, endLine: 4 }
		// Force the blame fixture key to match the new range.
		r.reset()
		r.fixture('blame --line-porcelain -L 1,4 -- file.ts', {
			stdout: [
				`${shaA} 1 1`,
				'\tline 1',
				`${shaA} 2 2`,
				'\tline 2',
				`${shaB} 3 3`,
				'\tline 3',
				`${shaB} 4 4`,
				'\tline 4',
			].join('\n'),
		})
		r.fixture(`merge-base --is-ancestor ${shaA} ${mergeBase}`, { exitCode: 1 })
		r.fixture(`merge-base --is-ancestor ${shaB} ${mergeBase}`, { exitCode: 1 })
		const result = await dominantCommitForHunk('/tmp', 'file.ts', evenHunk, mergeBase, r)
		assert.strictEqual(result.kind, 'unresolved')
	})

	test('pure-deletion hunk returns unresolved without calling blame', async () => {
		const deletion: DiffHunk = { ...hunk, startLine: 10, endLine: 9 }
		const r = new FakeGitRunner()
		const result = await dominantCommitForHunk('/tmp', 'file.ts', deletion, mergeBase, r)
		assert.strictEqual(result.kind, 'unresolved')
		assert.strictEqual(r.calls.length, 0)
	})

	test('blame failure returns unresolved with stderr', async () => {
		const r = new FakeGitRunner()
		r.fixture('blame --line-porcelain -L 1,5 -- file.ts', { exitCode: 1, stderr: 'no such file' })
		const result = await dominantCommitForHunk('/tmp', 'file.ts', hunk, mergeBase, r)
		assert.strictEqual(result.kind, 'unresolved')
		if (result.kind === 'unresolved') {
			assert.match(result.reason, /no such file/)
		}
	})

	test('empty blame returns unresolved with explanation', async () => {
		const r = new FakeGitRunner()
		r.fixture('blame --line-porcelain -L 1,5 -- file.ts', { stdout: '', exitCode: 0 })
		const result = await dominantCommitForHunk('/tmp', 'file.ts', hunk, mergeBase, r)
		assert.strictEqual(result.kind, 'unresolved')
	})

	test('only-uncommitted blame returns unresolved (zero sha filtered)', async () => {
		const zero = '0'.repeat(40)
		const r = new FakeGitRunner()
		r.fixture('blame --line-porcelain -L 1,5 -- file.ts', {
			stdout: [
				`${zero} 1 1`,
				'\ta',
				`${zero} 2 2`,
				'\tb',
			].join('\n'),
			exitCode: 0,
		})
		const result = await dominantCommitForHunk('/tmp', 'file.ts', hunk, mergeBase, r)
		assert.strictEqual(result.kind, 'unresolved')
	})
})

// ─── absorbFiles ────────────────────────────────────────────────────────────

class StubDiffEngine extends DiffEngine {

	constructor(private readonly _byFile: Map<string, DiffHunk[]>) {
		super()
	}

	override async getHunksForFile(_root: string, rel: string): Promise<DiffHunk[]> {
		return this._byFile.get(rel) ?? []
	}
}

function fakeRunnerForAbsorb(): FakeGitRunner {
	const r = new FakeGitRunner()
	r.fixture('reset HEAD', { exitCode: 0 })
	r.fixture('apply --cached --unidiff-zero -', { exitCode: 0 })
	// The log must include sha1 so orderCommitsByHistory finds it.
	r.fixture('log --format=%H HEAD', { stdout: `${sha1}\ncommitsha222\n` })
	return r
}

const sha1 = 'a'.repeat(40)
const mergeBase2 = 'd'.repeat(40)

const someHunk: DiffHunk = {
	index: 0,
	startLine: 1,
	endLine: 3,
	header: '@@ -1,3 +1,3 @@',
	patch: 'diff --git a/file.ts b/file.ts\n@@ -1,3 +1,3 @@\n-a\n+b\n',
}

suite('absorb: absorbFiles', () => {
	test('dryRun: builds plan without mutating', async () => {
		const r = fakeRunnerForAbsorb()
		r.fixture('blame --line-porcelain -L 1,3 -- file.ts', {
			stdout: [
				`${sha1} 1 1`,
				'\ta',
				`${sha1} 2 2`,
				'\tb',
				`${sha1} 3 3`,
				'\tc',
			].join('\n'),
		})
		r.fixture(`merge-base --is-ancestor ${sha1} ${mergeBase2}`, { exitCode: 1 })
		const engine = new StubDiffEngine(new Map([['file.ts', [someHunk]]]))
		const { plan, summary } = await absorbFiles('/tmp', 'feat/a', ['file.ts'], engine, {
			mergeBase: mergeBase2,
			dryRun: true,
		}, r)
		assert.strictEqual(summary, undefined)
		assert.strictEqual(plan.hunks.length, 1)
		assert.strictEqual(plan.hunks[0].targetSha, sha1)
		// No mutating commands ran
		const mutating = r.calls.filter((c) => c.args[0] === 'commit' || c.args[0] === 'apply')
		assert.strictEqual(mutating.length, 0)
	})

	test('full run: stages hunks, fixup-commits, and runs autosquash', async () => {
		const r = fakeRunnerForAbsorb()
		r.fixture('blame --line-porcelain -L 1,3 -- file.ts', {
			stdout: [
				`${sha1} 1 1`,
				'\ta',
				`${sha1} 2 2`,
				'\tb',
				`${sha1} 3 3`,
				'\tc',
			].join('\n'),
		})
		r.fixture(`merge-base --is-ancestor ${sha1} ${mergeBase2}`, { exitCode: 1 })
		// Branch -r --contains <sha>: nothing pushed
		r.fixture(`branch -r --contains ${sha1}`, { stdout: '' })
		r.fixture('commit', { exitCode: 0 })
		r.fixture('-c sequence.editor=: rebase --autosquash --autostash', { exitCode: 0 })

		const engine = new StubDiffEngine(new Map([['file.ts', [someHunk]]]))
		const { summary } = await absorbFiles('/tmp', 'feat/a', ['file.ts'], engine, {
			mergeBase: mergeBase2,
		}, r)
		assert.ok(summary)
		assert.strictEqual(summary!.absorbed, 1)
		assert.strictEqual(summary!.rebaseOk, true)
	})

	test('refuses when target commit already pushed and override flag is off', async () => {
		const r = fakeRunnerForAbsorb()
		r.fixture('blame --line-porcelain -L 1,3 -- file.ts', {
			stdout: [
				`${sha1} 1 1`,
				'\ta',
				`${sha1} 2 2`,
				'\tb',
				`${sha1} 3 3`,
				'\tc',
			].join('\n'),
		})
		r.fixture(`merge-base --is-ancestor ${sha1} ${mergeBase2}`, { exitCode: 1 })
		r.fixture(`branch -r --contains ${sha1}`, { stdout: 'origin/main\n' })

		const engine = new StubDiffEngine(new Map([['file.ts', [someHunk]]]))
		const { summary } = await absorbFiles('/tmp', 'feat/a', ['file.ts'], engine, {
			mergeBase: mergeBase2,
		}, r)
		assert.ok(summary)
		assert.strictEqual(summary!.absorbed, 0)
		assert.strictEqual(summary!.skipped, 1)
		assert.ok(summary!.errors.some((e) => /already pushed/.test(e.message)))
	})

	test('no resolved hunks → rebase not attempted, summary reports skipped', async () => {
		const r = fakeRunnerForAbsorb()
		// Pure-deletion hunk → unresolved without blame.
		const deleted: DiffHunk = { ...someHunk, startLine: 10, endLine: 9 }
		const engine = new StubDiffEngine(new Map([['file.ts', [deleted]]]))
		const { summary } = await absorbFiles('/tmp', 'feat/a', ['file.ts'], engine, {
			mergeBase: mergeBase2,
		}, r)
		assert.ok(summary)
		assert.strictEqual(summary!.absorbed, 0)
		assert.strictEqual(summary!.skipped, 1)
		// rebaseOk is true because we didn't try to rebase (no fixups created)
		assert.strictEqual(summary!.rebaseOk, true)
	})
})
