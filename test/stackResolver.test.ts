import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { ConfigService } from '../src/configService'
import { BranchStackService } from '../src/branchStackService'
import { StackResolver } from '../src/stackResolver'
import { git } from '../src/gitFunctions'

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

function cleanup() {
	try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true }) } catch {}
	try { fs.rmSync(path.join(wsRoot().fsPath, '.gitignore')) } catch {}
}

suite('StackResolver', function () {
	this.timeout(15_000)

	let config: ConfigService
	let branchStack: BranchStackService
	let resolver: StackResolver

	suiteSetup(async () => {
		await git.init()
		try { await git.add(undefined, '.gitkeep') } catch {}
		try { await git.commit('initial commit', '--no-gpg-sign') } catch {}
	})

	setup(async () => {
		cleanup()
		ConfigService.resetInstance()
		BranchStackService.resetInstance()
		config = ConfigService.getInstance()
		await config.load(wsRoot())
		branchStack = BranchStackService.getInstance(config)
		resolver = new StackResolver(config, branchStack)
	})

	teardown(async () => {
		resolver.dispose()
		cleanup()
		BranchStackService.resetInstance()
		ConfigService.resetInstance()
	})

	// ── getStackFiles ─────────────────────────────────────────────────────────

	test('getStackFiles: empty when no assignments', () => {
		const files = resolver.getStackFiles()
		assert.deepStrictEqual(files, [])
	})

	test('getStackFiles: returns assigned files', async () => {
		await config.addBranch({ name: 'feature/docs', color: '#fff', base: 'main' })
		await config.setAssignment('README.md', 'feature/docs')
		await config.setAssignment('src/foo.ts', 'feature/docs')
		const files = resolver.getStackFiles()
		assert.ok(files.includes('README.md'))
		assert.ok(files.includes('src/foo.ts'))
		assert.strictEqual(files.length, 2)
	})

	// ── getResolvedContent ────────────────────────────────────────────────────

	test('getResolvedContent: returns undefined for nonexistent floating file', async () => {
		// No assignment, and file doesn't exist in workspace
		const result = await resolver.getResolvedContent(wsRoot(), '__nonexistent_file__.ts')
		assert.strictEqual(result, undefined)
	})

	test('getResolvedContent: reads floating file from workspace', async () => {
		// Write a real file to workspace that is not assigned
		const testFilePath = path.join(wsRoot().fsPath, 'src', 'floating-resolver-test.ts')
		fs.mkdirSync(path.dirname(testFilePath), { recursive: true })
		fs.writeFileSync(testFilePath, 'const x = 42;')

		try {
			const result = await resolver.getResolvedContent(wsRoot(), 'src/floating-resolver-test.ts')
			assert.ok(result instanceof Uint8Array)
			const content = Buffer.from(result).toString('utf-8')
			assert.ok(content.includes('42'))
		} finally {
			try { fs.rmSync(testFilePath) } catch {}
		}
	})

	test('getResolvedContent: returns undefined for assigned file with no worktree content', async () => {
		await config.addBranch({ name: 'feature/docs', color: '#fff', base: 'main' })
		await config.setAssignment('src/missing-in-worktree.ts', 'feature/docs')
		// No worktree exists and the branch has no committed version
		const result = await resolver.getResolvedContent(wsRoot(), 'src/missing-in-worktree.ts')
		assert.strictEqual(result, undefined)
	})

	// ── getStackDiff ──────────────────────────────────────────────────────────

	test('getStackDiff: returns undefined when stack is empty', async () => {
		const result = await resolver.getStackDiff(wsRoot().fsPath, 'src/foo.ts')
		assert.strictEqual(result, undefined)
	})

	test('getStackDiff: returns undefined or string for a one-branch stack', async () => {
		await config.addBranch({ name: 'feature/docs', color: '#fff', base: 'main' })
		const result = await resolver.getStackDiff(wsRoot().fsPath, 'src/foo.ts')
		// Either undefined (no diff) or a string — just must not throw
		assert.ok(result === undefined || typeof result === 'string')
	})

	// ── getCommittedContent ───────────────────────────────────────────────────

	test('getCommittedContent: returns undefined for file not committed on branch', async () => {
		const result = await resolver.getCommittedContent(wsRoot().fsPath, 'main', '__never_committed__.ts')
		assert.strictEqual(result, undefined)
	})

	test('getCommittedContent: returns undefined for nonexistent branch', async () => {
		const result = await resolver.getCommittedContent(wsRoot().fsPath, 'nonexistent-branch', 'README.md')
		assert.strictEqual(result, undefined)
	})

	// ── dispose ───────────────────────────────────────────────────────────────

	test('dispose: can be called without throwing', () => {
		assert.doesNotThrow(() => resolver.dispose())
	})

})
