import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { JsonlLog, parseJsonlLines } from '../src/jsonlLog'
import { withFileLock } from '../src/fileLock'

interface Row { id: number, pad?: string }

function parseRow(raw: unknown): Row | undefined {
	if (typeof raw !== 'object' || raw === null) return undefined
	const r = raw as Record<string, unknown>
	return typeof r.id === 'number' ? (raw as Row) : undefined
}

function mkLog(file: string, extra: Partial<ConstructorParameters<typeof JsonlLog<Row>>[0]> = {}): JsonlLog<Row> {
	return new JsonlLog<Row>({ path: file, parse: parseRow, ...extra })
}

/** Count successful `fs.promises.rename` calls made while `fn` runs. */
async function countRenames<T>(fn: () => Promise<T>): Promise<{ result: T, renames: number }> {
	const real = fs.promises.rename
	let renames = 0
	fs.promises.rename = (async (...args: Parameters<typeof real>) => {
		renames++
		return real(...args)
	}) as typeof real
	try {
		return { result: await fn(), renames }
	} finally {
		fs.promises.rename = real
	}
}

suite('JsonlLog', () => {
	let dir: string
	let file: string

	setup(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbraid-jsonl-'))
		file = path.join(dir, 'log.jsonl')
	})

	teardown(() => {
		try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
	})

	test('readAll: a missing file is an empty log', async () => {
		const l = mkLog(file)
		assert.deepStrictEqual(await l.readAll(), [])
		assert.deepStrictEqual(l.stats(), { lines: 0, bytes: 0, skipped: 0 })
	})

	test('append then readAll: round-trips in order, one line per entry', async () => {
		const l = mkLog(file)
		for (let i = 0; i < 25; i++) await l.append({ id: i })
		assert.deepStrictEqual((await l.readAll()).map((r) => r.id), Array.from({ length: 25 }, (_, i) => i))
		assert.strictEqual(fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).length, 25)
	})

	test('readAll: skips a corrupt middle line and counts it', async () => {
		fs.writeFileSync(file, '{"id":1}\nnot json at all\n{"id":3}\n')
		const l = mkLog(file)
		assert.deepStrictEqual((await l.readAll()).map((r) => r.id), [1, 3])
		assert.strictEqual(l.stats().skipped, 1)
		assert.strictEqual(l.stats().lines, 2)
	})

	test('readAll: lines rejected by parse are skipped and counted', async () => {
		fs.writeFileSync(file, '{"id":1}\n{"nope":true}\n{"id":"x"}\n{"id":4}\n')
		const l = mkLog(file)
		assert.deepStrictEqual((await l.readAll()).map((r) => r.id), [1, 4])
		assert.strictEqual(l.stats().skipped, 2)
	})

	test('torn final line: ignored by readAll, and the next append starts on a fresh line', async () => {
		fs.writeFileSync(file, '{"id":1}\n{"id":2,"pa') // crash mid-append: no newline
		const l = mkLog(file)
		assert.deepStrictEqual((await l.readAll()).map((r) => r.id), [1])
		await l.append({ id: 3 })
		// Without the repair the new entry would be glued to the torn fragment
		// and both would be lost.
		assert.deepStrictEqual((await mkLog(file).readAll()).map((r) => r.id), [1, 3])
	})

	test('a final line with no newline is kept when it is complete', async () => {
		fs.writeFileSync(file, '{"id":1}\n{"id":2}')
		assert.deepStrictEqual((await mkLog(file).readAll()).map((r) => r.id), [1, 2])
	})

	test('concurrent appends from separate instances (small and large lines) all land intact', async () => {
		const big = 'x'.repeat(6000) // larger than a typical pipe/page write
		const a = mkLog(file)
		const b = mkLog(file)
		const work: Array<Promise<void>> = []
		for (let i = 0; i < 150; i++) {
			work.push(a.append({ id: i, pad: i % 10 === 0 ? big : undefined }))
			work.push(b.append({ id: 1000 + i, pad: i % 10 === 0 ? big : undefined }))
		}
		await Promise.all(work)
		const reader = mkLog(file)
		const rows = await reader.readAll()
		assert.strictEqual(rows.length, 300)
		assert.strictEqual(reader.stats().skipped, 0, 'no interleaved or torn lines')
		assert.strictEqual(new Set(rows.map((r) => r.id)).size, 300)
	})

	test('an append racing a locked read-modify-write is not lost', async () => {
		const a = mkLog(file)
		const b = mkLog(file)
		await a.append({ id: 1 })
		await a.append({ id: 2 })
		await Promise.all([
			// Read, wait, then write back exactly what was read.
			a.withLock(async (locked) => {
				const rows = await locked.readAll()
				await new Promise((r) => setTimeout(r, 40)) // widen the window
				await locked.rewrite(rows)
			}),
			b.append({ id: 3 }),
		])
		// Whichever order they ran in, the append must survive: either the task
		// saw it (it ran first) or it landed after the rewrite.  Landing in
		// between and being overwritten is the bug this guards against.
		const ids = (await mkLog(file).readAll()).map((r) => r.id).sort()
		assert.deepStrictEqual(ids, [1, 2, 3])
	})

	test('rewrite: replaces contents atomically and leaves no tmp file', async () => {
		const l = mkLog(file)
		await l.append({ id: 1 })
		await l.rewrite([{ id: 7 }, { id: 8 }])
		assert.deepStrictEqual((await l.readAll()).map((r) => r.id), [7, 8])
		assert.ok(!fs.existsSync(file + '.tmp'))
		await l.rewrite([])
		assert.strictEqual(fs.readFileSync(file, 'utf-8'), '')
	})

	test('rewrite: a crash between writing the tmp file and the rename leaves the original intact', async () => {
		const l = mkLog(file)
		await l.append({ id: 1 })
		await l.append({ id: 2 })

		const real = fs.promises.rename
		fs.promises.rename = (async () => { throw new Error('simulated crash before rename') }) as typeof real
		try {
			await assert.rejects(l.rewrite([{ id: 99 }]), /simulated crash/)
		} finally {
			fs.promises.rename = real
		}

		assert.deepStrictEqual((await mkLog(file).readAll()).map((r) => r.id), [1, 2], 'original contents untouched')
		assert.ok(fs.existsSync(file + '.tmp'), 'the interrupted tmp file is left behind')
		assert.ok(!fs.existsSync(file + '.lock'), 'the lock is released even though the rewrite failed')

		// The next rewrite overwrites the stray tmp file and completes normally.
		await l.rewrite([{ id: 5 }])
		assert.deepStrictEqual((await l.readAll()).map((r) => r.id), [5])
		assert.ok(!fs.existsSync(file + '.tmp'))
	})

	test('compaction: runs every compactEvery appends and keeps what compact() returns', async () => {
		const l = mkLog(file, { compact: (rows) => rows.slice(-100), compactEvery: 50 })
		const { renames } = await countRenames(async () => {
			for (let i = 0; i < 1000; i++) await l.append({ id: i })
		})
		const rows = await l.readAll()
		assert.ok(rows.length <= 150, `log stays bounded, saw ${String(rows.length)} rows`)
		assert.deepStrictEqual(rows.slice(-100).map((r) => r.id), Array.from({ length: 100 }, (_, i) => 900 + i))
		// A rewrite on every append at capacity would be ~900; amortised it is ~20.
		assert.ok(renames > 0 && renames <= 30, `expected about 20 rewrites, saw ${String(renames)}`)
	})

	test('compaction: nothing to drop means no rewrite', async () => {
		const l = mkLog(file, { compact: (rows) => rows, compactEvery: 5 })
		const { renames } = await countRenames(async () => {
			for (let i = 0; i < 20; i++) await l.append({ id: i })
		})
		assert.strictEqual(renames, 0)
	})

	test('withLock: tasks on separate instances never overlap, and the handle can append and rewrite', async () => {
		const a = mkLog(file)
		const b = mkLog(file)
		let active = 0
		let maxActive = 0
		const task = (id: number) => async (locked: { readAll: () => Promise<Row[]>, append: (r: Row) => Promise<void> }) => {
			active++
			maxActive = Math.max(maxActive, active)
			const before = await locked.readAll()
			await new Promise((r) => setTimeout(r, 15))
			await locked.append({ id: id * 100 + before.length })
			active--
		}
		await Promise.all([a.withLock(task(1)), b.withLock(task(2)), a.withLock(task(3)), b.withLock(task(4))])
		assert.strictEqual(maxActive, 1, 'the critical sections must be exclusive')
		assert.strictEqual((await mkLog(file).readAll()).length, 4)
	})

	test('withLock: releases the lock when the task throws', async () => {
		const l = mkLog(file)
		await assert.rejects(l.withLock(async () => { throw new Error('boom') }), /boom/)
		assert.ok(!fs.existsSync(file + '.lock'))
		await l.append({ id: 1 }) // and the log is still usable
		assert.strictEqual((await l.readAll()).length, 1)
	})

	test('a stale lock file left by a crashed holder does not block writers', async () => {
		fs.writeFileSync(file + '.lock', '')
		const old = new Date(Date.now() - 120_000)
		fs.utimesSync(file + '.lock', old, old)
		const l = mkLog(file)
		await l.append({ id: 1 }) // appends take the lock, so a stale one must be cleared
		assert.strictEqual((await l.readAll()).length, 1)
		assert.ok(!fs.existsSync(file + '.lock'))
	})

	test('remove: deletes the file, is idempotent, and the log can be reused', async () => {
		const l = mkLog(file)
		await l.append({ id: 1 })
		await l.remove()
		assert.ok(!fs.existsSync(file))
		await l.remove()
		await l.append({ id: 2 })
		assert.deepStrictEqual((await l.readAll()).map((r) => r.id), [2])
	})
})

