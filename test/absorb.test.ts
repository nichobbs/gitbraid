import * as assert from 'node:assert'
import { parseBlameShas, dominantCommitForHunk } from '../src/absorb'
import { FakeGitRunner } from './helpers/fakeGitRunner'
import { DiffHunk } from '../src/diffEngine'

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
})
