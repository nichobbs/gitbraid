import * as assert from 'node:assert'
import {
	renderStackBlock,
	mergeStackBlock,
	parseGithubSlug,
	NullPRHostAdapter,
} from '../src/prHostAdapter'

suite('prHostAdapter: renderStackBlock', () => {
	test('renders a 3-branch stack with current marker', () => {
		const block = renderStackBlock(
			[
				{ name: 'feature/a', prNumber: 100 },
				{ name: 'feature/b', prNumber: 101 },
				{ name: 'feature/c' },
			],
			'feature/b',
		)
		// Deterministic output — pinned here so regressions are obvious.
		const expected = [
			'<!-- gitbraid:stack-start -->',
			'Stacked PRs (bottom first):',
			'1. #100 feature/a',
			'2. #101 feature/b  ← you are here',
			'3. feature/c',
			'<!-- gitbraid:stack-end -->',
		].join('\n')
		assert.strictEqual(block, expected)
	})

	test('renders an empty stack', () => {
		const block = renderStackBlock([], 'feature/a')
		assert.ok(block.startsWith('<!-- gitbraid:stack-start -->'))
		assert.ok(block.endsWith('<!-- gitbraid:stack-end -->'))
	})
})

suite('prHostAdapter: mergeStackBlock', () => {
	const block = renderStackBlock([{ name: 'feature/a', prNumber: 1 }], 'feature/a')

	test('prepends when no existing block', () => {
		const merged = mergeStackBlock('Original body text.', block)
		assert.ok(merged.startsWith('<!-- gitbraid:stack-start -->'))
		assert.ok(merged.includes('Original body text.'))
	})

	test('replaces an existing block in place', () => {
		const firstBody = mergeStackBlock('User description.', block)
		const secondBlock = renderStackBlock([{ name: 'feature/b', prNumber: 2 }], 'feature/b')
		const merged = mergeStackBlock(firstBody, secondBlock)
		// The first block's contents are gone, the new block is present,
		// and the user description survives.
		assert.ok(!merged.includes('feature/a'))
		assert.ok(merged.includes('feature/b'))
		assert.ok(merged.includes('User description.'))
	})

	test('honours the do-not-touch sentinel at the top of the body', () => {
		const protectedBody = '<!-- gitbraid:no-touch -->\nMy hand-crafted description.'
		assert.strictEqual(mergeStackBlock(protectedBody, block), protectedBody)
	})

	test('writing twice is idempotent', () => {
		const once = mergeStackBlock('Body.', block)
		const twice = mergeStackBlock(once, block)
		assert.strictEqual(once, twice)
	})
})

suite('prHostAdapter: parseGithubSlug', () => {
	test('parses https without .git suffix', () => {
		assert.deepStrictEqual(
			parseGithubSlug('https://github.com/foo/bar'),
			{ owner: 'foo', repo: 'bar' },
		)
	})

	test('parses https with .git suffix', () => {
		assert.deepStrictEqual(
			parseGithubSlug('https://github.com/foo/bar.git'),
			{ owner: 'foo', repo: 'bar' },
		)
	})

	test('parses ssh url', () => {
		assert.deepStrictEqual(
			parseGithubSlug('git@github.com:foo/bar.git'),
			{ owner: 'foo', repo: 'bar' },
		)
	})

	test('returns undefined for non-github remotes', () => {
		assert.strictEqual(parseGithubSlug(''), undefined)
		assert.strictEqual(parseGithubSlug('https://gitlab.com/foo/bar'), undefined)
	})
})

suite('prHostAdapter: NullPRHostAdapter', () => {
	test('detect returns true (terminal fallback)', async () => {
		const a = new NullPRHostAdapter()
		assert.strictEqual(await a.detect(), true)
	})

	test('getPR returns undefined', async () => {
		assert.strictEqual(await new NullPRHostAdapter().getPR(), undefined)
	})

	test('createPR throws a user-visible message', async () => {
		await assert.rejects(
			() => new NullPRHostAdapter().createPR(),
			/no PR host/,
		)
	})
})
