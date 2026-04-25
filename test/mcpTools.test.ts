import * as assert from 'node:assert'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { registerMcpTools } from '../src/mcpTools'
import type { GitBraidExportedAPI } from '../src/@types/GitBraidAPI'
import type { BranchStackEntry, BranchStatus, StackStatus, AssignmentChangeEvent, StackChangeEvent } from '../src/configTypes'
import type * as vscode from 'vscode'

// ─── Stub API ─────────────────────────────────────────────────────────────────

interface StubApiState {
	stack: BranchStackEntry[]
	addBranchCalled: boolean
	assignFileCalled: boolean
	rebaseBranchCalled: boolean
	routeHunksResult: { routed: number, skipped: number }
}

function makeStubApi(state: StubApiState): GitBraidExportedAPI {
	const noop = async () => { /* no-op */ }
	const noopEvent = (_listener: unknown) => ({ dispose: () => { /* */ } })
	return {
		getStack: () => state.stack,
		addBranch: async () => { state.addBranchCalled = true },
		removeBranch: noop,
		getAssignment: () => undefined,
		assignFile: async () => { state.assignFileCalled = true },
		assignHunk: noop,
		unassignFile: noop,
		getFloatingFiles: () => ['src/foo.ts'],
		getBranchStatus: async (branch) => ({ branch, staged: 1, unstaged: 0, untracked: 0, floating: 0 } as BranchStatus),
		getStackStatus: async () => ({ branches: [], totalFloating: 0 } as StackStatus),
		commitBranch: noop,
		stageBranch: noop,
		pullBranch: noop,
		syncBranch: noop,
		reorderStack: noop,
		getHunkAssignments: () => undefined,
		removeHunkAssignment: noop,
		rebaseBranch: async () => { state.rebaseBranchCalled = true },
		routeHunks: async () => state.routeHunksResult,
		onDidChangeAssignment: noopEvent as unknown as vscode.Event<AssignmentChangeEvent>,
		onDidChangeStack: noopEvent as unknown as vscode.Event<StackChangeEvent>,
		onDidSyncFile: noopEvent as unknown as vscode.Event<{ relativePath: string, branch: string }>,
		onDidFloatFile: noopEvent as unknown as vscode.Event<{ relativePath: string }>,
	}
}

// ─── Pair helper ──────────────────────────────────────────────────────────────

