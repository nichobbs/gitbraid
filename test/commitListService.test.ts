import * as assert from 'node:assert'
import { CommitListService, parseLogOutput } from '../src/commitListService'
import { FakeGitRunner } from './helpers/fakeGitRunner'

suite('commitListService: parseLogOutput', () => {
	test('parses a three-commit log', () => {
		const SEP = '\x1f'
		const stdout = [
			['aaaa111', 'first', '2026-01-01T00:00:00Z', 'Alice'].join(SEP),
			['bbbb222', 'second', '2026-01-02T00:00:00Z', 'Bob'].join(SEP),
			['cccc333', 'third', '2026-01-03T00:00:00Z', 'Carol'].join(SEP),
		].join('\n')
		const commits = parseLogOutput(stdout)
		assert.strictEqual(commits.length, 3)
		assert.strictEqual(commits[0].sha, 'aaaa111')
		assert.strictEqual(commits[0].shortSha, 'aaaa111')
		assert.strictEqual(commits[1].author, 'Bob')
		assert.strictEqual(commits[2].subject, 'third')
	})

	test('returns empty for empty stdout', () => {
		assert.deepStrictEqual(parseLogOutput(''), [])
	})
})

suite('CommitListService', () => {
	test('lists commits between base and branch via git log', async () => {
		const SEP = '\x1f'
		const runner = new FakeGitRunner()
		runner.fixture(
			`log --first-parent --format=%H${SEP}%s${SEP}%aI${SEP}%an main..feature/a`,
			{
				stdout: [
					['abcdef0123456789abcdef0123456789abcdef01', 'feat: a', '2026-01-01T00:00:00Z', 'Alice'].join(SEP),
					['1234567890abcdef1234567890abcdef12345678', 'fix: b', '2026-01-02T00:00:00Z', 'Bob'].join(SEP),
				].join('\n'),
			},
		)
		const svc = new CommitListService(runner)
		const commits = await svc.listCommits('/tmp/worktree', 'feature/a', 'main')
		assert.strictEqual(commits.length, 2)
		assert.strictEqual(commits[0].subject, 'feat: a')
		assert.strictEqual(commits[0].shortSha, 'abcdef0')
	})

	test('caches results until invalidated', async () => {
		const runner = new FakeGitRunner()
		runner.fixture(
			'log --first-parent --format=',
			{ stdout: 'abcdef1\x1ffirst\x1f2026-01-01T00:00:00Z\x1fAlice' },
		)
		const svc = new CommitListService(runner)
		await svc.listCommits('/tmp', 'b', 'main')
		await svc.listCommits('/tmp', 'b', 'main')
		// Only one call — second hit came from cache.
		assert.strictEqual(runner.calls.length, 1)
		svc.invalidate('/tmp', 'b')
		await svc.listCommits('/tmp', 'b', 'main')
		assert.strictEqual(runner.calls.length, 2)
	})
})
