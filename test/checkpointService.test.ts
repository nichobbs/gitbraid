import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { CheckpointService } from '../src/checkpointService'
import { ConfigService } from '../src/configService'

function tmpDir(name: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), `gitbraid-${name}-`))
}

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

function cleanup(): void {
	try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true, force: true }) } catch { /* ignore */ }
}

suite('CheckpointService', () => {
	let dir: string
	let config: ConfigService
	let service: CheckpointService

	setup(async () => {
		cleanup()
		dir = tmpDir('checkpoint')
		config = new ConfigService()
		await config.load(wsRoot())
		// Seed some state
		await config.addBranch({ name: 'feat/a', base: 'main', color: '#aaa' })
		await config.addBranch({ name: 'feat/b', base: 'feat/a', color: '#bbb' })
		await config.setAssignment('src/foo.ts', 'feat/a')
		service = new CheckpointService(config, vscode.Uri.file(dir))
	})

	teardown(() => {
		try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
		cleanup()
	})

	test('saveCheckpoint creates a JSON file under checkpoints/ and returns its path', async () => {
		const filePath = await service.saveCheckpoint()
		assert.ok(fs.existsSync(filePath), 'checkpoint file should exist on disk')
		assert.ok(filePath.endsWith('.json'))
		const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { stack: unknown[], assignments: Record<string, string> }
		assert.strictEqual(raw.stack.length, 2)
		assert.strictEqual(raw.assignments['src/foo.ts'], 'feat/a')
	})

	test('saveCheckpoint sanitises label characters', async () => {
		const filePath = await service.saveCheckpoint('my label!! / dangerous')
		const filename = path.basename(filePath)
		// Sanitiser strips non-alnum/_/- chars
		assert.ok(!filename.includes('/'))
		assert.ok(!filename.includes('!'))
		assert.ok(filename.includes('my_label'))
	})

	test('listCheckpoints returns metadata sorted newest-first', async () => {
		await service.saveCheckpoint('first')
		// Force separate timestamps in filename (uses ms precision but same call → may collide).
		await new Promise((r) => setTimeout(r, 10))
		await service.saveCheckpoint('second')
		await new Promise((r) => setTimeout(r, 10))
		await service.saveCheckpoint('third')
		const list = await service.listCheckpoints()
		assert.ok(list.length >= 3)
		// Filenames are ISO-prefixed; descending sort puts newest first.
		const labels = list.map((m) => m.filename)
		assert.ok(labels[0].includes('third'))
		// branch and assignment counts match seed.
		assert.strictEqual(list[0].branchCount, 2)
		assert.strictEqual(list[0].assignmentCount, 1)
	})

	test('listCheckpoints returns [] when checkpoints/ is missing', async () => {
		// Fresh service without saving anything yet
		const fresh = new CheckpointService(config, vscode.Uri.file(tmpDir('empty')))
		assert.deepStrictEqual(await fresh.listCheckpoints(), [])
	})

	test('listCheckpoints skips corrupted JSON files', async () => {
		const filePath = await service.saveCheckpoint('valid')
		// Plant a corrupt sibling
		const bad = path.join(path.dirname(filePath), '2026-04-25T00-00-00-000Z-corrupt.json')
		fs.writeFileSync(bad, 'not-json')
		const list = await service.listCheckpoints()
		// Only the valid one should be enumerated
		assert.ok(list.some((m) => m.filename.includes('valid')))
		assert.ok(!list.some((m) => m.filename.includes('corrupt')))
	})

	test('listCheckpoints skips structurally-invalid configs', async () => {
		const filePath = await service.saveCheckpoint('valid')
		const wrong = path.join(path.dirname(filePath), '2026-04-25T00-00-00-000Z-wrong.json')
		fs.writeFileSync(wrong, JSON.stringify({ not: 'a config' }))
		const list = await service.listCheckpoints()
		assert.ok(!list.some((m) => m.filename.includes('wrong')))
	})

	test('restoreCheckpoint replaces the live config', async () => {
		const filePath = await service.saveCheckpoint('snapshot')
		// Mutate config after snapshot
		await config.removeBranch('feat/a')
		await config.removeAssignment('src/foo.ts')
		assert.strictEqual(config.getStack().find((s) => s.name === 'feat/a'), undefined)
		// Restore
		await service.restoreCheckpoint(filePath)
		assert.ok(config.getStack().find((s) => s.name === 'feat/a'))
		assert.strictEqual(config.getAssignment('src/foo.ts'), 'feat/a')
	})

	test('restoreCheckpoint throws on malformed file', async () => {
		const bogus = path.join(dir, 'bogus.json')
		fs.writeFileSync(bogus, JSON.stringify({ not: 'config' }))
		await assert.rejects(() => service.restoreCheckpoint(bogus), /unexpected structure/)
	})
})
