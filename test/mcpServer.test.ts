import * as assert from 'node:assert'
import * as net from 'node:net'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { GitBraidMcpServer } from '../src/mcpServer'
import type { GitBraidExportedAPI } from '../src/@types/GitBraidAPI'
import type { BranchStackEntry, BranchStatus, StackStatus, AssignmentChangeEvent, StackChangeEvent } from '../src/configTypes'
import type * as vscode from 'vscode'

// ─── Minimal stub API ─────────────────────────────────────────────────────────

function stubApi(): GitBraidExportedAPI {
	const noop = async () => { /* no-op */ }
	const noopEvent = (_listener: unknown) => ({ dispose: () => { /* */ } })
	return {
		getStack: () => [] as BranchStackEntry[],
		addBranch: noop,
		removeBranch: noop,
		getAssignment: () => undefined,
		assignFile: noop,
		assignHunk: noop,
		unassignFile: noop,
		getFloatingFiles: () => [],
		getBranchStatus: async () => ({ branch: '', staged: 0, unstaged: 0, untracked: 0, floating: 0 } as BranchStatus),
		getStackStatus: async () => ({ branches: [], totalFloating: 0 } as StackStatus),
		commitBranch: noop,
		stageBranch: noop,
		pullBranch: noop,
		syncBranch: noop,
		reorderStack: noop,
		getHunkAssignments: () => undefined,
		removeHunkAssignment: noop,
		rebaseBranch: noop,
		routeHunks: async () => ({ routed: 0, skipped: 0 }),
		onDidChangeAssignment: noopEvent as unknown as vscode.Event<AssignmentChangeEvent>,
		onDidChangeStack: noopEvent as unknown as vscode.Event<StackChangeEvent>,
		onDidSyncFile: noopEvent as unknown as vscode.Event<{ relativePath: string, branch: string }>,
		onDidFloatFile: noopEvent as unknown as vscode.Event<{ relativePath: string }>,
	}
}

// ─── Helper to read endpoint file ─────────────────────────────────────────────

const ENDPOINT_FILE = path.join(os.homedir(), '.gitbraid', 'mcp-endpoint')

function readEndpoint(): { socket: string, token: string, pid: number } | null {
	try {
		return JSON.parse(fs.readFileSync(ENDPOINT_FILE, 'utf8'))
	} catch {
		return null
	}
}

// ─── Tests ────────────────────────────────────────────────────────────────────

suite('GitBraidMcpServer', function () {
	this.timeout(10_000)

	let mcpSrv: GitBraidMcpServer

	setup(() => {
		mcpSrv = new GitBraidMcpServer(stubApi(), undefined)
	})

	teardown(async () => {
		await mcpSrv.stop()
	})

	test('isRunning is false before start()', () => {
		assert.strictEqual(mcpSrv.isRunning, false)
	})

	test('isRunning is true after start()', async () => {
		await mcpSrv.start()
		assert.strictEqual(mcpSrv.isRunning, true)
	})

	test('isRunning is false after stop()', async () => {
		await mcpSrv.start()
		await mcpSrv.stop()
		assert.strictEqual(mcpSrv.isRunning, false)
	})

	test('stop() after stop() is a no-op', async () => {
		await mcpSrv.start()
		await mcpSrv.stop()
		await assert.doesNotReject(() => mcpSrv.stop())
	})

	test('writes endpoint file on start()', async () => {
		await mcpSrv.start()
		const record = readEndpoint()
		assert.ok(record, 'endpoint file should exist')
		assert.strictEqual(record!.pid, process.pid)
		assert.match(record!.token, /^[0-9a-f]{64}$/)
	})

	test('deletes endpoint file on stop()', async () => {
		await mcpSrv.start()
		await mcpSrv.stop()
		assert.strictEqual(readEndpoint(), null)
	})

	test('second start() while already running is a no-op', async () => {
		await mcpSrv.start()
		const endpointBefore = readEndpoint()
		await mcpSrv.start()
		const endpointAfter = readEndpoint()
		assert.strictEqual(endpointBefore!.token, endpointAfter!.token)
	})

	test('rejects connection with wrong token', async () => {
		await mcpSrv.start()
		const { socket: sockPath } = readEndpoint()!

		const result = await new Promise<'closed' | 'data'>((resolve) => {
			const client = net.createConnection(sockPath, () => {
				client.write('wrong-token\n')
			})
			client.once('close', () => resolve('closed'))
			client.once('data', () => resolve('data'))
			client.setTimeout(2000, () => { client.destroy(); resolve('closed') })
		})

		assert.strictEqual(result, 'closed', 'server should close the connection on bad token')
	})

	test('accepts connection with correct token', async () => {
		await mcpSrv.start()
		const { socket: sockPath, token } = readEndpoint()!

		const received: Buffer[] = []
		const result = await new Promise<string>((resolve, reject) => {
			const client = net.createConnection(sockPath, () => {
				client.write(`${token}\n`)
				// Send an MCP initialize request
				const init = JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'initialize',
					params: {
						protocolVersion: '2024-11-05',
						capabilities: {},
						clientInfo: { name: 'test', version: '0.0.0' },
					},
				}) + '\n'
				client.write(init)
			})
			client.on('data', (chunk: Buffer) => {
				received.push(chunk)
				const all = Buffer.concat(received).toString('utf8')
				if (all.includes('"result"') || all.includes('"error"')) {
					client.destroy()
					resolve(all)
				}
			})
			client.on('error', reject)
			client.setTimeout(4000, () => { client.destroy(); reject(new Error('timeout')) })
		})

		assert.ok(result.length > 0, 'should receive a response from the MCP server')
	})
})
