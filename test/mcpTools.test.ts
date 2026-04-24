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
})