suite('parseJsonlLines', () => {
	test('handles CRLF, blank lines and whitespace', () => {
		const { entries, skipped } = parseJsonlLines('{"id":1}\r\n\r\n  {"id":2}  \r\n', parseRow)
		assert.deepStrictEqual(entries.map((r) => r.id), [1, 2])
		assert.strictEqual(skipped, 0)
	})

	test('empty input is empty', () => {
		assert.deepStrictEqual(parseJsonlLines('', parseRow), { entries: [], skipped: 0 })
	})
})

suite('withFileLock', () => {
	let dir: string

	setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbraid-flock-')) })
	teardown(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })

	test('gives up with an error when the lock stays held', async () => {
		const lock = path.join(dir, 'x.lock')
		fs.writeFileSync(lock, '')
		await assert.rejects(
			withFileLock(lock, async () => 1, { staleMs: 60_000, retryDelayMs: 1, maxRetries: 5 }),
			/could not acquire lock/,
		)
		assert.ok(fs.existsSync(lock), 'a lock we did not take must not be deleted')
	})

	test('treats Windows-style EPERM/EACCES/EBUSY on open as contention and retries', async () => {
		const realOpen = fs.promises.open
		let calls = 0
		const codes = ['EPERM', 'EACCES', 'EBUSY']
		;(fs.promises as { open: unknown }).open = async (...args: Parameters<typeof realOpen>) => {
			if (calls < codes.length) throw Object.assign(new Error('locked'), { code: codes[calls++] })
			return realOpen(...args)
		}
		try {
			const lock = path.join(dir, 'z.lock')
			assert.strictEqual(await withFileLock(lock, async () => 7, { retryDelayMs: 1, maxRetries: 10 }), 7)
			assert.strictEqual(calls, 3)
		} finally {
			;(fs.promises as { open: unknown }).open = realOpen
		}
	})

	test('other open errors are not swallowed', async () => {
		const realOpen = fs.promises.open
		;(fs.promises as { open: unknown }).open = async () => { throw Object.assign(new Error('nope'), { code: 'ENOSPC' }) }
		try {
			await assert.rejects(withFileLock(path.join(dir, 'w.lock'), async () => 1, { retryDelayMs: 1, maxRetries: 3 }), /nope/)
		} finally {
			;(fs.promises as { open: unknown }).open = realOpen
		}
	})

	test('returns the task result and removes the lock', async () => {
		const lock = path.join(dir, 'y.lock')
		assert.strictEqual(await withFileLock(lock, async () => 42), 42)
		assert.ok(!fs.existsSync(lock))
	})
})
