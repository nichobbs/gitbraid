import * as assert from 'node:assert'
import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ConfigService } from '../src/configService'
import { StackShareService, SHARED_DIR, SHARED_FILE, SHARED_SCHEMA_VERSION, isValidSharedFile } from '../src/stackShareService'
import { ConfigError } from '../src/errors'

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

function cleanup(): void {
	try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true, force: true }) } catch { /* ignore */ }
	try { fs.rmSync(path.join(wsRoot().fsPath, SHARED_DIR), { recursive: true, force: true }) } catch { /* ignore */ }
}

suite('StackShareService (T71)', () => {
	let config: ConfigService
	let share: StackShareService

	setup(async () => {
		cleanup()
		ConfigService.resetInstance()
		config = ConfigService.getInstance()
		await config.load(wsRoot())
		share = new StackShareService(config, wsRoot())
	})

	teardown(() => {
		cleanup()
		ConfigService.resetInstance()
	})

	// ── toSharedFile ─────────────────────────────────────────────────────────

	test('toSharedFile: empty config → stamped version, empty stack, empty assignments', () => {
		const out = share.toSharedFile()
		assert.strictEqual(out.version, SHARED_SCHEMA_VERSION)
		assert.deepStrictEqual(out.stack, [])
		assert.deepStrictEqual(out.assignments, {})
		assert.strictEqual(out.hunkAssignments, undefined)
		assert.ok(out.exportedAt, 'exportedAt should be populated')
	})

	test('toSharedFile: serialises stack + assignments (but omits hunkAnchors)', async () => {
		await config.addBranch({ name: 'feature/a', base: 'main', color: '#4ec9b0' })
		await config.addBranch({ name: 'feature/b', base: 'feature/a', color: '#c586c0' })
		await config.setAssignment('src/foo.ts', 'feature/a')
		await config.setAssignment('src/bar.ts', 'feature/b')
		await config.setHunkAssignment('src/foo.ts', 0, 'feature/a', {
			startLine: 1, endLine: 2, bodyHash: 'abc123xyz000',
		})

		const out = share.toSharedFile()
		assert.strictEqual(out.stack.length, 2)
		assert.deepStrictEqual(out.stack.map((e) => e.name), ['feature/a', 'feature/b'])
		assert.strictEqual(out.assignments['src/foo.ts'], 'feature/a')
		assert.ok(out.hunkAssignments, 'hunk assignments should be exported')
		assert.strictEqual(out.hunkAssignments!['src/foo.ts']['0'], 'feature/a')
		// But crucially, NO anchors leak — check the serialised JSON.
		const json = JSON.stringify(out)
		assert.ok(!json.includes('bodyHash'), 'bodyHash must NOT be exported')
		assert.ok(!json.includes('startLine'), 'startLine must NOT be exported')
	})

	// ── exportToDisk + readSharedFile round-trip ─────────────────────────────

	test('export → readSharedFile round-trip preserves shape', async () => {
		await config.addBranch({ name: 'feature/a', base: 'main', color: '#4ec9b0' })
		await config.setAssignment('src/foo.ts', 'feature/a')

		const exported = await share.exportToDisk()
		assert.ok(fs.existsSync(exported), 'exported file should exist')

		const roundtripped = await share.readSharedFile()
		assert.ok(roundtripped, 'readSharedFile should return the file we just wrote')
		assert.strictEqual(roundtripped!.stack.length, 1)
		assert.strictEqual(roundtripped!.assignments['src/foo.ts'], 'feature/a')
	})

	test('readSharedFile: returns undefined when the file does not exist', async () => {
		const result = await share.readSharedFile()
		assert.strictEqual(result, undefined)
	})

	test('readSharedFile: throws ConfigError on malformed JSON', async () => {
		const dir = path.join(wsRoot().fsPath, SHARED_DIR)
		fs.mkdirSync(dir, { recursive: true })
		fs.writeFileSync(path.join(dir, SHARED_FILE), 'not json{', 'utf-8')
		await assert.rejects(() => share.readSharedFile(), ConfigError)
	})

	test('readSharedFile: throws on newer schema version', async () => {
		const dir = path.join(wsRoot().fsPath, SHARED_DIR)
		fs.mkdirSync(dir, { recursive: true })
		fs.writeFileSync(
			path.join(dir, SHARED_FILE),
			JSON.stringify({
				version: SHARED_SCHEMA_VERSION + 1,
				stack: [],
				assignments: {},
			}),
			'utf-8',
		)
		await assert.rejects(() => share.readSharedFile(), /newer version/)
	})

	// ── diffWithCurrent ──────────────────────────────────────────────────────

	test('diffWithCurrent: identifies new + conflicting branches', async () => {
		await config.addBranch({ name: 'feature/a', base: 'main', color: '#4ec9b0' })
		const incoming = {
			version: SHARED_SCHEMA_VERSION,
			stack: [
				{ name: 'feature/a', base: 'develop', color: '#4ec9b0', order: 1 }, // conflict: base
				{ name: 'feature/b', base: 'feature/a', color: '#c586c0', order: 2 }, // new
			],
			assignments: {
				'src/foo.ts': 'feature/a', // new (we have none)
			},
		}
		const diff = share.diffWithCurrent(incoming)
		assert.strictEqual(diff.newBranches.length, 1)
		assert.strictEqual(diff.newBranches[0].name, 'feature/b')
		assert.strictEqual(diff.conflictBranches.length, 1)
		assert.strictEqual(diff.conflictBranches[0].shared.name, 'feature/a')
		assert.strictEqual(diff.newAssignments.length, 1)
		assert.strictEqual(diff.conflictAssignments.length, 0)
	})

	test('diffWithCurrent: identifies conflicting assignments', async () => {
		await config.addBranch({ name: 'feature/a', base: 'main', color: '#4ec9b0' })
		await config.addBranch({ name: 'feature/b', base: 'feature/a', color: '#c586c0' })
		await config.setAssignment('src/foo.ts', 'feature/a')
		const incoming = {
			version: SHARED_SCHEMA_VERSION,
			stack: [],
			assignments: { 'src/foo.ts': 'feature/b' },
		}
		const diff = share.diffWithCurrent(incoming)
		assert.strictEqual(diff.conflictAssignments.length, 1)
		assert.strictEqual(diff.conflictAssignments[0].ours, 'feature/a')
		assert.strictEqual(diff.conflictAssignments[0].shared, 'feature/b')
	})

	// ── applyImport ──────────────────────────────────────────────────────────

	test('applyImport: adds new branches and assignments', async () => {
		const incoming = {
			version: SHARED_SCHEMA_VERSION,
			stack: [{ name: 'feature/new', base: 'main', color: '#aa0000', order: 1 }],
			assignments: { 'src/new.ts': 'feature/new' },
		}
		const summary = await share.applyImport(incoming, { branches: 'theirs', assignments: 'theirs' })
		assert.strictEqual(summary.addedBranches, 1)
		assert.strictEqual(summary.addedAssignments, 1)
		assert.ok(config.getBranch('feature/new'))
		assert.strictEqual(config.getAssignment('src/new.ts'), 'feature/new')
	})

	test('applyImport: resolution=ours skips conflicts, resolution=theirs applies them', async () => {
		await config.addBranch({ name: 'feature/a', base: 'main', color: '#4ec9b0' })
		await config.addBranch({ name: 'feature/b', base: 'feature/a', color: '#c586c0' })
		await config.setAssignment('src/foo.ts', 'feature/a')

		const incoming = {
			version: SHARED_SCHEMA_VERSION,
			stack: [],
			assignments: { 'src/foo.ts': 'feature/b' },
		}

		const keep = await share.applyImport(incoming, { branches: 'ours', assignments: 'ours' })
		assert.strictEqual(keep.updatedAssignments, 0)
		assert.strictEqual(keep.skipped, 1)
		assert.strictEqual(config.getAssignment('src/foo.ts'), 'feature/a', 'local must be preserved')

		const take = await share.applyImport(incoming, { branches: 'theirs', assignments: 'theirs' })
		assert.strictEqual(take.updatedAssignments, 1)
		assert.strictEqual(config.getAssignment('src/foo.ts'), 'feature/b', 'shared must win now')
	})

	// ── isValidSharedFile ────────────────────────────────────────────────────

	test('isValidSharedFile: accepts a well-formed file', () => {
		assert.ok(isValidSharedFile({
			version: 1,
			stack: [{ name: 'a', base: 'main', order: 1 }],
			assignments: {},
		}))
	})

	test('isValidSharedFile: rejects missing fields / wrong types', () => {
		assert.ok(!isValidSharedFile({}))
		assert.ok(!isValidSharedFile({ version: 1, stack: [], assignments: [] })) // assignments is array
		assert.ok(!isValidSharedFile({ version: '1', stack: [], assignments: {} })) // version wrong type
		assert.ok(!isValidSharedFile({ version: 1, stack: [{ name: 'a' }], assignments: {} })) // missing base
	})
})
