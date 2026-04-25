import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'
import {
	VirtualBranchStore,
	encodeBranchToFilename,
} from '../src/virtualBranchStore'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Fresh temporary workspace root per test — keeps tests from racing on
 * `.worktrees/virtual/` state (our normal shared test fixture leaves debris
 * when load/compact paths overlap).
 */
function freshRoot(): vscode.Uri {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbraid-vstore-'))
	fs.mkdirSync(path.join(dir, '.worktrees'), { recursive: true })
	return vscode.Uri.file(dir)
}

function cleanup(root: vscode.Uri): void {
	try { fs.rmSync(root.fsPath, { recursive: true, force: true }) } catch { /* ignore */ }
}

function bytes(s: string): Uint8Array {
	return Buffer.from(s, 'utf-8')
}

function toString(u: Uint8Array | undefined): string | undefined {
	return u === undefined ? undefined : Buffer.from(u).toString('utf-8')
}

function virtualFile(root: vscode.Uri, branch: string): string {
	return path.join(root.fsPath, '.worktrees', 'virtual', encodeBranchToFilename(branch) + '.jsonl')
}

// ─── Suite ───────────────────────────────────────────────────────────────────

suite('VirtualBranchStore', () => {

	let root: vscode.Uri
	let store: VirtualBranchStore

	setup(async () => {
		root = freshRoot()
		store = new VirtualBranchStore()
		await store.load(root)
	})

	teardown(() => {
		store.dispose()
		cleanup(root)
	})

	// ─── encodeBranchToFilename ──────────────────────────────────────────────

	test('encodeBranchToFilename: produces slug + 7-hex-char suffix', () => {
		assert.match(encodeBranchToFilename('feature/docs'), /^feature-docs__[a-f0-9]{7}$/)
		assert.match(encodeBranchToFilename('main'), /^main__[a-f0-9]{7}$/)
	})

	test('encodeBranchToFilename: collision-resistant for slug-colliding names', () => {
		assert.notStrictEqual(
			encodeBranchToFilename('feature/a'),
			encodeBranchToFilename('feature-a'),
		)
	})

	test('encodeBranchToFilename: deterministic', () => {
		assert.strictEqual(
			encodeBranchToFilename('feat/x'),
			encodeBranchToFilename('feat/x'),
		)
	})

	// ─── Basic round-trip ────────────────────────────────────────────────────

	test('writeFile + readFile: round-trips content for a single branch', async () => {
		await store.writeFile('feat/a', 'src/foo.ts', bytes('const x = 1'))
		assert.strictEqual(toString(store.readFile('feat/a', 'src/foo.ts')), 'const x = 1')
	})

	test('writeFile: persists to JSONL on disk', async () => {
		await store.writeFile('feat/a', 'src/foo.ts', bytes('hello'))
		const file = virtualFile(root, 'feat/a')
		assert.ok(fs.existsSync(file), 'JSONL file should exist')
		const raw = fs.readFileSync(file, 'utf-8').trim().split('\n')
		assert.strictEqual(raw.length, 1, 'should have one entry')
		const entry = JSON.parse(raw[0])
		assert.strictEqual(entry.path, 'src/foo.ts')
		assert.strictEqual(Buffer.from(entry.contentBase64, 'base64').toString('utf-8'), 'hello')
	})

	test('writeFile: overwrite semantics — latest wins', async () => {
		await store.writeFile('b', 'src/f.ts', bytes('v1'))
		await store.writeFile('b', 'src/f.ts', bytes('v2'))
		await store.writeFile('b', 'src/f.ts', bytes('v3'))
		assert.strictEqual(toString(store.readFile('b', 'src/f.ts')), 'v3')
	})

	test('writeFile: normalises Windows path separators', async () => {
		await store.writeFile('b', 'src\\win\\path.ts', bytes('x'))
		assert.ok(store.hasFile('b', 'src/win/path.ts'), 'forward-slash lookup should succeed')
		assert.strictEqual(toString(store.readFile('b', 'src/win/path.ts')), 'x')
	})

	test('writeFile: isolates branches from each other', async () => {
		await store.writeFile('alpha', 'shared.txt', bytes('A'))
		await store.writeFile('beta', 'shared.txt', bytes('B'))
		assert.strictEqual(toString(store.readFile('alpha', 'shared.txt')), 'A')
		assert.strictEqual(toString(store.readFile('beta', 'shared.txt')), 'B')
	})

	test('writeFile: rejects files beyond the size cap silently', async () => {
		const huge = Buffer.alloc(11 * 1024 * 1024) // 11 MB > 10 MB cap
		await store.writeFile('b', 'huge.bin', huge)
		assert.strictEqual(store.readFile('b', 'huge.bin'), undefined)
	})

	// ─── Deletion ────────────────────────────────────────────────────────────

	test('deleteFile: clears the file and marks it deleted', async () => {
		await store.writeFile('b', 'src/f.ts', bytes('v1'))
		await store.deleteFile('b', 'src/f.ts')
		assert.strictEqual(store.readFile('b', 'src/f.ts'), undefined)
		assert.strictEqual(store.hasFile('b', 'src/f.ts'), false)
		assert.strictEqual(store.isDeleted('b', 'src/f.ts'), true)
	})

	test('writeFile after deleteFile: revives the path', async () => {
		await store.writeFile('b', 'src/f.ts', bytes('v1'))
		await store.deleteFile('b', 'src/f.ts')
		await store.writeFile('b', 'src/f.ts', bytes('v2'))
		assert.strictEqual(toString(store.readFile('b', 'src/f.ts')), 'v2')
		assert.strictEqual(store.isDeleted('b', 'src/f.ts'), false)
	})

	// ─── listFiles / listBranches ────────────────────────────────────────────

	test('listFiles: returns only live (non-deleted) paths', async () => {
		await store.writeFile('b', 'a.ts', bytes('A'))
		await store.writeFile('b', 'sub/b.ts', bytes('B'))
		await store.writeFile('b', 'c.ts', bytes('C'))
		await store.deleteFile('b', 'c.ts')
		const files = store.listFiles('b').sort()
		assert.deepStrictEqual(files, ['a.ts', 'sub/b.ts'])
	})

	test('listBranches: returns every branch with at least one entry', async () => {
		await store.writeFile('b1', 'x.ts', bytes('1'))
		await store.writeFile('b2', 'y.ts', bytes('2'))
		const branches = store.listBranches().sort()
		assert.deepStrictEqual(branches, ['b1', 'b2'])
	})

	// ─── removeBranch ────────────────────────────────────────────────────────

	test('removeBranch: drops in-memory state and deletes JSONL', async () => {
		await store.writeFile('b', 'f.ts', bytes('x'))
		const file = virtualFile(root, 'b')
		assert.ok(fs.existsSync(file))
		await store.removeBranch('b')
		assert.strictEqual(store.readFile('b', 'f.ts'), undefined)
		assert.strictEqual(fs.existsSync(file), false, 'JSONL file should be deleted')
	})

	test('removeBranch: idempotent when the JSONL file does not exist', async () => {
		await store.removeBranch('never-used')
		assert.deepStrictEqual(store.listBranches(), [])
	})

	// ─── renameBranch ────────────────────────────────────────────────────────

	test('renameBranch: preserves data and renames the JSONL file', async () => {
		await store.writeFile('old/name', 'f.ts', bytes('x'))
		await store.renameBranch('old/name', 'new/name')
		assert.strictEqual(toString(store.readFile('new/name', 'f.ts')), 'x')
		assert.strictEqual(fs.existsSync(virtualFile(root, 'old/name')), false)
		assert.ok(fs.existsSync(virtualFile(root, 'new/name')))
	})

	test('renameBranch: no-op when names are equal', async () => {
		await store.writeFile('b', 'f.ts', bytes('x'))
		await store.renameBranch('b', 'b')
		assert.strictEqual(toString(store.readFile('b', 'f.ts')), 'x')
	})

	// ─── Persistence ─────────────────────────────────────────────────────────

	test('load: restores state from JSONL after a fresh store instance', async () => {
		await store.writeFile('b', 'src/f.ts', bytes('persisted'))
		await store.writeFile('b', 'src/g.ts', bytes('also persisted'))
		store.dispose()
		const fresh = new VirtualBranchStore()
		await fresh.load(root, ['b'])
		try {
			assert.strictEqual(toString(fresh.readFile('b', 'src/f.ts')), 'persisted')
			assert.strictEqual(toString(fresh.readFile('b', 'src/g.ts')), 'also persisted')
		} finally {
			fresh.dispose()
		}
	})

	test('load: reapplies deletions recorded in the log', async () => {
		await store.writeFile('b', 'src/f.ts', bytes('v1'))
		await store.deleteFile('b', 'src/f.ts')
		store.dispose()
		const fresh = new VirtualBranchStore()
		await fresh.load(root, ['b'])
		try {
			assert.strictEqual(fresh.readFile('b', 'src/f.ts'), undefined)
			assert.strictEqual(fresh.isDeleted('b', 'src/f.ts'), true)
		} finally {
			fresh.dispose()
		}
	})

	test('load: ignores branches not listed by the caller', async () => {
		await store.writeFile('seeded', 'src/f.ts', bytes('x'))
		store.dispose()
		const fresh = new VirtualBranchStore()
		await fresh.load(root, []) // caller's config has no virtual branches yet
		try {
			assert.strictEqual(fresh.readFile('seeded', 'src/f.ts'), undefined)
			assert.deepStrictEqual(fresh.listBranches(), [])
		} finally {
			fresh.dispose()
		}
	})

	test('load: tolerates a truncated / malformed trailing line', async () => {
		await store.writeFile('b', 'src/f.ts', bytes('v1'))
		// Append a partial JSON line, simulating a crash during append.
		fs.appendFileSync(virtualFile(root, 'b'), '{"path":"src/g.ts","con')
		store.dispose()
		const fresh = new VirtualBranchStore()
		await fresh.load(root, ['b'])
		try {
			// The earlier valid entry survives.
			assert.strictEqual(toString(fresh.readFile('b', 'src/f.ts')), 'v1')
			// The partial line is silently dropped.
			assert.strictEqual(fresh.readFile('b', 'src/g.ts'), undefined)
		} finally {
			fresh.dispose()
		}
	})

	// ─── Compaction ──────────────────────────────────────────────────────────

	test('compaction: log length stays bounded when overwriting the same file', async () => {
		for (let i = 0; i < 60; i++) {
			await store.writeFile('b', 'src/f.ts', bytes(`v${String(i)}`))
		}
		const file = virtualFile(root, 'b')
		const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean)
		// Without compaction we'd see 60 lines.  With the 2× working-set rule
		// the log should compact well before that.
		assert.ok(lines.length < 60, `log should compact; saw ${String(lines.length)} lines`)
		// Final content is still correct after compaction.
		assert.strictEqual(toString(store.readFile('b', 'src/f.ts')), 'v59')
	})

	// ─── Concurrent writes ───────────────────────────────────────────────────

	test('concurrent writes for the same branch serialise cleanly', async () => {
		await Promise.all([
			store.writeFile('b', 'a.ts', bytes('A')),
			store.writeFile('b', 'b.ts', bytes('B')),
			store.writeFile('b', 'c.ts', bytes('C')),
			store.writeFile('b', 'd.ts', bytes('D')),
		])
		assert.strictEqual(toString(store.readFile('b', 'a.ts')), 'A')
		assert.strictEqual(toString(store.readFile('b', 'b.ts')), 'B')
		assert.strictEqual(toString(store.readFile('b', 'c.ts')), 'C')
		assert.strictEqual(toString(store.readFile('b', 'd.ts')), 'D')
		assert.strictEqual(store.listFiles('b').length, 4)
	})

})
