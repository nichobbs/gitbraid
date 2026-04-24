import * as assert from 'node:assert'
import { buildCommitUri, parseCommitUri, CommitDetailProvider } from '../src/commitDetailProvider'
import { FakeGitRunner } from './helpers/fakeGitRunner'

suite('commitDetailProvider', () => {

	test('buildCommitUri + parseCommitUri round-trip', () => {
		const uri = buildCommitUri('/abs/path with spaces', 'a1b2c3d4e5f6')
		const parsed = parseCommitUri(uri)
		assert.ok(parsed, 'parse should succeed')
		assert.strictEqual(parsed!.worktreeDir, '/abs/path with spaces')
		assert.strictEqual(parsed!.sha, 'a1b2c3d4e5f6')
		// Scheme is the expected one.
		assert.strictEqual(uri.scheme, 'gitbraid-commit')
	})

	test('parseCommitUri rejects unknown scheme', () => {
		const { Uri } = require('vscode') as typeof import('vscode')
		const u = Uri.parse('file:///tmp/foo.diff')
		assert.strictEqual(parseCommitUri(u), undefined)
	})

	test('parseCommitUri rejects malformed path', () => {
		const authority = Buffer.from('/wt', 'utf-8').toString('hex')
		const { Uri } = require('vscode') as typeof import('vscode')
		const u = Uri.parse(`gitbraid-commit://${authority}/not-a-sha.notdiff`)
		assert.strictEqual(parseCommitUri(u), undefined)
	})

	test('provideTextDocumentContent returns git show stdout on success', async () => {
		const runner = new FakeGitRunner()
		runner.fixture('show --patch --color=never abc123', {
			stdout: 'commit abc123\nAuthor: …\n\n    message\n',
		})
		const provider = new CommitDetailProvider(runner)
		const content = await provider.provideTextDocumentContent(buildCommitUri('/wt', 'abc123'))
		assert.ok(content.includes('commit abc123'), `unexpected content: ${content}`)
	})

	test('provideTextDocumentContent reports a non-zero exit gracefully', async () => {
		const runner = new FakeGitRunner()
		// Must be a hex SHA so the URI parses successfully — the failure under
		// test is `git show` returning non-zero, not the URI rejector.
		runner.fixture('show --patch --color=never deadbe', {
			exitCode: 128,
			stderr: 'fatal: bad revision',
		})
		const provider = new CommitDetailProvider(runner)
		const content = await provider.provideTextDocumentContent(buildCommitUri('/wt', 'deadbe'))
		assert.ok(content.includes('failed'), `should explain failure; got: ${content}`)
		assert.ok(content.includes('fatal: bad revision'), `should include stderr; got: ${content}`)
	})
})
