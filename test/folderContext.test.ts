import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { FolderContext } from '../src/folderContext'
import { SubmitStackService } from '../src/submitStackService'
import { git } from '../src/gitFunctions'

// `FolderContext.initialize()` drives real `git worktree` operations through
// the `git` singleton, which is hardcoded to operate against
// `vscode.workspace.workspaceFolders[0]` (see `gitFunctions.ts`
// `Git._defaultCwd`) rather than whatever root is passed in — the same
// constraint `folderRegistry.test.ts`'s "initialize an actual git folder"
// suite works around by only asserting the non-git-folder skip path. This
// suite exercises the full `initialize()` flow against the shared test
// workspace, matching the pattern already used by `gitBraidApi.test.ts` /
// `doctorService.test.ts` for the same reason.

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

function cleanup(): void {
	try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true, force: true }) } catch { /* ignore */ }
	try { fs.rmSync(path.join(wsRoot().fsPath, '.gitignore')) } catch { /* ignore */ }
}

class FakeSecretStorage implements vscode.SecretStorage {
	private readonly _store = new Map<string, string>()
	readonly onDidChange = (() => ({ dispose: () => { /* */ } })) as unknown as vscode.Event<vscode.SecretStorageChangeEvent>
	async get(key: string): Promise<string | undefined> { return this._store.get(key) }
	async store(key: string, value: string): Promise<void> { this._store.set(key, value) }
	async delete(key: string): Promise<void> { this._store.delete(key) }
}

suite('FolderContext', function () {
	this.timeout(15_000)

	let ctx: FolderContext

	type WinAny = Record<string, (...args: unknown[]) => Promise<unknown>>
	let origInfo: WinAny['showInformationMessage']
	let origWarn: WinAny['showWarningMessage']

	suiteSetup(async () => {
		await git.init()
		try { await git.add(undefined, '.gitkeep') } catch { /* ignore */ }
		try { await git.commit('initial commit', '--no-gpg-sign') } catch { /* ignore */ }
	})

	setup(() => {
		cleanup()
		const win = vscode.window as unknown as WinAny
		origInfo = win.showInformationMessage
		origWarn = win.showWarningMessage
		win.showInformationMessage = async () => undefined
		win.showWarningMessage = async () => undefined
		ctx = new FolderContext(wsRoot())
	})

	teardown(() => {
		ctx.dispose()
		cleanup()
		const win = vscode.window as unknown as WinAny
		win.showInformationMessage = origInfo
		win.showWarningMessage = origWarn
	})

	// ── initialize() ──────────────────────────────────────────────────────────

	test('initialize: loads config and completes without throwing', async () => {
		await assert.doesNotReject(() => ctx.initialize())
		assert.deepStrictEqual(ctx.config.getStack(), [])
	})

	test('initialize: second call is a no-op (idempotent)', async () => {
		await ctx.initialize()
		await ctx.config.addBranch({ name: 'feature/idempotent', base: 'main', color: '#abc' })
		await assert.doesNotReject(() => ctx.initialize())
		// A real re-run would reload config from disk; the branch we added
		// in memory after the first initialize() must survive untouched.
		assert.ok(ctx.config.getStack().some((e) => e.name === 'feature/idempotent'))
	})

	test('initialize: re-watches on subsequent stack changes without throwing', async () => {
		await ctx.initialize()
		// The internal watchAll() re-runs via the onDidChangeStack listener
		// wired in initialize() — adding a branch after the fact (and thus a
		// new worktree to watch) must not throw even though initialize()
		// itself already returned.
		await assert.doesNotReject(() => ctx.branchStack.addBranchToStack('feature/watched', 'main', '#abc'))
		assert.ok(ctx.branchStack.worktreeExists('feature/watched'))
	})

	// ── getPRAdapter / invalidatePRAdapter ───────────────────────────────────

	test('getPRAdapter: no secret storage configured → NullPRHostAdapter, cached across calls', async () => {
		const first = await ctx.getPRAdapter()
		assert.strictEqual(first.name, 'none')
		const second = await ctx.getPRAdapter()
		assert.strictEqual(second, first, 'must return the cached instance, not resolve again')
	})

	test('invalidatePRAdapter: forces a fresh resolve on the next call', async () => {
		const first = await ctx.getPRAdapter()
		ctx.invalidatePRAdapter()
		const second = await ctx.getPRAdapter()
		assert.notStrictEqual(second, first, 'must re-resolve instead of reusing the stale cached adapter')
	})

	test('getPRAdapter: with secret storage configured, still resolves (falls back to Null without a matching remote)', async () => {
		ctx.setSecretStorage(new FakeSecretStorage())
		const adapter = await ctx.getPRAdapter()
		assert.strictEqual(typeof adapter.name, 'string')
	})

	// ── buildSubmitStackService ───────────────────────────────────────────────

	test('buildSubmitStackService: returns a SubmitStackService bound to this folder', async () => {
		const svc = await ctx.buildSubmitStackService()
		assert.ok(svc instanceof SubmitStackService)
	})

	// ── dispose ───────────────────────────────────────────────────────────────

	test('dispose: idempotent, does not throw when called twice', () => {
		assert.doesNotThrow(() => ctx.dispose())
		assert.doesNotThrow(() => ctx.dispose())
	})
})
