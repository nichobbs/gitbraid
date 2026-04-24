import * as assert from 'node:assert'
import {
	renderStackBlock,
	mergeStackBlock,
	parseGithubSlug,
	parseGitlabSlug,
	parseBitbucketSlug,
	parseAzureDevOpsSlug,
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

suite('prHostAdapter: parseGitlabSlug', () => {
	test('parses gitlab.com https', () => {
		assert.deepStrictEqual(
			parseGitlabSlug('https://gitlab.com/foo/bar.git'),
			{ projectId: 'foo/bar', host: 'https://gitlab.com' },
		)
	})

	test('parses ssh URL', () => {
		assert.deepStrictEqual(
			parseGitlabSlug('git@gitlab.com:foo/bar.git'),
			{ projectId: 'foo/bar', host: 'https://gitlab.com' },
		)
	})

	test('preserves nested group path', () => {
		assert.deepStrictEqual(
			parseGitlabSlug('https://gitlab.example.com/group/subgroup/project.git'),
			{ projectId: 'group/subgroup/project', host: 'https://gitlab.example.com' },
		)
	})

	test('rejects non-gitlab hosts', () => {
		assert.strictEqual(parseGitlabSlug('https://github.com/foo/bar'), undefined)
		assert.strictEqual(parseGitlabSlug('git@bitbucket.org:foo/bar.git'), undefined)
		assert.strictEqual(parseGitlabSlug(''), undefined)
	})
})

suite('prHostAdapter: parseBitbucketSlug', () => {
	test('parses https', () => {
		assert.deepStrictEqual(
			parseBitbucketSlug('https://bitbucket.org/myteam/myrepo.git'),
			{ workspace: 'myteam', repo: 'myrepo' },
		)
	})

	test('parses ssh', () => {
		assert.deepStrictEqual(
			parseBitbucketSlug('git@bitbucket.org:myteam/myrepo.git'),
			{ workspace: 'myteam', repo: 'myrepo' },
		)
	})

	test('rejects non-bitbucket hosts', () => {
		assert.strictEqual(parseBitbucketSlug('https://github.com/foo/bar'), undefined)
		assert.strictEqual(parseBitbucketSlug('https://gitlab.com/foo/bar'), undefined)
	})
})

suite('prHostAdapter: parseAzureDevOpsSlug', () => {
	test('parses modern dev.azure.com https', () => {
		assert.deepStrictEqual(
			parseAzureDevOpsSlug('https://dev.azure.com/contoso/MyProject/_git/myrepo'),
			{ org: 'contoso', project: 'MyProject', repo: 'myrepo', host: 'dev.azure.com' },
		)
	})

	test('parses dev.azure.com https with .git suffix', () => {
		assert.deepStrictEqual(
			parseAzureDevOpsSlug('https://dev.azure.com/contoso/MyProject/_git/myrepo.git'),
			{ org: 'contoso', project: 'MyProject', repo: 'myrepo', host: 'dev.azure.com' },
		)
	})

	test('parses dev.azure.com https with embedded user', () => {
		assert.deepStrictEqual(
			parseAzureDevOpsSlug('https://contoso@dev.azure.com/contoso/MyProject/_git/myrepo'),
			{ org: 'contoso', project: 'MyProject', repo: 'myrepo', host: 'dev.azure.com' },
		)
	})

	test('url-decodes project names with spaces', () => {
		const parsed = parseAzureDevOpsSlug('https://dev.azure.com/contoso/My%20Project/_git/My%20Repo')
		assert.strictEqual(parsed?.project, 'My Project')
		assert.strictEqual(parsed?.repo, 'My Repo')
	})

	test('parses legacy visualstudio.com https', () => {
		assert.deepStrictEqual(
			parseAzureDevOpsSlug('https://contoso.visualstudio.com/MyProject/_git/myrepo'),
			{ org: 'contoso', project: 'MyProject', repo: 'myrepo', host: 'visualstudio.com' },
		)
	})

	test('parses ssh v3', () => {
		assert.deepStrictEqual(
			parseAzureDevOpsSlug('git@ssh.dev.azure.com:v3/contoso/MyProject/myrepo'),
			{ org: 'contoso', project: 'MyProject', repo: 'myrepo', host: 'dev.azure.com' },
		)
	})

	test('rejects non-azure hosts', () => {
		assert.strictEqual(parseAzureDevOpsSlug('https://github.com/foo/bar'), undefined)
		assert.strictEqual(parseAzureDevOpsSlug('https://gitlab.com/foo/bar'), undefined)
		assert.strictEqual(parseAzureDevOpsSlug('https://bitbucket.org/foo/bar'), undefined)
		assert.strictEqual(parseAzureDevOpsSlug(''), undefined)
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
