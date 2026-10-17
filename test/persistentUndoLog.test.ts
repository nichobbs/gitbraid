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
		// PersistentUndoLog enforces a floor of 10 entries — pass 5 and expect 10.
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

	test('enforces maxEntries cap (floor of 10)', async () => {
		// Append 12 entries — the floor of 10 means the oldest 2 get dropped.
		for (let i = 0; i < 12; i++) {
			await logInstance.append({ ts: new Date().toISOString(), action: 'noop', detail: { i } })
		}
		const entries = await logInstance.load()
		assert.strictEqual(entries.length, 10, 'the oldest two entries should be dropped')
		assert.deepStrictEqual(entries.map((e) => e.detail.i), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
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

	test('at capacity, appends do not rewrite the file every time', async () => {
		// Previously every append past the cap rewrote the whole file (O(n) each).
		const real = fs.promises.rename
		let renames = 0
		fs.promises.rename = (async (...args: Parameters<typeof real>) => { renames++; return real(...args) }) as typeof real
		try {
			const capped = new PersistentUndoLog(dir, { maxEntries: 100 })
			for (let i = 0; i < 1000; i++) {
				await capped.append({ ts: 't', action: 'noop', detail: { i } })
			}
			const entries = await capped.load()
			assert.strictEqual(entries.length, 100, 'load() still reports exactly the newest 100')
			assert.deepStrictEqual(entries.map((e) => e.detail.i), Array.from({ length: 100 }, (_, k) => 900 + k))
			assert.ok(renames <= 30, `expected about 20 rewrites for 1000 appends, saw ${String(renames)}`)
		} finally {
			fs.promises.rename = real
		}
	})

	test('the file stays bounded on disk even though load() caps logically', async () => {
		const capped = new PersistentUndoLog(dir, { maxEntries: 100 })
		for (let i = 0; i < 400; i++) await capped.append({ ts: 't', action: 'noop', detail: { i } })
		const lines = fs.readFileSync(capped.path, 'utf-8').split('\n').filter(Boolean)
		assert.ok(lines.length <= 150, `compaction keeps the file near the cap, saw ${String(lines.length)} lines`)
	})

	test('popLast: an append racing a pop is not lost', async () => {
		await logInstance.append({ ts: 'a', action: 'a', detail: {} })
		await logInstance.append({ ts: 'b', action: 'b', detail: {} })
		const other = new PersistentUndoLog(dir, { maxEntries: 5 }) // a second window
		const [popped] = await Promise.all([
			logInstance.popLast(),
			other.append({ ts: 'c', action: 'c', detail: {} }),
		])
		const actions = (await logInstance.load()).map((e) => e.action)
		// Whichever ran first, exactly one entry was popped and none vanished:
		// the pop removed the newest entry present when it held the lock.
		assert.ok(popped !== undefined)
		assert.strictEqual(actions.length, 2)
		assert.ok(actions.includes('a'))
	})

	test('writeAll then load round-trips and replaces prior contents', async () => {
		await logInstance.append({ ts: 'x', action: 'x', detail: {} })
		await logInstance.writeAll([{ ts: '1', action: 'one', detail: {} }, { ts: '2', action: 'two', detail: {} }])
		assert.deepStrictEqual((await logInstance.load()).map((e) => e.action), ['one', 'two'])
	})

	test('append never throws, even when the directory cannot be created', async () => {
		const blocker = path.join(dir, 'blocker')
		fs.writeFileSync(blocker, 'a file where a directory is needed')
		const bad = new PersistentUndoLog(path.join(blocker, 'nested'))
		await assert.doesNotReject(bad.append({ ts: 't', action: 'noop', detail: {} }))
		assert.deepStrictEqual(await bad.load(), [])
	})
})
