import * as assert from 'node:assert'
import { ProcessGitRunner, getDefaultGitRunner, setDefaultGitRunnerForTest } from '../src/gitRunner'
import { FakeGitRunner } from './helpers/fakeGitRunner'

suite('gitRunner', () => {

	// ── FakeGitRunner (unit-test seam) ────────────────────────────────────────

	test('FakeGitRunner: records calls and returns fixtures', async () => {
		const fake = new FakeGitRunner()
		fake.fixture('status --porcelain', { stdout: ' M foo.ts\n' })
		const result = await fake.run(['status', '--porcelain'], { cwd: '/tmp/x' })
		assert.strictEqual(result.stdout, ' M foo.ts\n')
		assert.strictEqual(result.exitCode, 0)
		assert.strictEqual(fake.calls.length, 1)
		assert.deepStrictEqual(fake.calls[0].args, ['status', '--porcelain'])
		assert.strictEqual(fake.calls[0].cwd, '/tmp/x')
	})

	test('FakeGitRunner: unmatched calls return exit=128 with diagnostic', async () => {
		const fake = new FakeGitRunner()
		const result = await fake.run(['rev-parse', 'HEAD'], { cwd: '/tmp/x' })
		assert.strictEqual(result.exitCode, 128)
		assert.match(result.stderr, /no fixture registered/)
	})

	test('FakeGitRunner: longer-prefix fixture wins over shorter for exact match', async () => {
		const fake = new FakeGitRunner()
		fake.fixture('status', { stdout: 'short\n' })
		const r1 = await fake.run(['status'], { cwd: '/tmp/x' })
		assert.strictEqual(r1.stdout, 'short\n')
		const r2 = await fake.run(['status', '--porcelain'], { cwd: '/tmp/x' })
		assert.strictEqual(r2.stdout, 'short\n')
	})

	// ── setDefaultGitRunnerForTest ────────────────────────────────────────────

	test('setDefaultGitRunnerForTest: swaps the default runner', () => {
		const fake = new FakeGitRunner()
		const original = getDefaultGitRunner()
		try {
			setDefaultGitRunnerForTest(fake)
			assert.strictEqual(getDefaultGitRunner(), fake)
		} finally {
			setDefaultGitRunnerForTest(undefined)
		}
		// After reset, the next call lazily reconstructs a ProcessGitRunner
		const after = getDefaultGitRunner()
		assert.ok(after !== fake)
		assert.ok(after instanceof ProcessGitRunner)
		assert.ok(original !== fake)
	})
})
