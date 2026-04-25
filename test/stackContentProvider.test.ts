import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { ConfigService } from '../src/configService'
import { BranchStackService } from '../src/branchStackService'
import { StackResolver } from '../src/stackResolver'
import {
	StackContentProvider,
	STACK_SCHEME,
	STACK_BASE_SCHEME,
} from '../src/stackContentProvider'
import { git } from '../src/gitFunctions'

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

function cleanup(): void {
	try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true, force: true }) } catch { /* */ }
	try { fs.rmSync(path.join(wsRoot().fsPath, '.gitignore')) } catch { /* */ }
}

suite('StackContentProvider', function () {
	this.timeout(15_000)

	let config: ConfigService
	let branchStack: BranchStackService
	let resolver: StackResolver
	let provider: StackContentProvider

	suiteSetup(async () => {
		await git.init()
		try { await git.add(undefined, '.gitkeep') } catch { /* */ }
		try { await git.commit('initial commit', '--no-gpg-sign') } catch { /* */ }
	})

	setup(async () => {
		cleanup()
		ConfigService.resetInstance()
		BranchStackService.resetInstance()
		config = ConfigService.getInstance()
		await config.load(wsRoot())
		branchStack = BranchStackService.getInstance(config)
		await branchStack.initStack(wsRoot())
		resolver = new StackResolver(config, branchStack)
		provider = new StackContentProvider(undefined, wsRoot(), resolver)
	})

	teardown(() => {
		provider.dispose()
		resolver.dispose()
		cleanup()
		BranchStackService.resetInstance()
		ConfigService.resetInstance()
	})

	test('uriFor: encodes folder query for multi-root workspaces', () => {
		const uri = StackContentProvider.uriFor('src/x.ts', vscode.Uri.file('/some/folder'))
		assert.strictEqual(uri.scheme, STACK_SCHEME)
		assert.ok(uri.query.includes('folder='))
	})

	test('uriFor: omits folder query when no folder root passed', () => {
		const uri = StackContentProvider.uriFor('src/x.ts')
		assert.strictEqual(uri.scheme, STACK_SCHEME)
		assert.strictEqual(uri.query, '')
	})

	test('baseUriFor: encodes commit + folder', () => {
		const uri = StackContentProvider.baseUriFor('src/x.ts', 'abc123', vscode.Uri.file('/some/folder'))
		assert.strictEqual(uri.scheme, STACK_BASE_SCHEME)
		assert.ok(uri.query.includes('commit=abc123'))
		assert.ok(uri.query.includes('folder='))
	})

	test('baseUriFor: encodes commit only when no folder', () => {
		const uri = StackContentProvider.baseUriFor('src/x.ts', 'abc123')
		assert.strictEqual(uri.scheme, STACK_BASE_SCHEME)
		assert.ok(uri.query.includes('commit=abc123'))
		assert.ok(!uri.query.includes('folder='))
	})

	test('provideTextDocumentContent: returns "" for unknown scheme', async () => {
		const uri = vscode.Uri.parse('file:///foo')
		const text = await provider.provideTextDocumentContent(uri)
		assert.strictEqual(text, '')
	})

	test('provideTextDocumentContent: stack scheme returns file content from worktree', async () => {
		// Make a feature branch with a tracked file.
		await branchStack.addBranchToStack('feature/docs', 'main', '#aaa')
		const wt = branchStack.getWorktreePath('feature/docs').fsPath
		const filePath = path.join(wt, 'docs.md')
		fs.mkdirSync(path.dirname(filePath), { recursive: true })
		fs.writeFileSync(filePath, 'hello from feature/docs\n')
		await config.setAssignment('docs.md', 'feature/docs')
		const uri = StackContentProvider.uriFor('docs.md')
		const text = await provider.provideTextDocumentContent(uri)
		assert.ok(text.includes('hello from feature/docs'))
	})

	test('provideTextDocumentContent: base scheme without commit query returns ""', async () => {
		// missing commit param
		const uri = vscode.Uri.parse(`${STACK_BASE_SCHEME}:src/x.ts`)
		const text = await provider.provideTextDocumentContent(uri)
		assert.strictEqual(text, '')
	})

	test('refresh: fires the change event for the URI', async () => {
		let fired = false
		const sub = provider.onDidChange(() => { fired = true })
		try {
			provider.refresh('src/x.ts')
			// Event is fired synchronously by the EventEmitter
			assert.strictEqual(fired, true)
		} finally {
			sub.dispose()
		}
	})
})
