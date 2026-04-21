import * as assert from 'assert'
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { ConfigService } from '../src/configService'
import { ConfigError } from '../src/errors'
import { emptyConfig } from '../src/configTypes'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

function worktreesDir(): string {
	return path.join(wsRoot().fsPath, '.worktrees')
}

function configPath(): string {
	return path.join(worktreesDir(), 'local-config.json')
}

function gitignorePath(): string {
	return path.join(wsRoot().fsPath, '.gitignore')
}

function cleanup() {
	try { fs.rmSync(worktreesDir(), { recursive: true }) } catch {}
	try { fs.rmSync(gitignorePath()) } catch {}
}

function writeConfig(content: string) {
	fs.mkdirSync(worktreesDir(), { recursive: true })
	fs.writeFileSync(configPath(), content, 'utf-8')
}

// ─── Suite ───────────────────────────────────────────────────────────────────

suite('ConfigService', () => {

	let svc: ConfigService

	setup(() => {
		cleanup()
		ConfigService.resetInstance()
		svc = ConfigService.getInstance()
	})

	teardown(() => {
		cleanup()
		ConfigService.resetInstance()
	})

	// ── Load ──────────────────────────────────────────────────────────────────

	test('load: missing config file returns empty config', async () => {
		await svc.load(wsRoot())
		assert.deepStrictEqual(svc.getStack(), [])
		assert.deepStrictEqual(svc.getAllAssignments(), {})
	})

	test('load: valid config file is read correctly', async () => {
		writeConfig(JSON.stringify({
			version: 1,
			stack: [{ name: 'feature/docs', color: '#4CAF50', order: 1, base: 'main' }],
			assignments: { 'src/foo.ts': 'feature/docs' },
		}))
		await svc.load(wsRoot())
		assert.strictEqual(svc.getStack().length, 1)
		assert.strictEqual(svc.getStack()[0].name, 'feature/docs')
		assert.strictEqual(svc.getAssignment('src/foo.ts'), 'feature/docs')
	})

	test('load: malformed JSON returns empty config without throwing', async () => {
		writeConfig('{ this is not json }')
		await svc.load(wsRoot())
		assert.deepStrictEqual(svc.getStack(), [])
	})

	test('load: structurally invalid object returns empty config without throwing', async () => {
		writeConfig(JSON.stringify({ version: 'bad', stack: null }))
		await svc.load(wsRoot())
		assert.deepStrictEqual(svc.getStack(), [])
	})

	test('load: missing assignments field is tolerated via migration', async () => {
		writeConfig(JSON.stringify({
			version: 1,
			stack: [{ name: 'feature/docs', color: '#fff', order: 1, base: 'main' }],
		}))
		await svc.load(wsRoot())
		assert.deepStrictEqual(svc.getAllAssignments(), {})
	})

	// ── addBranch ─────────────────────────────────────────────────────────────

	test('addBranch: appends entry with auto-assigned order', async () => {
		await svc.load(wsRoot())
		await svc.addBranch({ name: 'feature/docs', color: '#4CAF50', base: 'main' })
		await svc.addBranch({ name: 'feature/impl', color: '#2196F3', base: 'feature/docs' })
		const stack = svc.getStack()
		assert.strictEqual(stack.length, 2)
		assert.strictEqual(stack[0].name, 'feature/docs')
		assert.strictEqual(stack[0].order, 1)
		assert.strictEqual(stack[1].name, 'feature/impl')
		assert.strictEqual(stack[1].order, 2)
	})

	test('addBranch: duplicate branch name throws ConfigError', async () => {
		await svc.load(wsRoot())
		await svc.addBranch({ name: 'feature/docs', color: '#fff', base: 'main' })
		await assert.rejects(
			() => svc.addBranch({ name: 'feature/docs', color: '#fff', base: 'main' }),
			ConfigError,
		)
	})

	test('addBranch: fires onDidChangeStack event', async () => {
		await svc.load(wsRoot())
		const events: string[] = []
		svc.onDidChangeStack((e) => events.push(e.branch))
		await svc.addBranch({ name: 'feature/docs', color: '#fff', base: 'main' })
		assert.deepStrictEqual(events, ['feature/docs'])
	})

	// ── removeBranch ──────────────────────────────────────────────────────────

	test('removeBranch: removes stack entry', async () => {
		await svc.load(wsRoot())
		await svc.addBranch({ name: 'feature/docs', color: '#fff', base: 'main' })
		await svc.removeBranch('feature/docs')
		assert.strictEqual(svc.getStack().length, 0)
	})

	test('removeBranch: clears assignments belonging to that branch', async () => {
		await svc.load(wsRoot())
		await svc.addBranch({ name: 'feature/docs', color: '#fff', base: 'main' })
		await svc.setAssignment('README.md', 'feature/docs')
		await svc.removeBranch('feature/docs')
		assert.strictEqual(svc.getAssignment('README.md'), undefined)
	})

	test('removeBranch: no-op for unknown branch name', async () => {
		await svc.load(wsRoot())
		// Should not throw
		await svc.removeBranch('nonexistent')
	})

	// ── setAssignment ─────────────────────────────────────────────────────────

	test('setAssignment: records assignment and fires event', async () => {
		await svc.load(wsRoot())
		await svc.addBranch({ name: 'feature/docs', color: '#fff', base: 'main' })
		const events: Array<{ relativePath: string; branch: string | undefined }> = []
		svc.onDidChangeAssignment((e) => events.push({ relativePath: e.relativePath, branch: e.branch }))
		await svc.setAssignment('src/foo.ts', 'feature/docs')
		assert.strictEqual(svc.getAssignment('src/foo.ts'), 'feature/docs')
		assert.strictEqual(events.length, 1)
		assert.strictEqual(events[0].relativePath, 'src/foo.ts')
		assert.strictEqual(events[0].branch, 'feature/docs')
	})

	test('setAssignment: normalises Windows-style path separators', async () => {
		await svc.load(wsRoot())
		await svc.addBranch({ name: 'feature/docs', color: '#fff', base: 'main' })
		await svc.setAssignment('src\\foo.ts', 'feature/docs')
		assert.strictEqual(svc.getAssignment('src/foo.ts'), 'feature/docs')
	})

	test('setAssignment: throws ConfigError for unknown branch', async () => {
		await svc.load(wsRoot())
		await assert.rejects(
			() => svc.setAssignment('src/foo.ts', 'nonexistent'),
			ConfigError,
		)
	})

	// ── removeAssignment ──────────────────────────────────────────────────────

	test('removeAssignment: removes entry and fires event', async () => {
		await svc.load(wsRoot())
		await svc.addBranch({ name: 'feature/docs', color: '#fff', base: 'main' })
		await svc.setAssignment('README.md', 'feature/docs')
		const events: Array<{ branch: string | undefined }> = []
		svc.onDidChangeAssignment((e) => events.push({ branch: e.branch }))
		await svc.removeAssignment('README.md')
		assert.strictEqual(svc.getAssignment('README.md'), undefined)
		assert.strictEqual(events[0].branch, undefined)
	})

	test('removeAssignment: no-op if file not assigned', async () => {
		await svc.load(wsRoot())
		// Should not throw or fire event
		const events: unknown[] = []
		svc.onDidChangeAssignment((e) => events.push(e))
		await svc.removeAssignment('src/notassigned.ts')
		assert.strictEqual(events.length, 0)
	})

	// ── Persistence ───────────────────────────────────────────────────────────

	test('changes are persisted to disk and survive reload', async () => {
		await svc.load(wsRoot())
		await svc.addBranch({ name: 'feature/docs', color: '#4CAF50', base: 'main' })
		await svc.setAssignment('src/foo.ts', 'feature/docs')

		// Reload in a fresh instance
		ConfigService.resetInstance()
		const svc2 = ConfigService.getInstance()
		await svc2.load(wsRoot())
		assert.strictEqual(svc2.getStack().length, 1)
		assert.strictEqual(svc2.getAssignment('src/foo.ts'), 'feature/docs')
		svc2.dispose()
	})

	// ── .gitignore management ─────────────────────────────────────────────────

	test('first write creates .gitignore with .worktrees/ entry', async () => {
		await svc.load(wsRoot())
		await svc.addBranch({ name: 'feature/docs', color: '#fff', base: 'main' })
		const content = fs.readFileSync(gitignorePath(), 'utf-8')
		assert.ok(content.includes('.worktrees/'), '.gitignore should contain .worktrees/')
	})

	test('write does not duplicate .gitignore entry', async () => {
		fs.writeFileSync(gitignorePath(), '.worktrees/\n', 'utf-8')
		await svc.load(wsRoot())
		await svc.addBranch({ name: 'feature/docs', color: '#fff', base: 'main' })
		const content = fs.readFileSync(gitignorePath(), 'utf-8')
		const count = content.split('\n').filter((l) => l.trim() === '.worktrees/').length
		assert.strictEqual(count, 1)
	})

	test('write appends to existing .gitignore without overwriting', async () => {
		fs.writeFileSync(gitignorePath(), 'node_modules/\ndist/\n', 'utf-8')
		await svc.load(wsRoot())
		await svc.addBranch({ name: 'feature/docs', color: '#fff', base: 'main' })
		const content = fs.readFileSync(gitignorePath(), 'utf-8')
		assert.ok(content.includes('node_modules/'), 'existing entries preserved')
		assert.ok(content.includes('.worktrees/'), '.worktrees/ added')
	})

	// ── reorderStack ──────────────────────────────────────────────────────────

	test('reorderStack: updates order values correctly', async () => {
		await svc.load(wsRoot())
		await svc.addBranch({ name: 'feature/docs', color: '#fff', base: 'main' })
		await svc.addBranch({ name: 'feature/impl', color: '#fff', base: 'feature/docs' })
		// Reverse order
		await svc.reorderStack(['feature/impl', 'feature/docs'])
		const stack = svc.getStack()
		assert.strictEqual(stack[0].name, 'feature/impl')
		assert.strictEqual(stack[0].order, 1)
		assert.strictEqual(stack[1].name, 'feature/docs')
		assert.strictEqual(stack[1].order, 2)
	})
})
