import * as assert from 'node:assert'
import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ConfigService } from '../src/configService'
import { ConfigError } from '../src/errors'

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
		await svc.setAssignment(String.raw`src\foo.ts`, 'feature/docs')
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

	test('reorderStack: fires onDidChangeStack with reorder type', async () => {
		await svc.load(wsRoot())
		await svc.addBranch({ name: 'feature/a', color: '#fff', base: 'main' })
		await svc.addBranch({ name: 'feature/b', color: '#fff', base: 'feature/a' })
		const events: Array<{ type: string; branch: string }> = []
		svc.onDidChangeStack((e) => events.push({ type: e.type, branch: e.branch }))
		await svc.reorderStack(['feature/b', 'feature/a'])
		assert.strictEqual(events.length, 1)
		assert.strictEqual(events[0].type, 'reorder')
	})

	// ── Hunk assignments ──────────────────────────────────────────────────────

	test('getHunkAssignments: returns undefined when no hunk assignments exist', async () => {
		await svc.load(wsRoot())
		const result = svc.getHunkAssignments('src/foo.ts')
		assert.strictEqual(result, undefined)
	})

	test('setHunkAssignment: stores assignment and can be retrieved', async () => {
		await svc.load(wsRoot())
		await svc.addBranch({ name: 'feature/docs', color: '#fff', base: 'main' })
		await svc.setHunkAssignment('src/foo.ts', 0, 'feature/docs')
		const result = svc.getHunkAssignments('src/foo.ts')
		assert.ok(result instanceof Map)
		assert.strictEqual(result.get(0), 'feature/docs')
	})

	test('setHunkAssignment: stores multiple hunks for the same file', async () => {
		await svc.load(wsRoot())
		await svc.addBranch({ name: 'feature/docs', color: '#fff', base: 'main' })
		await svc.addBranch({ name: 'feature/impl', color: '#aaa', base: 'feature/docs' })
		await svc.setHunkAssignment('src/foo.ts', 0, 'feature/docs')
		await svc.setHunkAssignment('src/foo.ts', 1, 'feature/impl')
		const result = svc.getHunkAssignments('src/foo.ts')
		assert.ok(result instanceof Map)
		assert.strictEqual(result.get(0), 'feature/docs')
		assert.strictEqual(result.get(1), 'feature/impl')
	})

	test('setHunkAssignment: throws ConfigError for unknown branch', async () => {
		await svc.load(wsRoot())
		await assert.rejects(
			() => svc.setHunkAssignment('src/foo.ts', 0, 'nonexistent'),
			(e: Error) => e.constructor.name === 'ConfigError',
		)
	})

	test('setHunkAssignment: fires onDidChangeAssignment event', async () => {
		await svc.load(wsRoot())
		await svc.addBranch({ name: 'feature/docs', color: '#fff', base: 'main' })
		const events: string[] = []
		svc.onDidChangeAssignment((e) => events.push(e.relativePath))
		await svc.setHunkAssignment('src/bar.ts', 2, 'feature/docs')
		assert.strictEqual(events.length, 1)
		assert.strictEqual(events[0], 'src/bar.ts')
	})

	test('removeHunkAssignment: removes a specific hunk assignment', async () => {
		await svc.load(wsRoot())
		await svc.addBranch({ name: 'feature/docs', color: '#fff', base: 'main' })
		await svc.setHunkAssignment('src/foo.ts', 0, 'feature/docs')
		await svc.setHunkAssignment('src/foo.ts', 1, 'feature/docs')
		await svc.removeHunkAssignment('src/foo.ts', 0)
		const result = svc.getHunkAssignments('src/foo.ts')
		assert.ok(result instanceof Map)
		assert.strictEqual(result.has(0), false)
		assert.strictEqual(result.get(1), 'feature/docs')
	})

	test('removeHunkAssignment: removes file entry when last hunk removed', async () => {
		await svc.load(wsRoot())
		await svc.addBranch({ name: 'feature/docs', color: '#fff', base: 'main' })
		await svc.setHunkAssignment('src/foo.ts', 0, 'feature/docs')
		await svc.removeHunkAssignment('src/foo.ts', 0)
		const result = svc.getHunkAssignments('src/foo.ts')
		assert.strictEqual(result, undefined)
	})

	test('removeHunkAssignment: no-op for file with no hunk assignments', async () => {
		await svc.load(wsRoot())
		// Should not throw
		await svc.removeHunkAssignment('src/nonexistent.ts', 0)
	})

	test('clearHunkAssignments: removes all hunks for a file', async () => {
		await svc.load(wsRoot())
		await svc.addBranch({ name: 'feature/docs', color: '#fff', base: 'main' })
		await svc.setHunkAssignment('src/foo.ts', 0, 'feature/docs')
		await svc.setHunkAssignment('src/foo.ts', 1, 'feature/docs')
		await svc.clearHunkAssignments('src/foo.ts')
		const result = svc.getHunkAssignments('src/foo.ts')
		assert.strictEqual(result, undefined)
	})

	test('clearHunkAssignments: no-op when no hunk assignments', async () => {
		await svc.load(wsRoot())
		// Should not throw
		await svc.clearHunkAssignments('src/nothing.ts')
	})

	test('addBranch: throws ConfigError if load() was not called', async () => {
		// svc is freshly created in setup but load() has NOT been called
		await assert.rejects(
			() => svc.addBranch({ name: 'feature/docs', color: '#fff', base: 'main' }),
			(e: Error) => e.constructor.name === 'ConfigError',
		)
	})

	test('getHunkAssignedFiles: returns paths of files with hunk assignments', async () => {
		await svc.load(wsRoot())
		await svc.addBranch({ name: 'feature/docs', color: '#fff', base: 'main' })
		await svc.setHunkAssignment('src/a.ts', 0, 'feature/docs')
		await svc.setHunkAssignment('src/b.ts', 1, 'feature/docs')
		const files = svc.getHunkAssignedFiles()
		assert.ok(files.includes('src/a.ts'))
		assert.ok(files.includes('src/b.ts'))
	})

	test('getHunkAssignedFiles: returns empty array when no hunk assignments', async () => {
		await svc.load(wsRoot())
		const files = svc.getHunkAssignedFiles()
		assert.deepStrictEqual(files, [])
	})

	test('hunk assignments persist across reload', async () => {
		await svc.load(wsRoot())
		await svc.addBranch({ name: 'feature/docs', color: '#fff', base: 'main' })
		await svc.setHunkAssignment('src/foo.ts', 0, 'feature/docs')

		// Reload in fresh instance
		ConfigService.resetInstance()
		const svc2 = ConfigService.getInstance()
		await svc2.load(wsRoot())
		const result = svc2.getHunkAssignments('src/foo.ts')
		assert.ok(result instanceof Map)
		assert.strictEqual(result.get(0), 'feature/docs')
		svc2.dispose()
	})
})
