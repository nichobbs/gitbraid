import * as assert from 'node:assert'
import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ConfigService } from '../src/configService'
import { branchToWorktreeDirName } from '../src/branchStackService'
import { StackPopulator } from '../src/stackPopulator'
import { FakeGitRunner } from './helpers/fakeGitRunner'

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

function worktreeDir(branch: string): string {
	return path.join(wsRoot().fsPath, '.worktrees', branchToWorktreeDirName(branch))
}

/** Write a file into a branch's worktree directory. */
function writeWorktreeFile(branch: string, relPath: string, content: string): void {
	const full = path.join(worktreeDir(branch), relPath)
	fs.mkdirSync(path.dirname(full), { recursive: true })
	fs.writeFileSync(full, content)
}

/** Read a file from the primary workspace. */
async function readWorkspaceFile(relPath: string): Promise<string> {
	const uri = vscode.Uri.joinPath(wsRoot(), relPath)
	const data = await vscode.workspace.fs.readFile(uri)
	return Buffer.from(data).toString('utf-8')
}

/** Returns true if a file exists in the primary workspace. */
function workspaceFileExists(relPath: string): boolean {
	return fs.existsSync(path.join(wsRoot().fsPath, relPath))
}

function cleanup(): void {
	try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true, force: true }) } catch { /* ignore */ }
	// Remove any test files written directly to the workspace root
	for (const f of ['src/added.ts', 'src/modified.ts', 'src/other.ts', 'src/shared.ts']) {
		try { fs.rmSync(path.join(wsRoot().fsPath, f)) } catch { /* ignore */ }
	}
}

