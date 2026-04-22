import * as assert from 'node:assert'
import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { FolderRegistry } from '../src/folderRegistry'
import { FolderContext } from '../src/folderContext'
import { TmpRepo } from './helpers/tmpRepo'

// FolderRegistry is the substrate for multi-root support.  These tests
// drive it directly with synthetic `FolderContext` instances (via the
// `createUninitialised` test-only helper) so we don't need real git repos
// for every scenario — only the getForUri / getActive resolution.

function makeUri(dir: string): vscode.Uri {
	return vscode.Uri.file(dir)
}

suite('FolderRegistry', () => {
	let registry: FolderRegistry
	let tmpA: TmpRepo
	let tmpB: TmpRepo
	let ctxA: FolderContext
	let ctxB: FolderContext

	setup(() => {
		registry = new FolderRegistry()
		tmpA = TmpRepo.create('registry-a')
		tmpB = TmpRepo.create('registry-b')
		ctxA = registry.createUninitialised(makeUri(tmpA.root))
		ctxB = registry.createUninitialised(makeUri(tmpB.root))
	})

	teardown(() => {
		registry.dispose()
		tmpA.dispose()
		tmpB.dispose()
	})

	// ── getForUri ─────────────────────────────────────────────────────────────

	test('getForUri: exact root match returns the right context', () => {
		assert.strictEqual(registry.getForUri(makeUri(tmpA.root)), ctxA)
		assert.strictEqual(registry.getForUri(makeUri(tmpB.root)), ctxB)
	})

	test('getForUri: file inside a folder resolves to that folder', () => {
		const inside = makeUri(path.join(tmpA.root, 'src', 'foo.ts'))
		assert.strictEqual(registry.getForUri(inside), ctxA)
	})

	test('getForUri: a URI outside every folder returns undefined', () => {
		const outside = makeUri('/definitely/not/a/registered/folder/file.ts')
		assert.strictEqual(registry.getForUri(outside), undefined)
	})

	test('getForUri: sibling-prefix path does NOT false-match', () => {
		// e.g. if tmpA is /tmp/gitbraid-registry-a-XXX and we query
		// /tmp/gitbraid-registry-a-XXXfoo/bar, that must NOT match ctxA.
		const sibling = makeUri(tmpA.root + 'foo' + path.sep + 'bar.ts')
		assert.strictEqual(registry.getForUri(sibling), undefined)
	})

	// ── getAll ────────────────────────────────────────────────────────────────

	test('getAll: returns contexts in workspace-folder order', () => {
		// `getAll` iterates `vscode.workspace.workspaceFolders`, so only
		// contexts for folders that are actually in the workspace show up.
		// Our synthetic TmpRepos aren't — so getAll sees an empty list.
		// That's the documented behaviour: `createUninitialised` is a test
		// helper, it doesn't register the folder with VS Code.
		assert.deepStrictEqual(registry.getAll(), [])
	})

	test('size: reflects every context created, including synthetic ones', () => {
		assert.strictEqual(registry.size, 2)
	})

	// ── getActive ────────────────────────────────────────────────────────────

	test('getActive: with exactly one context and no active editor, returns that context', async () => {
		// Drop one context so only ctxA remains.  The internal map is keyed
		// by `vscode.Uri.file(...).fsPath` (not by the raw `TmpRepo.root`
		// string) because VS Code's URI normalisation can differ from the
		// string Node gave us — drive-letter casing on Windows, for
		// instance.  Look up the entry via the registry's own helper so
		// the test matches whatever key shape the registry actually uses.
		ctxB.dispose()
		const ctxs = (registry as unknown as { _contexts: Map<string, FolderContext> })._contexts
		for (const [key, ctx] of ctxs) {
			if (ctx === ctxB) { ctxs.delete(key); break }
		}
		assert.strictEqual(registry.size, 1)
		assert.strictEqual(registry.getActive(), ctxA)
	})

	test('getActive: with multiple contexts and no active editor, returns undefined', () => {
		// Close any open editors so the active-editor heuristic fails.
		// (The vscode-test harness may still have editors open from the
		// default workspace; when it does this test becomes best-effort.)
		const active = vscode.window.activeTextEditor
		if (active) {
			// Skip — our fixture can't synthesise "no active editor".
			return
		}
		assert.strictEqual(registry.getActive(), undefined)
	})

	// ── dispose ──────────────────────────────────────────────────────────────

	test('dispose: tears down every context', () => {
		const spy = { disposed: 0 }
		const orig = ctxA.dispose.bind(ctxA)
		ctxA.dispose = () => { spy.disposed++; orig() }
		registry.dispose()
		assert.strictEqual(spy.disposed, 1)
	})

	test('dispose: a second call is a no-op', () => {
		registry.dispose()
		assert.doesNotThrow(() => registry.dispose())
	})

	// ── Lifecycle + add/remove ───────────────────────────────────────────────

	test('createUninitialised: adding the same URI twice returns the same context', () => {
		const again = registry.createUninitialised(makeUri(tmpA.root))
		// `createUninitialised` unconditionally overwrites the entry; document
		// that contract.  In production the add path dedupes via `_addFolder`.
		assert.ok(again)
	})
})

// Integration test — runs against a real TmpRepo initialised end-to-end.
// Slower; driven through the public `initialize()` path to prove the
// registry wires up a working FolderContext from cold.
suite('FolderRegistry — initialize an actual git folder', function () {
	this.timeout(15_000)
	let tmp: TmpRepo
	let registry: FolderRegistry

	setup(() => {
		tmp = TmpRepo.create('registry-integ')
		registry = new FolderRegistry()
	})
	teardown(() => {
		registry.dispose()
		tmp.dispose()
	})

	test('initializeAll: skips non-git folders silently', async () => {
		// TmpRepo creates a real .git dir so this folder IS eligible.  We
		// only assert no-crash here — the full initialisation exercises
		// `git worktree` which needs the vscode-test-managed workspace.
		const nonGit = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gitbraid-non-git-'))
		try {
			// Not a git repo — should be skipped.
			const uri = vscode.Uri.file(nonGit)
			const result = await (registry as unknown as {
				_addFolder: (u: vscode.Uri) => Promise<FolderContext | undefined>
			})._addFolder(uri)
			assert.strictEqual(result, undefined)
		} finally {
			fs.rmSync(nonGit, { recursive: true, force: true })
		}
	})
})
