import * as net from 'node:net'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { PassThrough } from 'node:stream'
import * as vscode from 'vscode'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { log } from './channelLogger'
import { registerMcpTools } from './mcpTools'
import type { GitBraidExportedAPI } from './@types/GitBraidAPI'
import type { StackContentProvider } from './stackContentProvider'

// ─── Endpoint file ────────────────────────────────────────────────────────────

const ENDPOINT_DIR = path.join(os.homedir(), '.gitbraid')
const ENDPOINT_FILE = path.join(ENDPOINT_DIR, 'mcp-endpoint')

interface EndpointRecord {
	socket: string
	token: string
	pid: number
}

function writeEndpoint(record: EndpointRecord): void {
	try {
		fs.mkdirSync(ENDPOINT_DIR, { recursive: true })
		fs.writeFileSync(ENDPOINT_FILE, JSON.stringify(record, null, 2), 'utf8')
		// The endpoint file holds the plaintext auth token. Restrict it to the
		// owner so another local user on a shared host can't read the token
		// straight off disk and bypass the connection handshake entirely.
		// (No-op in effect on Windows, which doesn't use POSIX mode bits, but
		// harmless to call.)
		fs.chmodSync(ENDPOINT_FILE, 0o600)
	} catch (e) {
		log.warn(`McpServer: could not write endpoint file: ${e instanceof Error ? e.message : String(e)}`)
	}
}

function deleteEndpoint(): void {
	try {
		fs.unlinkSync(ENDPOINT_FILE)
	} catch {
		// ignored — may already be absent
	}
}

// ─── Socket path ──────────────────────────────────────────────────────────────

function socketPath(): string {
	if (process.platform === 'win32') {
		return `\\\\.\\pipe\\gitbraid-mcp-${String(process.pid)}`
	}
	return path.join(os.tmpdir(), `gitbraid-mcp-${String(process.pid)}.sock`)
}

function cleanupStaleSocket(sockPath: string): void {
	if (process.platform === 'win32') return
	try {
		fs.unlinkSync(sockPath)
	} catch {
		// No stale socket — fine
	}
}

// ─── McpServer ────────────────────────────────────────────────────────────────

/**
 * Manages a local Unix-socket / Windows named-pipe MCP server for GitBraid.
 *
 * Lifecycle:
 *  - start()  — creates socket, generates auth token, writes ~/.gitbraid/mcp-endpoint
 *  - stop()   — closes socket, removes endpoint file, token is invalidated
 *  - dispose() — calls stop()
 *
 * Auth:
 *  Every inbound TCP connection must send the session token as the very first
 *  line (`<token>\n`) before any MCP messages.  Non-matching connections are
 *  destroyed immediately.
 */
export class GitBraidMcpServer implements vscode.Disposable {
	private _server: net.Server | undefined
	private _token: string | undefined
	private _sockPath: string | undefined

	constructor(
		private _api: GitBraidExportedAPI,
		private readonly _stackContentProvider: StackContentProvider | undefined,
	) {}

	get isRunning(): boolean {
		return this._server?.listening ?? false
	}

	/** Update the API delegate without restarting the socket. */
	setApi(api: GitBraidExportedAPI): void {
		this._api = api
	}

	async start(): Promise<void> {
		if (this.isRunning) return

		if (!vscode.workspace.isTrusted) {
			await vscode.window.showWarningMessage(
				'GitBraid MCP server requires a trusted workspace.',
			)
			return
		}

		const sockPath = socketPath()
		cleanupStaleSocket(sockPath)

		const token = crypto.randomBytes(32).toString('hex')
		this._token = token
		this._sockPath = sockPath

		const server = net.createServer((socket) => {
			this._handleConnection(socket)
		})

		await new Promise<void>((resolve, reject) => {
			server.once('error', (err: NodeJS.ErrnoException) => {
				if (err.code === 'EADDRINUSE') {
					// Second try after cleanup
					cleanupStaleSocket(sockPath)
					server.listen(sockPath, resolve)
				} else {
					reject(err)
				}
			})
			server.listen(sockPath, resolve)
		})

		// Restrict the Unix domain socket to the owner. `net.Server.listen`
		// creates it with the process umask, which on some systems permits
		// other local users to connect — the token handshake still guards the
		// session, but the socket shouldn't be connectable at all from outside
		// this user. Named pipes on Windows don't use POSIX mode bits and
		// already default to an owner-restricted DACL, so this is POSIX-only.
		if (process.platform !== 'win32') {
			try {
				fs.chmodSync(sockPath, 0o600)
			} catch (e) {
				log.warn(`McpServer: could not chmod socket: ${e instanceof Error ? e.message : String(e)}`)
			}
		}

		this._server = server
		writeEndpoint({ socket: sockPath, token, pid: process.pid })
		log.info(`McpServer: listening on ${sockPath}`)

		const copyToken = 'Copy token'
		void vscode.window.showInformationMessage(
			`GitBraid MCP server started. Token: ${token}`,
			copyToken,
		).then((choice) => {
			if (choice === copyToken) {
				void vscode.env.clipboard.writeText(token)
			}
		})
	}

	async stop(): Promise<void> {
		if (!this._server) return
		const server = this._server
		this._server = undefined
		this._token = undefined

		if (this._sockPath && process.platform !== 'win32') {
			cleanupStaleSocket(this._sockPath)
		}
		this._sockPath = undefined
		deleteEndpoint()

		await new Promise<void>((resolve) => server.close(() => resolve()))
		log.info('McpServer: stopped')
	}

	dispose(): void {
		void this.stop()
	}

	// ── Connection handling ───────────────────────────────────────────────────

	private _handleConnection(socket: net.Socket): void {
		socket.once('error', (e) => log.warn(`McpServer: socket error: ${e.message}`))

		// Buffer incoming data until we have the first complete line (auth token).
		const chunks: Buffer[] = []
		const onData = (chunk: Buffer) => {
			chunks.push(chunk)
			const combined = Buffer.concat(chunks)
			const nlIdx = combined.indexOf('\n')
			if (nlIdx === -1) {
				if (combined.length > 256) {
					// No newline after 256 bytes — reject
					socket.off('data', onData)
					socket.destroy()
				}
				return
			}
			socket.off('data', onData)

			const firstLine = combined.slice(0, nlIdx).toString('utf8').trim()
			const remainder = combined.slice(nlIdx + 1)

			if (!this._token || firstLine !== this._token) {
				log.warn('McpServer: rejected connection — invalid token')
				socket.destroy()
				return
			}

			this._startMcpSession(socket, remainder)
		}
		socket.on('data', onData)
	}

	private _startMcpSession(socket: net.Socket, remainder: Buffer): void {
		const pass = new PassThrough()
		if (remainder.length > 0) {
			pass.write(remainder)
		}
		socket.pipe(pass)
		socket.once('close', () => pass.end())

		const transport = new StdioServerTransport(pass, socket)
		const sdkServer = new McpServer({ name: 'gitbraid', version: '0.1.0' })

		const writeEnabled = (): boolean =>
			vscode.workspace.getConfiguration('gitbraid').get<boolean>('mcpWriteEnabled', false)

		registerMcpTools(sdkServer, this._api, this._stackContentProvider, writeEnabled)

		void sdkServer.connect(transport).catch((e: unknown) => {
			log.warn(`McpServer: session error: ${e instanceof Error ? e.message : String(e)}`)
		})

		log.info('McpServer: MCP session started')
	}
}
