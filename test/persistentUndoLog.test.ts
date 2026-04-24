import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { PersistentUndoLog, parseJsonl } from '../src/persistentUndoLog'

function mkTmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'gitbraid-undolog-'))
}

suite('persistentUndoLog: parseJsonl', () => {
	test('returns empty array for empty input', () => {
		assert.deepStrictEqual(parseJsonl(''), [])
	})

	test('tolerates corrupt lines', () => {
		const raw = [
			JSON.stringify({ ts: '2026-01-01T00:00:00Z', action: 'a', detail: {} }),
			'not-json-at-all',
			JSON.stringify({ ts: '2026-01-02T00:00:00Z', action: 'b', detail: { x: 1 } }),
		].join('\n')
		const entries = parseJsonl(raw)
		assert.strictEqual(entries.length, 2)
		assert.strictEqual(entries[0].action, 'a')
		assert.strictEqual(entries[1].action, 'b')
	})
})

suite('PersistentUndoLog', () => {
	let dir: string
	let logInstance: PersistentUndoLog

	setup(() => {
		dir = mkTmp()
		logInstance = new PersistentUndoLog(dir, { maxEntries: 5 })
	})

	teardown(() => {
		try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
	})

	test('load returns empty when file missing', async () => {
		assert.deepStrictEqual(await logInstance.load(), [])
	})

	test('append → load round-trip', async () => {
		for (let i = 0; i < 3; i++) {
			await logInstance.append({ ts: new Date().toISOString(), action: 'noop', detail: { i } })
		}
		const entries = await logInstance.load()
		assert.strictEqual(entries.length, 3)
		assert.deepStrictEqual(entries.map((e) => e.detail.i), [0, 1, 2])
	})

	test('enforces maxEntries cap', async () => {
		for (let i = 0; i < 7; i++) {
			await logInstance.append({ ts: new Date().toISOString(), action: 'noop', detail: { i } })
		}
		const entries = await logInstance.load()
		assert.strictEqual(entries.length, 5, 'the oldest two entries should be dropped')
		assert.deepStrictEqual(entries.map((e) => e.detail.i), [2, 3, 4, 5, 6])
	})

	test('popLast removes the newest entry', async () => {
		await logInstance.append({ ts: 'a', action: 'a', detail: {} })
		await logInstance.append({ ts: 'b', action: 'b', detail: {} })
		const popped = await logInstance.popLast()
		assert.strictEqual(popped?.action, 'b')
		const remaining = await logInstance.load()
		assert.strictEqual(remaining.length, 1)
		assert.strictEqual(remaining[0].action, 'a')
	})

	test('clear removes the file', async () => {
		await logInstance.append({ ts: 'a', action: 'a', detail: {} })
		await logInstance.clear()
		assert.strictEqual(fs.existsSync(logInstance.path), false)
	})
})