async function makeClientServerPair(
	api: GitBraidExportedAPI,
	writeEnabled: boolean,
): Promise<{ client: Client, cleanup: () => Promise<void> }> {
	const server = new McpServer({ name: 'test', version: '0.0.0' })
	registerMcpTools(server, api, undefined, () => writeEnabled)

	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

	const client = new Client({ name: 'test-client', version: '0.0.0' })
	await Promise.all([
		client.connect(clientTransport),
		server.connect(serverTransport),
	])

	const cleanup = async () => {
		await client.close()
		await server.close()
	}

	return { client, cleanup }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

suite('mcpTools', function () {
	this.timeout(10_000)

	// ── Read tools ─────────────────────────────────────────────────────────────

	test('getStack returns JSON of stack', async () => {
		const state: StubApiState = {
			stack: [{ name: 'feature/a', base: 'main', order: 1, color: '#fff' }],
			addBranchCalled: false,
			assignFileCalled: false,
			rebaseBranchCalled: false,
			routeHunksResult: { routed: 0, skipped: 0 },
		}
		const { client, cleanup } = await makeClientServerPair(makeStubApi(state), false)
		try {
			const result = await client.callTool({ name: 'getStack', arguments: {} })
			const text = (result.content as Array<{ type: string, text: string }>)[0].text
			const parsed = JSON.parse(text) as BranchStackEntry[]
			assert.strictEqual(parsed.length, 1)
			assert.strictEqual(parsed[0].name, 'feature/a')
		} finally {
			await cleanup()
		}
	})

	test('getFloatingFiles returns list when files exist', async () => {
		const state: StubApiState = {
			stack: [],
			addBranchCalled: false,
			assignFileCalled: false,
			rebaseBranchCalled: false,
			routeHunksResult: { routed: 0, skipped: 0 },
		}
		const { client, cleanup } = await makeClientServerPair(makeStubApi(state), false)
		try {
			const result = await client.callTool({ name: 'getFloatingFiles', arguments: {} })
			const text = (result.content as Array<{ type: string, text: string }>)[0].text
			assert.ok(text.includes('src/foo.ts'))
		} finally {
			await cleanup()
		}
	})

	// ── Write-gate ─────────────────────────────────────────────────────────────

	test('addBranch is blocked when writeEnabled=false', async () => {
		const state: StubApiState = {
			stack: [],
			addBranchCalled: false,
			assignFileCalled: false,
			rebaseBranchCalled: false,
			routeHunksResult: { routed: 0, skipped: 0 },
		}
		const { client, cleanup } = await makeClientServerPair(makeStubApi(state), false)
		try {
			const result = await client.callTool({
				name: 'addBranch',
				arguments: { name: 'feat', base: 'main' },
			})
			assert.strictEqual((result as { isError?: boolean }).isError, true)
			assert.strictEqual(state.addBranchCalled, false)
		} finally {
			await cleanup()
		}
	})

	test('addBranch succeeds when writeEnabled=true', async () => {
		const state: StubApiState = {
			stack: [],
			addBranchCalled: false,
			assignFileCalled: false,
			rebaseBranchCalled: false,
			routeHunksResult: { routed: 0, skipped: 0 },
		}
		const { client, cleanup } = await makeClientServerPair(makeStubApi(state), true)
		try {
			const result = await client.callTool({
				name: 'addBranch',
				arguments: { name: 'feat', base: 'main' },
			})
			assert.strictEqual((result as { isError?: boolean }).isError, undefined)
			assert.strictEqual(state.addBranchCalled, true)
		} finally {
			await cleanup()
		}
	})

	test('rebaseBranch is blocked when writeEnabled=false', async () => {
		const state: StubApiState = {
			stack: [],
			addBranchCalled: false,
			assignFileCalled: false,
			rebaseBranchCalled: false,
			routeHunksResult: { routed: 0, skipped: 0 },
		}
		const { client, cleanup } = await makeClientServerPair(makeStubApi(state), false)
		try {
			const result = await client.callTool({ name: 'rebaseBranch', arguments: { branch: 'feat' } })
			assert.strictEqual((result as { isError?: boolean }).isError, true)
			assert.strictEqual(state.rebaseBranchCalled, false)
		} finally {
			await cleanup()
		}
	})

	test('routeHunks reports routed count', async () => {
		const state: StubApiState = {
			stack: [],
			addBranchCalled: false,
			assignFileCalled: false,
			rebaseBranchCalled: false,
			routeHunksResult: { routed: 3, skipped: 0 },
		}
		const { client, cleanup } = await makeClientServerPair(makeStubApi(state), true)
		try {
			const result = await client.callTool({
				name: 'routeHunks',
				arguments: { relativePath: 'src/foo.ts' },
			})
			const text = (result.content as Array<{ type: string, text: string }>)[0].text
			assert.ok(text.includes('3'), 'should mention 3 routed hunks')
		} finally {
			await cleanup()
		}
	})

	test('getBranchStatus returns JSON for the named branch', async () => {
		const state: StubApiState = {
			stack: [],
			addBranchCalled: false,
			assignFileCalled: false,
			rebaseBranchCalled: false,
			routeHunksResult: { routed: 0, skipped: 0 },
		}
		const { client, cleanup } = await makeClientServerPair(makeStubApi(state), false)
		try {
			const result = await client.callTool({ name: 'getBranchStatus', arguments: { branch: 'feat/a' } })
			const text = (result.content as Array<{ type: string, text: string }>)[0].text
			assert.ok(text.includes('"branch": "feat/a"'))
		} finally {
			await cleanup()
		}
	})

	test('getStackStatus returns JSON', async () => {
		const state: StubApiState = {
			stack: [],
			addBranchCalled: false,
			assignFileCalled: false,
			rebaseBranchCalled: false,
			routeHunksResult: { routed: 0, skipped: 0 },
		}
		const { client, cleanup } = await makeClientServerPair(makeStubApi(state), false)
		try {
			const result = await client.callTool({ name: 'getStackStatus', arguments: {} })
			const text = (result.content as Array<{ type: string, text: string }>)[0].text
			assert.ok(text.includes('totalFloating'))
		} finally {
			await cleanup()
		}
	})

	test('getFloatingFiles: empty list emits "No floating files"', async () => {
		const state: StubApiState = {
			stack: [],
			addBranchCalled: false,
			assignFileCalled: false,
			rebaseBranchCalled: false,
			routeHunksResult: { routed: 0, skipped: 0 },
		}
		const api = makeStubApi(state)
		api.getFloatingFiles = () => []
		const { client, cleanup } = await makeClientServerPair(api, false)
		try {
			const result = await client.callTool({ name: 'getFloatingFiles', arguments: {} })
			const text = (result.content as Array<{ type: string, text: string }>)[0].text
			assert.ok(text.includes('No floating files'))
		} finally {
			await cleanup()
		}
	})

	// ── Write-gate coverage for every mutating tool ────────────────────────────

	const writeTools: Array<{ name: string, args: Record<string, unknown> }> = [
		{ name: 'addBranch', args: { name: 'f', base: 'main' } },
		{ name: 'removeBranch', args: { name: 'f' } },
		{ name: 'reorderStack', args: { orderedNames: ['f'] } },
		{ name: 'assignFile', args: { relativePath: 'a', branch: 'f' } },
		{ name: 'unassignFile', args: { relativePath: 'a' } },
		{ name: 'assignHunk', args: { relativePath: 'a', hunkIndex: 0, branch: 'f' } },
		{ name: 'removeHunkAssignment', args: { relativePath: 'a', hunkIndex: 0 } },
		{ name: 'routeHunks', args: { relativePath: 'a' } },
		{ name: 'commitBranch', args: { branch: 'f', message: 'm' } },
		{ name: 'rebaseBranch', args: { branch: 'f' } },
	]

	for (const { name, args } of writeTools) {
		test(`${name}: write-gate returns isError when disabled`, async () => {
			const state: StubApiState = {
				stack: [],
				addBranchCalled: false,
				assignFileCalled: false,
				rebaseBranchCalled: false,
				routeHunksResult: { routed: 0, skipped: 0 },
			}
			const { client, cleanup } = await makeClientServerPair(makeStubApi(state), false)
			try {
				const result = await client.callTool({ name, arguments: args })
				assert.strictEqual((result as { isError?: boolean }).isError, true, `${name} should be error-gated`)
			} finally {
				await cleanup()
			}
		})
	}

	test('assignFile, unassignFile, assignHunk, removeHunkAssignment: success path with writes enabled', async () => {
		const state: StubApiState = {
			stack: [],
			addBranchCalled: false,
			assignFileCalled: false,
			rebaseBranchCalled: false,
			routeHunksResult: { routed: 0, skipped: 0 },
		}
		const { client, cleanup } = await makeClientServerPair(makeStubApi(state), true)
		try {
			const r1 = await client.callTool({ name: 'assignFile', arguments: { relativePath: 'a', branch: 'f' } })
			assert.strictEqual((r1 as { isError?: boolean }).isError, undefined)
			assert.strictEqual(state.assignFileCalled, true)

			const r2 = await client.callTool({ name: 'unassignFile', arguments: { relativePath: 'a' } })
			assert.strictEqual((r2 as { isError?: boolean }).isError, undefined)

			const r3 = await client.callTool({ name: 'assignHunk', arguments: { relativePath: 'a', hunkIndex: 0, branch: 'f' } })
			assert.strictEqual((r3 as { isError?: boolean }).isError, undefined)

			const r4 = await client.callTool({ name: 'removeHunkAssignment', arguments: { relativePath: 'a', hunkIndex: 0 } })
			assert.strictEqual((r4 as { isError?: boolean }).isError, undefined)

			const r5 = await client.callTool({ name: 'commitBranch', arguments: { branch: 'f', message: 'wip' } })
			assert.strictEqual((r5 as { isError?: boolean }).isError, undefined)

			const r6 = await client.callTool({ name: 'rebaseBranch', arguments: { branch: 'f' } })
			assert.strictEqual((r6 as { isError?: boolean }).isError, undefined)
			assert.strictEqual(state.rebaseBranchCalled, true)

			const r7 = await client.callTool({ name: 'reorderStack', arguments: { orderedNames: ['feat/a'] } })
			assert.strictEqual((r7 as { isError?: boolean }).isError, undefined)

			const r8 = await client.callTool({ name: 'removeBranch', arguments: { name: 'feat/a' } })
			assert.strictEqual((r8 as { isError?: boolean }).isError, undefined)
		} finally {
			await cleanup()
		}
	})

	test('error in api propagates as isError', async () => {
		const state: StubApiState = {
			stack: [],
			addBranchCalled: false,
			assignFileCalled: false,
			rebaseBranchCalled: false,
			routeHunksResult: { routed: 0, skipped: 0 },
		}
		const api = makeStubApi(state)
		api.assignFile = async () => { throw new Error('write failed') }
		const { client, cleanup } = await makeClientServerPair(api, true)
		try {
			const result = await client.callTool({ name: 'assignFile', arguments: { relativePath: 'a', branch: 'f' } })
			assert.strictEqual((result as { isError?: boolean }).isError, true)
		} finally {
			await cleanup()
		}
	})

	test('getBranchStatus: error propagates as isError', async () => {
		const state: StubApiState = {
			stack: [],
			addBranchCalled: false,
			assignFileCalled: false,
			rebaseBranchCalled: false,
			routeHunksResult: { routed: 0, skipped: 0 },
		}
		const api = makeStubApi(state)
		api.getBranchStatus = async () => { throw new Error('boom') }
		const { client, cleanup } = await makeClientServerPair(api, false)
		try {
			const result = await client.callTool({ name: 'getBranchStatus', arguments: { branch: 'x' } })
			assert.strictEqual((result as { isError?: boolean }).isError, true)
		} finally {
			await cleanup()
		}
	})
})
