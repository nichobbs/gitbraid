import * as assert from 'node:assert'
import * as vscode from 'vscode'
import { z } from 'zod/v4'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { AGENT_TOOLS, ToolInputError, lmToolName, toolsFor } from '../src/agentToolRegistry'
import type { AgentTool, AgentToolContext, ToolSurface } from '../src/agentToolRegistry'
import { registerMcpTools } from '../src/mcpTools'
import { formatToolError } from '../src/agentHost'
import { StackInvariantError } from '../src/stackInvariants'
import { makeStubApi } from './helpers/stubApi'

/**
 * Plan 12: the registry is the single source of agent tools. These tests make
 * drift between it, the chat manifest and the MCP server a failing test rather
 * than a quiet bug (two chat tools used to be registered in code but missing
 * from the manifest, so they never worked).
 */

const ctx = (over: Partial<AgentToolContext> = {}): AgentToolContext => ({
	caller: 'mcp', allowForce: false, maxDiffBytes: 200_000, findFiles: async () => [], ...over,
})

function byName(name: string): AgentTool {
	const t = AGENT_TOOLS.find((x) => x.name === name)
	assert.ok(t, `no tool called ${name}`)
	return t
}

interface ManifestTool {
	name: string
	toolReferenceName: string
	inputSchema: { properties?: Record<string, { type?: string }>, required?: string[] }
}

function manifestTools(): ManifestTool[] {
	const ext = vscode.extensions.getExtension('nichobbs.gitbraid')
	assert.ok(ext, 'extension under test not found')
	return (ext.packageJSON as { contributes: { languageModelTools: ManifestTool[] } }).contributes.languageModelTools
}

suite('agentToolRegistry: structure', () => {
	test('names are unique and well formed', () => {
		const names = AGENT_TOOLS.map((t) => t.name)
		assert.strictEqual(new Set(names).size, names.length)
		for (const n of names) assert.match(n, /^[a-z][A-Za-z]+$/, n)
	})

	test('every tool is offered somewhere, and every omission has a stated reason', () => {
		const all: ToolSurface[] = ['mcp', 'lm']
		for (const t of AGENT_TOOLS) {
			assert.ok(t.surfaces.length > 0, `${t.name} is offered nowhere`)
			for (const s of all) {
				const offered = t.surfaces.includes(s)
				const reason = t.excluded?.[s]
				if (offered) assert.strictEqual(reason, undefined, `${t.name} is on ${s} but also has an exclusion reason`)
				else assert.ok(reason && reason.length > 10, `${t.name} is not on ${s} and says nothing about why`)
			}
		}
	})

	test('the two surfaces differ only where the registry says so', () => {
		const mcp = new Set(toolsFor('mcp').map((t) => t.name))
		const lm = new Set(toolsFor('lm').map((t) => t.name))
		const onlyMcp = [...mcp].filter((n) => !lm.has(n)).sort()
		const onlyLm = [...lm].filter((n) => !mcp.has(n)).sort()
		assert.deepStrictEqual(onlyMcp, ['reorderStack', 'rebaseBranch', 'removeBranch', 'removeHunkAssignment', 'routeHunks', 'unassignFile'].sort())
		assert.deepStrictEqual(onlyLm, ['pullBranch', 'syncBranch'])
	})
})

suite('agentToolRegistry: chat manifest', () => {
	test('the chat tools in package.json are exactly the registry\'s chat tools', () => {
		const contributed = manifestTools().map((t) => t.name).sort()
		const registered = toolsFor('lm').map(lmToolName).sort()
		assert.deepStrictEqual(contributed, registered)
	})

	test('each chat tool\'s toolReferenceName follows the convention', () => {
		for (const m of manifestTools()) {
			const base = m.name.replace('gitbraid_', '')
			assert.strictEqual(m.toolReferenceName, 'gitbraid' + base[0].toUpperCase() + base.slice(1), m.name)
		}
	})

	test('each chat tool\'s input schema matches the registry (properties, types, required)', () => {
		for (const def of toolsFor('lm')) {
			const manifest = manifestTools().find((m) => m.name === lmToolName(def))
			assert.ok(manifest, `${def.name} missing from the manifest`)
			const fromZod = z.toJSONSchema(z.object(def.input)) as { properties?: Record<string, { type?: string }>, required?: string[] }

			const zodProps = Object.keys(fromZod.properties ?? {}).sort()
			const manifestProps = Object.keys(manifest.inputSchema.properties ?? {}).sort()
			assert.deepStrictEqual(manifestProps, zodProps, `${def.name}: property names`)

			for (const p of zodProps) {
				assert.strictEqual(manifest.inputSchema.properties?.[p].type, fromZod.properties?.[p].type, `${def.name}.${p}: type`)
			}
			assert.deepStrictEqual([...(manifest.inputSchema.required ?? [])].sort(), [...(fromZod.required ?? [])].sort(), `${def.name}: required`)
		}
	})
})