suite('StackPopulator', () => {

	let config: ConfigService
	let runner: FakeGitRunner
	let populator: StackPopulator

	// Silence VS Code notification dialogs that would block the headless host.
	type WinAny = Record<string, (...args: unknown[]) => Promise<unknown>>
	let origWarn: WinAny['showWarningMessage']

	setup(async () => {
		const win = vscode.window as unknown as WinAny
		origWarn = win.showWarningMessage
		win.showWarningMessage = async () => undefined

		cleanup()
		ConfigService.resetInstance()

		config = ConfigService.getInstance()
		await config.load(wsRoot())

		runner = new FakeGitRunner()
		populator = new StackPopulator(config, runner)
		populator.init(wsRoot())
	})

	teardown(() => {
		const win = vscode.window as unknown as WinAny
		win.showWarningMessage = origWarn

		populator.dispose()
		ConfigService.resetInstance()
		cleanup()
	})

	// ── getBranchFiles ───────────────────────────────────────────────────────

	test('getBranchFiles: returns files from git diff output', async () => {
		await config.addBranch({ name: 'feature/a', color: '#f00', base: 'main' })
		fs.mkdirSync(worktreeDir('feature/a'), { recursive: true })

		runner.fixture('diff --name-only --diff-filter=ACMR main..HEAD', {
			stdout: 'src/added.ts\nsrc/modified.ts\n',
			exitCode: 0,
		})

		const files = await populator.getBranchFiles('feature/a', 'main')
		assert.deepStrictEqual(files, ['src/added.ts', 'src/modified.ts'])
	})

	test('getBranchFiles: returns empty array when git exits non-zero', async () => {
		await config.addBranch({ name: 'feature/a', color: '#f00', base: 'main' })
		fs.mkdirSync(worktreeDir('feature/a'), { recursive: true })

		runner.fixture('diff --name-only --diff-filter=ACMR main..HEAD', {
			stdout: '',
			exitCode: 128,
		})

		const files = await populator.getBranchFiles('feature/a', 'main')
		assert.deepStrictEqual(files, [])
	})

	// ── seedFromStack ────────────────────────────────────────────────────────

	test('seedFromStack: copies committed files and assigns them', async () => {
		await config.addBranch({ name: 'feature/a', color: '#f00', base: 'main' })
		fs.mkdirSync(worktreeDir('feature/a'), { recursive: true })
		writeWorktreeFile('feature/a', 'src/added.ts', 'export const x = 1')

		runner.fixture('diff --name-only --diff-filter=ACMR main..HEAD', {
			stdout: 'src/added.ts\n',
			exitCode: 0,
		})

		await populator.seedFromStack()

		assert.ok(workspaceFileExists('src/added.ts'), 'file should be in workspace')
		assert.strictEqual(await readWorkspaceFile('src/added.ts'), 'export const x = 1')
		assert.strictEqual(config.getAssignment('src/added.ts'), 'feature/a')
	})

	test('seedFromStack: skips files already assigned', async () => {
		await config.addBranch({ name: 'feature/a', color: '#f00', base: 'main' })
		fs.mkdirSync(worktreeDir('feature/a'), { recursive: true })
		writeWorktreeFile('feature/a', 'src/added.ts', 'worktree version')

		// Pre-assign the file to the same branch (simulates a previous session)
		await config.setAssignment('src/added.ts', 'feature/a')

		runner.fixture('diff --name-only --diff-filter=ACMR main..HEAD', {
			stdout: 'src/added.ts\n',
			exitCode: 0,
		})

		// Write a workspace version that differs from the worktree
		fs.writeFileSync(path.join(wsRoot().fsPath, 'src/added.ts'), 'workspace version')

		await populator.seedFromStack()

		// Already-assigned file should not be overwritten
		assert.strictEqual(await readWorkspaceFile('src/added.ts'), 'workspace version')
	})

	test('seedFromStack: higher-order branch wins when both touch the same file', async () => {
		await config.addBranch({ name: 'layer/low', color: '#00f', base: 'main', order: 1 })
		await config.addBranch({ name: 'layer/high', color: '#f00', base: 'main', order: 2 })
		fs.mkdirSync(worktreeDir('layer/low'), { recursive: true })
		fs.mkdirSync(worktreeDir('layer/high'), { recursive: true })
		writeWorktreeFile('layer/low', 'src/shared.ts', 'low version')
		writeWorktreeFile('layer/high', 'src/shared.ts', 'high version')

		runner.fixture('diff --name-only --diff-filter=ACMR main..HEAD', {
			stdout: 'src/shared.ts\n',
			exitCode: 0,
		})

		await populator.seedFromStack()

		assert.strictEqual(config.getAssignment('src/shared.ts'), 'layer/high')
		assert.strictEqual(await readWorkspaceFile('src/shared.ts'), 'high version')
	})

	test('seedFromStack: no-op when stack is empty', async () => {
		await populator.seedFromStack()
		assert.strictEqual(runner.calls.length, 0)
	})

	test('seedFromStack: skips branch with no worktree on disk', async () => {
		await config.addBranch({ name: 'feature/a', color: '#f00', base: 'main' })
		// Worktree directory NOT created — simulates a branch whose worktree
		// was never set up (e.g. manual config edit).

		runner.fixture('diff --name-only --diff-filter=ACMR main..HEAD', {
			stdout: 'src/added.ts\n',
			exitCode: 0,
		})

		await populator.seedFromStack()

		// No git calls should have been made since the worktree doesn't exist
		assert.strictEqual(runner.calls.length, 0)
		assert.strictEqual(config.getAssignment('src/added.ts'), undefined)
	})

	// ── onDidChangeStack (add) ───────────────────────────────────────────────

	test('reacts to stack add event: copies and assigns files', async () => {
		// Set up worktree before the branch config is added
		const wtDir = worktreeDir('feature/b')
		fs.mkdirSync(wtDir, { recursive: true })
		writeWorktreeFile('feature/b', 'src/other.ts', 'new feature code')

		runner.fixture('diff --name-only --diff-filter=ACMR main..HEAD', {
			stdout: 'src/other.ts\n',
			exitCode: 0,
		})

		// Adding the branch fires onDidChangeStack which triggers _onBranchAdded.
		// The handler is async and not awaited by EventEmitter.fire(), so we poll
		// for the observable side-effect (the file appearing in the workspace).
		await config.addBranch({ name: 'feature/b', color: '#0f0', base: 'main' })

		const deadline = Date.now() + 3000
		while (!workspaceFileExists('src/other.ts') && Date.now() < deadline) {
			await new Promise<void>((resolve) => setTimeout(resolve, 50))
		}

		assert.ok(workspaceFileExists('src/other.ts'), 'file should appear in workspace')
		assert.strictEqual(config.getAssignment('src/other.ts'), 'feature/b')
	})
})
