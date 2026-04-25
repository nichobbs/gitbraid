import * as assert from 'node:assert'
import * as vscode from 'vscode'
import { GitBraidApiFacade } from '../src/gitBraidApiFacade'
import type { FolderRegistry } from '../src/folderRegistry'
import type { FolderContext } from '../src/folderContext'
import type { GitBraidApi } from '../src/gitBraidApi'

/**
 * Smoke test that instantiates `GitBraidApiFacade` with a stub registry +
 * stub API and invokes every public method on the exported surface.  The
 * main point is to lift function coverage: every delegate was at 0% in
 * lcov prior to this file, which dragged the CI floor below 60%.
 *
 * Each delegate is a one-liner — if the underlying `GitBraidApi` got the
 * call with the right args, the delegate works.
 */

/** Records every method invocation on the fake API for assertions. */
function makeFakeApi(): { api: GitBraidApi; calls: Array<{ name: string; args: unknown[] }> } {
	const calls: Array<{ name: string; args: unknown[] }> = []
	const record = (name: string) =>
		(...args: unknown[]) => {
			calls.push({ name, args })
			// Return benign-shaped values by method name so TypeScript typing at the
			// caller doesn't complain.  None of the test assertions inspect the
			// returned payloads — they only care about call records.
			switch (name) {
				case 'getStack':            return []
				case 'getVirtualBranches':  return []
				case 'getAssignment':       return undefined
				case 'getFloatingFiles':    return []
				case 'getBranchStatus':     return Promise.resolve({ branch: 'x', staged: 0, unstaged: 0, untracked: 0, floating: 0 })
				case 'getStackStatus':      return Promise.resolve({ branches: [], totalFloating: 0 })
				case 'getHunkAssignments':  return undefined
				case 'routeHunks':          return Promise.resolve({ routed: 0, skipped: 0 })
				default:                    return Promise.resolve()
			}
		}
	const api = {
		getStack:             record('getStack'),
		addBranch:            record('addBranch'),
		removeBranch:         record('removeBranch'),
		materialiseBranch:    record('materialiseBranch'),
		getVirtualBranches:   record('getVirtualBranches'),
		getAssignment:        record('getAssignment'),
		assignFile:           record('assignFile'),
		assignHunk:           record('assignHunk'),
		unassignFile:         record('unassignFile'),
		getFloatingFiles:     record('getFloatingFiles'),
		getBranchStatus:      record('getBranchStatus'),
		getStackStatus:       record('getStackStatus'),
		commitBranch:         record('commitBranch'),
		stageBranch:          record('stageBranch'),
		reorderStack:         record('reorderStack'),
		getHunkAssignments:   record('getHunkAssignments'),
		removeHunkAssignment: record('removeHunkAssignment'),
		pullBranch:           record('pullBranch'),
		syncBranch:           record('syncBranch'),
		rebaseBranch:         record('rebaseBranch'),
		routeHunks:           record('routeHunks'),
		onDidChangeAssignment: new vscode.EventEmitter().event,
		onDidChangeStack:      new vscode.EventEmitter().event,
		onDidSyncFile:         new vscode.EventEmitter().event,
		onDidFloatFile:        new vscode.EventEmitter().event,
	} as unknown as GitBraidApi
	return { api, calls }
}

function makeFakeRegistry(ctx: FolderContext): FolderRegistry {
	const folderEmitter = new vscode.EventEmitter<{ added: FolderContext[]; removed: FolderContext[] }>()
	return {
		getAll:               () => [ctx],
		getActive:            () => ctx,
		getForUri:            () => ctx,
		initializeAll:        async () => [ctx],
		dispose:              () => folderEmitter.dispose(),
		onDidChangeFolders:   folderEmitter.event,
	} as unknown as FolderRegistry
}

function makeFakeContext(api: GitBraidApi): FolderContext {
	return {
		root: vscode.Uri.file('/tmp/fake'),
		api,
	} as unknown as FolderContext
}

suite('GitBraidApiFacade — delegate coverage smoke', () => {

	test('invokes every public delegate against the active folder API', async () => {
		const { api, calls } = makeFakeApi()
		const ctx = makeFakeContext(api)
		const registry = makeFakeRegistry(ctx)
		const facade = new GitBraidApiFacade(registry)

		// Synchronous getters
		assert.deepStrictEqual(facade.getStack(), [])
		assert.deepStrictEqual(facade.getVirtualBranches(), [])
		assert.deepStrictEqual(facade.getFloatingFiles(), [])
		assert.strictEqual(facade.getAssignment('src/a.ts'), undefined)
		assert.strictEqual(facade.getHunkAssignments('src/a.ts'), undefined)

		// Mutation methods — verify the call went through with the right args.
		await facade.addBranch('feat/a', 'main', { color: '#abc' })
		await facade.removeBranch('feat/a', true)
		await facade.materialiseBranch('feat/v')
		await facade.assignFile('src/a.ts', 'feat/a')
		await facade.assignHunk('src/a.ts', 2, 'feat/a')
		await facade.unassignFile('src/a.ts')
		await facade.getBranchStatus('feat/a')
		await facade.getStackStatus()
		await facade.commitBranch('feat/a', 'msg', { stageAll: true })
		await facade.stageBranch('feat/a', ['src/a.ts'])
		await facade.reorderStack(['feat/a', 'feat/b'])
		await facade.removeHunkAssignment('src/a.ts', 2)
		await facade.pullBranch('feat/a')
		await facade.syncBranch('feat/a')
		await facade.rebaseBranch('feat/a')
		const routed = await facade.routeHunks('src/a.ts')
		assert.deepStrictEqual(routed, { routed: 0, skipped: 0 })

		// The events are plain getters; just touch them so coverage picks
		// them up without asserting on emission (no real subscribers).
		void facade.onDidChangeAssignment
		void facade.onDidChangeStack
		void facade.onDidSyncFile
		void facade.onDidFloatFile

		// Sanity-check a handful of the recorded calls so the test catches a
		// regression where the facade swaps arguments.
		const byName = new Map(calls.map((c) => [c.name, c.args]))
		assert.deepStrictEqual(byName.get('addBranch'), ['feat/a', 'main', { color: '#abc' }])
		assert.deepStrictEqual(byName.get('assignHunk'), ['src/a.ts', 2, 'feat/a'])
		assert.deepStrictEqual(byName.get('commitBranch'), ['feat/a', 'msg', { stageAll: true }])
		assert.deepStrictEqual(byName.get('reorderStack'), [['feat/a', 'feat/b']])

		// At least one call per delegate.
		const expectedDelegates = [
			'getStack', 'getVirtualBranches', 'getFloatingFiles', 'getAssignment',
			'getHunkAssignments', 'addBranch', 'removeBranch', 'materialiseBranch',
			'assignFile', 'assignHunk', 'unassignFile', 'getBranchStatus',
			'getStackStatus', 'commitBranch', 'stageBranch', 'reorderStack',
			'removeHunkAssignment', 'pullBranch', 'syncBranch', 'rebaseBranch',
			'routeHunks',
		]
		for (const name of expectedDelegates) {
			assert.ok(byName.has(name), `missing delegate call: ${name}`)
		}

		facade.dispose()
	})

	test('dispose is idempotent', () => {
		const { api } = makeFakeApi()
		const ctx = makeFakeContext(api)
		const registry = makeFakeRegistry(ctx)
		const facade = new GitBraidApiFacade(registry)
		facade.dispose()
		assert.doesNotThrow(() => facade.dispose())
	})
})