suite('agentToolRegistry: MCP surface', function () {
	this.timeout(10_000)

	test('the MCP server lists exactly the registry\'s MCP tools', async () => {
		const server = new McpServer({ name: 'test', version: '0.0.0' })
		registerMcpTools(server, makeStubApi().api, undefined, () => true)
		const [clientT, serverT] = InMemoryTransport.createLinkedPair()
		const client = new Client({ name: 'c', version: '0.0.0' })
		await Promise.all([client.connect(clientT), server.connect(serverT)])
		try {
			const listed = (await client.listTools()).tools.map((t) => t.name).sort()
			assert.deepStrictEqual(listed, toolsFor('mcp').map((t) => t.name).sort())
		} finally {
			await client.close()
			await server.close()
		}
	})
})

suite('agentToolRegistry: MCP calls', function () {
	this.timeout(10_000)

	async function withClient<T>(api: ReturnType<typeof makeStubApi>['api'], fn: (c: Client) => Promise<T>): Promise<T> {
		const server = new McpServer({ name: 'test', version: '0.0.0' })
		registerMcpTools(server, api, undefined, () => true)
		const [clientT, serverT] = InMemoryTransport.createLinkedPair()
		const client = new Client({ name: 'c', version: '0.0.0' })
		await Promise.all([client.connect(clientT), server.connect(serverT)])
		try { return await fn(client) } finally { await client.close(); await server.close() }
	}

	test('removeBranch with force is refused by default, with the code and hint in the result', async () => {
		const s = makeStubApi()
		const res = await withClient(s.api, (c) => c.callTool({ name: 'removeBranch', arguments: { name: 'feat/a', force: true } }))
		assert.strictEqual(res.isError, true)
		const text = (res.content as { text: string }[]).map((x) => x.text).join('\n')
		assert.match(text, /FORCE_REQUIRES_CONFIRMATION/)
		assert.deepStrictEqual(s.calls, [])
	})

	test('a new read tool answers over MCP', async () => {
		const res = await withClient(makeStubApi().api, (c) => c.callTool({ name: 'getUndoLog', arguments: {} }))
		assert.ok(!res.isError)
	})
})

suite('agentToolRegistry: error text', () => {
	test('formatToolError carries the code and hint for invariant errors', () => {
		const e = new StackInvariantError('FORCE_REQUIRES_CONFIRMATION', 'nope', 'set agentAllowForce')
		const t = formatToolError(e)
		assert.match(t, /FORCE_REQUIRES_CONFIRMATION/)
		assert.match(t, /Hint: set agentAllowForce/)
	})
	test('formatToolError passes input errors through', () => {
		assert.match(formatToolError(new ToolInputError('x', [])), /Invalid input for x/)
	})
})

