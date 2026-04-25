import * as assert from 'node:assert'
import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ConfigService } from '../src/configService'
import {
	countCommitsAheadOf,
	shouldAmendForSingleCommit,
	validateStack,
	squashToOne,
	isSingleCommitBranch,
} from '../src/singleCommit'
import { FakeGitRunner } from './helpers/fakeGitRunner'

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

function cleanup(): void {
	try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true, force: true }) } catch { /* ignore */ }
}

suite('singleCommit helpers', () => {

	setup(() => { cleanup() })
	teardown(() => { cleanup() })

	// ── countCommitsAheadOf ──────────────────────────────────────────────────

	test('countCommitsAheadOf: returns the parsed rev-list count', async () => {
		const runner = new FakeGitRunner()
		runner.fixture('rev-list --count main..HEAD', { stdout: '3\n' })
		const ahead = await countCommitsAheadOf(runner, '/tmp/repo', 'main')
		assert.strictEqual(ahead, 3)
	})

	test('countCommitsAheadOf: returns undefined when git fails', async () => {
		const runner = new FakeGitRunner()
		runner.fixture('rev-list --count missing..HEAD', { exitCode: 128, stderr: 'fatal' })
		const ahead = await countCommitsAheadOf(runner, '/tmp/repo', 'missing')
		assert.strictEqual(ahead, undefined)
	})

	test('countCommitsAheadOf: handles empty stdout as NaN → undefined', async () => {
		const runner = new FakeGitRunner()
		runner.fixture('rev-list --count main..HEAD', { stdout: '\n' })
		const ahead = await countCommitsAheadOf(runner, '/tmp/repo', 'main')
		assert.strictEqual(ahead, undefined)
	})

	// ── shouldAmendForSingleCommit ───────────────────────────────────────────

	test('shouldAmendForSingleCommit: ahead=0 → plain commit', async () => {
		const runner = new FakeGitRunner()
		runner.fixture('rev-list --count main..HEAD', { stdout: '0\n' })
		assert.strictEqual(await shouldAmendForSingleCommit(runner, '/r', 'main'), false)
	})

	test('shouldAmendForSingleCommit: ahead=1 → amend', async () => {
		const runner = new FakeGitRunner()
		runner.fixture('rev-list --count main..HEAD', { stdout: '1\n' })
		assert.strictEqual(await shouldAmendForSingleCommit(runner, '/r', 'main'), true)
	})

	test('shouldAmendForSingleCommit: undefined count → safe default (no amend)', async () => {
		const runner = new FakeGitRunner()
		runner.fixture('rev-list --count missing..HEAD', { exitCode: 128 })
		assert.strictEqual(await shouldAmendForSingleCommit(runner, '/r', 'missing'), false)
	})

	// ── isSingleCommitBranch ─────────────────────────────────────────────────

	test('isSingleCommitBranch: reflects the config flag', async () => {
		const config = new ConfigService()
		await config.load(wsRoot())
		await config.addBranch({ name: 'feat/a', base: 'main', color: '#fff' })
		assert.strictEqual(isSingleCommitBranch(config, 'feat/a'), false)
		await config.setSingleCommit('feat/a', true)
		assert.strictEqual(isSingleCommitBranch(config, 'feat/a'), true)
		await config.setSingleCommit('feat/a', false)
		assert.strictEqual(isSingleCommitBranch(config, 'feat/a'), false)
		assert.strictEqual(isSingleCommitBranch(config, 'unknown'), false)
	})

	// ── validateStack ────────────────────────────────────────────────────────

	test('validateStack: returns one result per singleCommit branch', async () => {
		const config = new ConfigService()
		await config.load(wsRoot())
		await config.addBranch({ name: 'feat/a', base: 'main', color: '#fff', singleCommit: true })
		await config.addBranch({ name: 'feat/b', base: 'feat/a', color: '#fff' })   // not single-commit
		await config.addBranch({ name: 'feat/c', base: 'feat/b', color: '#fff', singleCommit: true })

		const runner = new FakeGitRunner()
		runner.fixture('rev-list --count main..HEAD', { stdout: '1\n' })
		runner.fixture('rev-list --count feat/b..HEAD', { stdout: '2\n' })
		// feat/b is *not* single-commit and must not be validated.

		const results = await validateStack(runner, config, (b) => `/wt/${b}`)
		const names = results.map((r) => r.branch).sort()
		assert.deepStrictEqual(names, ['feat/a', 'feat/c'])
		const byName = new Map(results.map((r) => [r.branch, r]))
		assert.strictEqual(byName.get('feat/a')?.violated, false, 'ahead=1 is fine')
		assert.strictEqual(byName.get('feat/c')?.violated, true, 'ahead=2 violates')
	})

	test('validateStack: skips branches with no worktree', async () => {
		const config = new ConfigService()
		await config.load(wsRoot())
		await config.addBranch({ name: 'feat/a', base: 'main', color: '#fff', singleCommit: true })
		const runner = new FakeGitRunner()

		const results = await validateStack(runner, config, () => undefined)
		assert.strictEqual(results.length, 0)
		assert.strictEqual(runner.calls.length, 0, 'no git calls should have been issued')
	})

	// ── squashToOne ──────────────────────────────────────────────────────────

	test('squashToOne: runs reset --soft then commit -m', async () => {
		const runner = new FakeGitRunner()
		runner.fixture('reset --soft main', { exitCode: 0 })
		runner.fixture('commit -m squashed', { exitCode: 0 })
		const result = await squashToOne(runner, '/r', 'main', 'squashed')
		assert.strictEqual(result.ok, true)
		assert.deepStrictEqual(runner.calls[0].args, ['reset', '--soft', 'main'])
		assert.deepStrictEqual(runner.calls[1].args, ['commit', '-m', 'squashed'])
	})

	test('squashToOne: bails out if reset fails (no commit attempted)', async () => {
		const runner = new FakeGitRunner()
		runner.fixture('reset --soft main', { exitCode: 1, stderr: 'permission denied' })
		const result = await squashToOne(runner, '/r', 'main', 'squashed')
		assert.strictEqual(result.ok, false)
		assert.ok(result.error?.includes('permission denied'), `error should carry stderr; got: ${String(result.error)}`)
		assert.strictEqual(runner.calls.length, 1, 'commit must not be attempted after a reset failure')
	})

	test('squashToOne: surfaces commit failure', async () => {
		const runner = new FakeGitRunner()
		runner.fixture('reset --soft main', { exitCode: 0 })
		runner.fixture('commit -m msg', { exitCode: 1, stderr: 'nothing to commit' })
		const result = await squashToOne(runner, '/r', 'main', 'msg')
		assert.strictEqual(result.ok, false)
		assert.ok(result.error?.includes('nothing to commit'), `got: ${String(result.error)}`)
	})
})
