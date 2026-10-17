import * as vscode from 'vscode'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { GitBraidExportedAPI } from './@types/GitBraidAPI'
import type { StackContentProvider } from './stackContentProvider'
import { STACK_SCHEME } from './stackContentProvider'
import { toolsFor } from './agentToolRegistry'
import { runTool } from './agentHost'
import { describeError } from './stackInvariants'

type WriteGate = () => boolean

function writeDisabledError() {
	return {
		content: [{ type: 'text' as const, text: 'Write operations are disabled. Set gitbraid.mcpWriteEnabled to true to enable them.' }],
		isError: true,
	}
}

/**
 * A failure as an MCP tool error.  A refused operation carries its code and hint
 * as JSON (in both the text and `structuredContent`) so a client can branch on
 * the code; any other failure is reported as plain text, as it always was.
 */
function errorResult(e: unknown) {
	const d = describeError(e)
	if (d.code === 'ERROR') {
		return { content: [{ type: 'text' as const, text: String(e) }], isError: true }
	}
	return {
		content: [{ type: 'text' as const, text: JSON.stringify(d) }],
		structuredContent: d as unknown as Record<string, unknown>,
		isError: true,
	}
}

/**
 * Registers every registry tool offered over MCP, plus the stack-file resource.
 *
 * `writeGate` is called at invocation time; returning false makes write tools
 * return an error without executing.
 */
export function registerMcpTools(
	server: McpServer,
	api: GitBraidExportedAPI,
	stackContentProvider: StackContentProvider | undefined,
	writeGate: WriteGate,
): void {
	for (const tool of toolsFor('mcp')) {
		server.tool(tool.name, tool.description, tool.input, async (input: unknown) => {
			if (tool.kind === 'write' && !writeGate()) return writeDisabledError()
			try {
				return { content: [{ type: 'text' as const, text: await runTool(tool, api, input, 'mcp') }] }
			} catch (e) {
				return errorResult(e)
			}
		})
	}

	// ── Resources ─────────────────────────────────────────────────────────────

	if (stackContentProvider) {
		server.resource(
			'gitbraid-stack-file',
			new ResourceTemplate(`${STACK_SCHEME}://{relativePath}`, { list: undefined }),
			async (uri, { relativePath }) => {
				const rel = Array.isArray(relativePath) ? relativePath[0] : relativePath
				const vsUri = vscode.Uri.parse(`${STACK_SCHEME}:${rel}`)
				try {
					const content = await stackContentProvider.provideTextDocumentContent(vsUri)
					return {
						contents: [{
							uri: uri.href,
							mimeType: 'text/plain',
							text: content,
						}],
					}
				} catch (e) {
					return {
						contents: [{
							uri: uri.href,
							mimeType: 'text/plain',
							text: '',
						}],
					}
				}
			},
		)
	}
}
