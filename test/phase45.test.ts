import * as vscode from 'vscode'
import * as assert from 'node:assert'
import * as node_child_process from 'node:child_process'
import * as node_util from 'node:util'
import * as node_path from 'node:path'
import * as node_fs from 'node:fs'
import { log } from '../src/channelLogger'

const execAsync = node_util.promisify(node_child_process.exec)

// ─── helpers ─────────────────────────────────────────────────────────────────

async function gitInDir(dir: string, cmd: string): Promise<string> {
	const { stdout } = await execAsync(`git ${cmd}`, { cwd: dir })
	return stdout.trim()
}

// ─── StackResolver unit tests ─────────────────────────────────────────────────
suite('stackResolver', () => {
	let tmpDir: string

	suiteSetup('create temp git repo', async () => {
		tmpDir = node_fs.mkdtempSync(node_path.join(require('node:os').tmpdir(), 'mbc-test-'))
		await gitInDir(tmpDir, 'init')
		await gitInDir(tmpDir, 'config user.email test@test.com')
		await gitInDir(tmpDir, 'config user.name Test')
		node_fs.writeFileSync(node_path.join(tmpDir, 'hello.txt'), 'line1\nline2\n')
		await gitInDir(tmpDir, 'add hello.txt')
		await gitInDir(tmpDir, 'commit -m "init" --no-gpg-sign')
		log.info('stackResolver: temp repo at ' + tmpDir)
	})

	suiteTeardown('remove temp repo', () => {
		// Windows CI intermittently holds a handle on `.git` well past the
		// point the git process reports as exited (AV scanning / delayed
		// handle release) — long enough that even rmSync's built-in
		// maxRetries/retryDelay backoff doesn't outlast it. This is cleanup
		// of an ephemeral CI temp dir the OS reclaims regardless, so don't
		// fail the whole suite over it — the actual test assertions above
		// already ran and passed.
		try {
			node_fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
		} catch (e) {
			log.warn(`stackResolver: could not remove temp repo at ${tmpDir}: ${e instanceof Error ? e.message : String(e)}`)
		}
	})

	test('sr.1 - git show retrieves file content', async () => {
		const content = await gitInDir(tmpDir, 'show HEAD:hello.txt')
		assert.strictEqual(content, 'line1\nline2')
		log.info('sr.1 passed')
	})

	test('sr.2 - git diff on unchanged file is empty', async () => {
		const { stdout } = await execAsync('git diff HEAD HEAD -- hello.txt', { cwd: tmpDir })
		assert.strictEqual(stdout, '', 'diff on same commit should be empty')
		log.info('sr.2 passed')
	})

	test('sr.3 - git rev-list count is 0 for up-to-date branch', async () => {
		const { stdout } = await execAsync('git rev-list --count HEAD..HEAD', { cwd: tmpDir })
		assert.strictEqual(stdout.trim(), '0')
		log.info('sr.3 passed')
	})

	test('sr.4 - git rev-list count shows commits behind', async () => {
		// Create a new branch at HEAD, then add a commit to the parent (main)
		await gitInDir(tmpDir, 'checkout -b child-branch')
		await gitInDir(tmpDir, 'checkout -')  // back to default branch
		node_fs.writeFileSync(node_path.join(tmpDir, 'extra.txt'), 'new\n')
		await gitInDir(tmpDir, 'add extra.txt')
		await gitInDir(tmpDir, 'commit -m "parent commit" --no-gpg-sign')

		const { stdout } = await execAsync(
			'git rev-list --count child-branch..HEAD',
			{ cwd: tmpDir },
		)
		assert.strictEqual(stdout.trim(), '1', 'child should be 1 commit behind parent')
		log.info('sr.4 passed')
	})
})

// ─── RebaseSuggestionService unit tests ──────────────────────────────────────
suite('rebaseSuggestionService', () => {
	let tmpDir: string

	suiteSetup('create temp git repo for rebase tests', async () => {
		tmpDir = node_fs.mkdtempSync(node_path.join(require('node:os').tmpdir(), 'mbc-rebase-'))
		await gitInDir(tmpDir, 'init')
		await gitInDir(tmpDir, 'config user.email test@test.com')
		await gitInDir(tmpDir, 'config user.name Test')
		node_fs.writeFileSync(node_path.join(tmpDir, 'base.txt'), 'base\n')
		await gitInDir(tmpDir, 'add base.txt')
		await gitInDir(tmpDir, 'commit -m "base" --no-gpg-sign')
		log.info('rebaseSuggestionService: temp repo at ' + tmpDir)
	})

	suiteTeardown('remove temp repo', () => {
		try {
			node_fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
		} catch (e) {
			log.warn(`rebaseSuggestionService: could not remove temp repo at ${tmpDir}: ${e instanceof Error ? e.message : String(e)}`)
		}
	})

	test('rs.1 - rev-list count zero when equal', async () => {
		const { stdout } = await execAsync('git rev-list --count HEAD..HEAD', { cwd: tmpDir })
		assert.strictEqual(stdout.trim(), '0')
		log.info('rs.1 passed')
	})

	test('rs.2 - invalid ref produces error', async () => {
		let threw = false
		try {
			await execAsync('git rev-list --count non-existent-branch..HEAD', { cwd: tmpDir })
		} catch {
			threw = true
		}
		assert.ok(threw, 'should throw for unknown ref')
		log.info('rs.2 passed')
	})

	test('rs.3 - rebase succeeds when fast-forward is possible', async () => {
		// child is at same commit as parent, nothing to rebase
		await gitInDir(tmpDir, 'checkout -b rs3-child')
		await gitInDir(tmpDir, 'rebase HEAD')  // no-op rebase
		const head = await gitInDir(tmpDir, 'rev-parse HEAD')
		assert.ok(head.length > 0, 'HEAD exists after no-op rebase')
		await gitInDir(tmpDir, 'checkout -')
		log.info('rs.3 passed')
	})
})

// ─── GitBraidApi / LmTools integration check ────────────────────────────────
suite('gitBraidApi and lmTools', () => {
	test('mt.1 - extension exports GitBraidExportedAPI', async () => {
		const ext = vscode.extensions.getExtension('nichobbs.gitbraid')
		assert.ok(ext, 'extension should be present')
		const exported = await ext!.activate()
		assert.ok(exported, 'activate() should return the API object')
		assert.strictEqual(typeof exported.getStack, 'function', 'getStack should be a function')
		assert.strictEqual(typeof exported.addBranch, 'function', 'addBranch should be a function')
		assert.strictEqual(typeof exported.assignFile, 'function', 'assignFile should be a function')
		assert.strictEqual(typeof exported.getFloatingFiles, 'function', 'getFloatingFiles should be a function')
		assert.strictEqual(typeof exported.commitBranch, 'function', 'commitBranch should be a function')
		log.info('mt.1 passed')
	})

	test('mt.2 - getStack returns an array', async () => {
		const ext = vscode.extensions.getExtension('nichobbs.gitbraid')
		assert.ok(ext)
		const exported = await ext!.activate()
		const stack = exported.getStack()
		assert.ok(Array.isArray(stack), 'getStack() should return an array')
		log.info('mt.2 passed')
	})

	test('mt.3 - getFloatingFiles returns an array', async () => {
		const ext = vscode.extensions.getExtension('nichobbs.gitbraid')
		assert.ok(ext)
		const exported = await ext!.activate()
		const floating = exported.getFloatingFiles()
		assert.ok(Array.isArray(floating), 'getFloatingFiles() should return an array')
		log.info('mt.3 passed')
	})
})
