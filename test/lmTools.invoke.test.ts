import * as assert from 'node:assert'
import * as vscode from 'vscode'
import { registerLmTools } from '../src/lmTools'
import type { GitBraidExportedAPI } from '../src/@types/GitBraidAPI'
import type { BranchStatus, StackStatus, AssignmentChangeEvent, StackChangeEvent, BranchStackEntry } from '../src/configTypes'

/**
 * These tests invoke each LM tool through the registered handle so the
 * coverage exercise actually exercises every tool's `invoke` and
 * `prepareInvocation` body, not just the constructor.
 */

interface ApiRecorder {
	api: GitBraidExportedAPI
	calls: string[]
	stack: BranchStackEntry[]
}

function makeRecorder(stack: BranchStackEntry[] = []): ApiRecorder {
	const calls: string[] = []
	const noopEvent = (_l: unknown) => ({ dispose: () => { /* */ } })
	const api: GitBraidExportedAPI = {
		getStack: () => stack,
		addBranch: async (name) => { calls.push(`addBranch:${name}`) },
		removeBranch: async () => { /* */ },
		getAssignment: () => undefined,
		assignFile: async (rel, branch) => { calls.push(`assignFile:${rel}:${branch}`) },
		assignHunk: async (rel, idx, branch) => { calls.push(`assignHunk:${rel}:${String(idx)}:${branch}`) },
		unassignFile: async () => { /* */ },
		getFloatingFiles: () => ['src/foo.ts', 'src/bar.ts'],
		getBranchStatus: async (branch) => ({ branch, staged: 0, unstaged: 0, untracked: 0, floating: 0 } as BranchStatus),
		getStackStatus: async () => ({ branches: [], totalFloating: 0 } as StackStatus),
		commitBranch: async (branch, msg) => { calls.push(`commit:${branch}:${msg}`) },
		stageBranch: async () => { /* */ },
		pullBranch: async (branch) => { calls.push(`pull:${branch}`) },
		syncBranch: async (branch) => { calls.push(`sync:${branch}`) },
		reorderStack: async () => { /* */ },
		getHunkAssignments: () => undefined,
		removeHunkAssignment: async () => { /* */ },
		rebaseBranch: async () => { /* */ },
		routeHunks: async () => ({ routed: 0, skipped: 0 }),
		onDidChangeAssignment: noopEvent as unknown as vscode.Event<AssignmentChangeEvent>,
		onDidChangeStack: noopEvent as unknown as vscode.Event<StackChangeEvent>,
		onDidSyncFile: noopEvent as unknown as vscode.Event<{ relativePath: string, branch: string }>,
		onDidFloatFile: noopEvent as unknown as vscode.Event<{ relativePath: string }>,
	}
	return { api, calls, stack }
}

async function invokeTool(name: string, input: unknown): Promise<vscode.LanguageModelToolResult> {
	return vscode.lm.invokeTool(name, {
		input,
		toolInvocationToken: undefined,
	})
}

function pickText(result: vscode.LanguageModelToolResult): string {
	for (const part of result.content as unknown as Array<{ value?: string }>) {
		if (typeof part.value === 'string') return part.value
	}
	return ''
}

