import * as assert from 'node:assert'
import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
	CommitGroupNode,
	CommitNode,
	BranchStackTreeProvider,
} from '../src/branchStackTreeProvider'
import { ConfigService } from '../src/configService'
import { WorkspaceSync } from '../src/workspaceSync'
import { CommitListService } from '../src/commitListService'
import { FakeGitRunner } from './helpers/fakeGitRunner'

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

function cleanup(): void {
	try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true, force: true }) } catch { /* ignore */ }
}

suite('branchStackTreeProvider — commit inspector (Plan 06)', () => {

	setup(() => { cleanup() })
	teardown(() => { cleanup() })


	// ── Node shape ───────────────────────────────────────────────────────────

	test('CommitGroupNode: label is "Commits", icon is git-commit', () => {
		const g = new CommitGroupNode('feat/a', 'main', '/wt', 3)
		assert.strictEqual(g.label, 'Commits')
		assert.strictEqual(g.kind, 'commitGroup')
		assert.strictEqual(g.description, '3')
		assert.ok(g.iconPath instanceof vscode.ThemeIcon)
		assert.strictEqual((g.iconPath as vscode.ThemeIcon).id, 'git-commit')
	})

	test('CommitGroupNode: omits description when count is 0', () => {
		const g = new CommitGroupNode('feat/a', 'main', '/wt', 0)
		assert.strictEqual(g.description, undefined)
	})

	test('CommitNode: label is shortSha, description is subject, command wires to gitbraid.showCommit', () => {
		const n = new CommitNode(
			{
				sha: '0123456789abcdef0123',
				shortSha: '0123456',
				subject: 'fix: typo',
				date: new Date('2026-04-24T10:00:00Z'),
				author: 'Sam',
			},
			'feat/a',
			'/wt/feat-a',
		)
		assert.strictEqual(n.label, '0123456')
		assert.strictEqual(n.description, 'fix: typo')
		assert.strictEqual(n.command?.command, 'gitbraid.showCommit')
		const arg = n.command?.arguments?.[0] as { sha: string, worktreeDir: string, branch: string }
		assert.strictEqual(arg.sha, '0123456789abcdef0123')
		assert.strictEqual(arg.worktreeDir, '/wt/feat-a')
		assert.strictEqual(arg.branch, 'feat/a')
	})

	// ── Provider integration ────────────────────────────────────────────────

	test('provider.getChildren(CommitGroupNode) → CommitNode[] via CommitListService', async () => {
		const config = new ConfigService()
		await config.load(wsRoot())
		await config.addBranch({ name: 'feat/a', base: 'main', color: '#fff' })

		const runner = new FakeGitRunner()
		// Three commits unique to feat/a vs main.
		runner.fixture(
			'log --first-parent',
			{
				stdout: [
					'aaaaaaaaaaaa\x1ffirst\x1f2026-04-01T00:00:00Z\x1fSam',
					'bbbbbbbbbbbb\x1fsecond\x1f2026-04-02T00:00:00Z\x1fSam',
					'cccccccccccc\x1fthird\x1f2026-04-03T00:00:00Z\x1fSam',
				].join('\n') + '\n',
			},
		)
		const commitList = new CommitListService(runner)
		const sync = new WorkspaceSync(config)
		const provider = new BranchStackTreeProvider(
			config,
			sync,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			commitList,
		)

		const group = new CommitGroupNode('feat/a', 'main', '/wt/feat-a', 3)
		const children = await provider.getChildren(group)
		assert.ok(Array.isArray(children))
		assert.strictEqual(children!.length, 3)
		const nodes = children as CommitNode[]
		assert.deepStrictEqual(nodes.map((c) => c.summary.shortSha), ['aaaaaaa', 'bbbbbbb', 'ccccccc'])
		assert.deepStrictEqual(nodes.map((c) => c.summary.subject), ['first', 'second', 'third'])
	})

	test('provider.getChildren(CommitGroupNode) → [] when CommitListService absent', async () => {
		const config = new ConfigService()
		await config.load(wsRoot())
		await config.addBranch({ name: 'feat/a', base: 'main', color: '#fff' })
		const sync = new WorkspaceSync(config)
		const provider = new BranchStackTreeProvider(config, sync)   // no commitList
		const group = new CommitGroupNode('feat/a', 'main', '/wt', 0)
		const children = await provider.getChildren(group)
		assert.deepStrictEqual(children, [])
	})

	test('provider.getChildren(CommitGroupNode) → [] when branch is not in config', async () => {
		const config = new ConfigService()
		await config.load(wsRoot())
		const runner = new FakeGitRunner()
		const provider = new BranchStackTreeProvider(
			config,
			new WorkspaceSync(config),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			new CommitListService(runner),
		)
		const group = new CommitGroupNode('no-such', 'main', '/wt', 0)
		const children = await provider.getChildren(group)
		assert.deepStrictEqual(children, [])
	})
})