suite('agentToolRegistry: behaviour', () => {
	/** A valid sample input for every read tool, so a new read tool without one fails here. */
	const READ_SAMPLES: Record<string, unknown> = {
		getStack: {}, getStackDiagram: {}, getFloatingFiles: {}, getStackStatus: {}, getUndoLog: {},
		getBranchStatus: { branch: 'feat/a' },
		getFileOwnership: { relativePath: 'src/foo.ts' },
		getFileHunks: { relativePath: 'src/foo.ts', includePatch: true },
		getBranchDiff: { branch: 'feat/a', stat: true },
	}

	test('read tools never change anything (every mutating API method throws if reached)', async () => {
		const reads = AGENT_TOOLS.filter((t) => t.kind === 'read')
		assert.ok(reads.length >= 9)
		for (const t of reads) {
			assert.ok(t.name in READ_SAMPLES, `add a sample input for the new read tool "${t.name}"`)
			const { api } = makeStubApi({}, { trapMutations: true })
			await assert.doesNotReject(() => t.run(api, READ_SAMPLES[t.name], ctx()), t.name)
		}
	})

	test('read tools carry no confirmation prompt, write tools offered to chat mostly do', () => {
		for (const t of AGENT_TOOLS.filter((x) => x.kind === 'read')) assert.strictEqual(t.confirm, undefined, t.name)
		const writesInChat = toolsFor('lm').filter((t) => t.kind === 'write')
		assert.ok(writesInChat.length > 0)
		for (const t of writesInChat) assert.ok(t.confirm, `${t.name} runs in chat without asking`)
	})

	test('invalid input is reported field by field, not as a crash', async () => {
		const { api, calls } = makeStubApi()
		await assert.rejects(
			() => byName('assignHunk').run(api, { relativePath: 'a.ts', hunkIndex: 'two', branch: 'x' }, ctx()),
			(e: unknown) => e instanceof ToolInputError && /assignHunk/.test(e.message) && /hunkIndex/.test(e.message),
		)
		await assert.rejects(() => byName('commitBranch').run(api, { branch: 'x', message: '' }, ctx()), ToolInputError)
		await assert.rejects(() => byName('addBranch').run(api, { name: 'n', base: 'main', color: 'red' }, ctx()), /color/)
		assert.deepStrictEqual(calls, [], 'nothing reached the API')
	})

	test('removeBranch: force is refused for agents unless the setting allows it', async () => {
		const tool = byName('removeBranch')
		let s = makeStubApi()
		await assert.rejects(
			() => tool.run(s.api, { name: 'feat/a', force: true }, ctx({ allowForce: false })),
			(e: unknown) => e instanceof StackInvariantError && e.code === 'FORCE_REQUIRES_CONFIRMATION' && /agentAllowForce/.test(e.hint ?? ''),
		)
		assert.deepStrictEqual(s.calls, [], 'the API was not called')

		s = makeStubApi()
		await tool.run(s.api, { name: 'feat/a', force: true }, ctx({ allowForce: true }))
		assert.deepStrictEqual(s.calls, ['removeBranch:feat/a:true'])

		s = makeStubApi()
		await tool.run(s.api, { name: 'feat/a' }, ctx({ allowForce: false }))
		assert.deepStrictEqual(s.calls, ['removeBranch:feat/a:false'], 'a normal removal needs no permission')
	})

	test('assignGlob: assigns each match, or says nothing matched', async () => {
		const tool = byName('assignGlob')
		const none = makeStubApi()
		assert.match(await tool.run(none.api, { pattern: 'x/**', branch: 'feat/a' }, ctx()), /No files matched pattern "x\/\*\*"/)
		assert.deepStrictEqual(none.calls, [])

		const some = makeStubApi()
		const text = await tool.run(some.api, { pattern: 'src/**', branch: 'feat/a' }, ctx({ findFiles: async () => ['src/a.ts', 'src/b.ts'] }))
		assert.deepStrictEqual(some.calls, ['assignFile:src/a.ts:feat/a', 'assignFile:src/b.ts:feat/a'])
		assert.match(text, /Assigned 2 file\(s\)/)
	})

	test('getBranchDiff: header, no-change message and truncation notice', async () => {
		const tool = byName('getBranchDiff')
		const plain = await tool.run(makeStubApi().api, { branch: 'feat/a' }, ctx())
		assert.match(plain, /^# Diff of "feat\/a" against its fork point from "main"\n\+hello\n$/)

		const empty = await tool.run(makeStubApi({ getBranchDiff: async (b) => ({ branch: b, base: 'main', diff: '', truncated: false }) }).api, { branch: 'feat/a' }, ctx())
		assert.match(empty, /\(no changes\)/)

		const cut = await tool.run(
			makeStubApi({ getBranchDiff: async (b) => ({ branch: b, base: 'main', diff: '+x\n', truncated: true }) }).api,
			{ branch: 'feat/a' }, ctx({ maxDiffBytes: 5000 }),
		)
		assert.match(cut, /\[truncated at 5000 bytes/)
	})

	test('getBranchDiff passes the configured size cap to the API', async () => {
		let seen: number | undefined
		const { api } = makeStubApi({ getBranchDiff: async (b, o) => { seen = o?.maxBytes; return { branch: b, base: 'main', diff: '', truncated: false } } })
		await byName('getBranchDiff').run(api, { branch: 'feat/a' }, ctx({ maxDiffBytes: 1234 }))
		assert.strictEqual(seen, 1234)
	})

	test('getFileHunks and getUndoLog say so when there is nothing to show', async () => {
		assert.match(await byName('getFileHunks').run(makeStubApi({ getFileHunks: async () => [] }).api, { relativePath: 'a.ts' }, ctx()), /no uncommitted changes/)
		assert.match(await byName('getUndoLog').run(makeStubApi({ getUndoLog: async () => [] }).api, {}, ctx()), /empty/)
	})
})