suite('lmTools — invocation paths', function () {
	this.timeout(10_000)

	let disposables: vscode.Disposable[] = []
	let recorder: ApiRecorder

	teardown(() => {
		for (const d of disposables) d.dispose()
		disposables = []
	})

	test('gitbraid_getStack: returns JSON of stack', async () => {
		recorder = makeRecorder([{ name: 'feat/a', base: 'main', order: 1, color: '#fff' }])
		disposables = registerLmTools(recorder.api)
		const result = await invokeTool('gitbraid_getStack', {})
		const text = pickText(result)
		assert.ok(text.includes('feat/a'))
	})

	test('gitbraid_assignFile: forwards to api.assignFile', async () => {
		recorder = makeRecorder()
		disposables = registerLmTools(recorder.api)
		await invokeTool('gitbraid_assignFile', { relativePath: 'src/x.ts', branch: 'feat/a' })
		assert.ok(recorder.calls.includes('assignFile:src/x.ts:feat/a'))
	})

	test('gitbraid_assignHunk: forwards to api.assignHunk', async () => {
		recorder = makeRecorder()
		disposables = registerLmTools(recorder.api)
		await invokeTool('gitbraid_assignHunk', { relativePath: 'src/x.ts', hunkIndex: 2, branch: 'feat/a' })
		assert.ok(recorder.calls.includes('assignHunk:src/x.ts:2:feat/a'))
	})

	test('gitbraid_getFloatingFiles: returns "no" message when empty, JSON otherwise', async () => {
		recorder = makeRecorder()
		recorder.api.getFloatingFiles = () => []
		disposables = registerLmTools(recorder.api)
		const r1 = await invokeTool('gitbraid_getFloatingFiles', {})
		assert.ok(pickText(r1).toLowerCase().includes('no floating'))

		// Restore some files and re-register
		for (const d of disposables) d.dispose()
		recorder = makeRecorder()
		disposables = registerLmTools(recorder.api)
		const r2 = await invokeTool('gitbraid_getFloatingFiles', {})
		assert.ok(pickText(r2).includes('src/foo.ts'))
	})

	test('gitbraid_commitBranch: forwards branch+message', async () => {
		recorder = makeRecorder()
		disposables = registerLmTools(recorder.api)
		await invokeTool('gitbraid_commitBranch', { branch: 'feat/a', message: 'wip' })
		assert.ok(recorder.calls.includes('commit:feat/a:wip'))
	})

	test('gitbraid_getBranchStatus: forwards branch arg', async () => {
		recorder = makeRecorder()
		disposables = registerLmTools(recorder.api)
		const r = await invokeTool('gitbraid_getBranchStatus', { branch: 'feat/a' })
		assert.ok(pickText(r).includes('"branch": "feat/a"'))
	})

	test('gitbraid_addBranch: forwards to api.addBranch', async () => {
		recorder = makeRecorder()
		disposables = registerLmTools(recorder.api)
		await invokeTool('gitbraid_addBranch', { name: 'feat/new', base: 'main' })
		assert.ok(recorder.calls.includes('addBranch:feat/new'))
	})

	test('gitbraid_getStackDiagram: empty stack → "Stack is empty"', async () => {
		recorder = makeRecorder()
		disposables = registerLmTools(recorder.api)
		const r = await invokeTool('gitbraid_getStackDiagram', {})
		assert.ok(pickText(r).toLowerCase().includes('empty'))
	})

	test('gitbraid_getStackDiagram: renders ASCII tree of nested stack', async () => {
		recorder = makeRecorder([
			{ name: 'feat/a', base: 'main', order: 1, color: '#fff' },
			{ name: 'feat/b', base: 'feat/a', order: 2, color: '#fff' },
			{ name: 'feat/c', base: 'feat/a', order: 3, color: '#fff' },
		])
		disposables = registerLmTools(recorder.api)
		const r = await invokeTool('gitbraid_getStackDiagram', {})
		const text = pickText(r)
		assert.ok(text.startsWith('main'))
		assert.ok(text.includes('feat/a'))
		assert.ok(text.includes('feat/b'))
		assert.ok(text.includes('feat/c'))
		// Tree drawing characters present
		assert.ok(/[├└]/.test(text))
	})

	test('gitbraid_assignGlob: returns "no files matched" when nothing matches', async () => {
		recorder = makeRecorder()
		disposables = registerLmTools(recorder.api)
		const r = await invokeTool('gitbraid_assignGlob', { pattern: '**/__definitely_no_match_*.does_not_exist', branch: 'feat/a' })
		assert.ok(pickText(r).toLowerCase().includes('no files matched'))
	})
})
