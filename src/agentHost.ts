import * as vscode from 'vscode'
import { log } from './channelLogger'
import { ToolInputError } from './agentToolRegistry'
import type { AgentTool, AgentToolContext, ToolSurface } from './agentToolRegistry'
import type { GitBraidExportedAPI } from './@types/GitBraidAPI'
import { describeError } from './stackInvariants'

/** What an agent's tool call must not search or assign. */
const FIND_EXCLUDE = '{.worktrees/**,.git/**,node_modules/**}'

/** Build the context a tool runs with, reading the settings live so changes apply without a reload. */
export function createAgentContext(caller: ToolSurface): AgentToolContext {
	const cfg = vscode.workspace.getConfiguration('gitbraid')
	return {
		caller,
		allowForce: cfg.get<boolean>('agentAllowForce', false),
		maxDiffBytes: Math.max(1_000, cfg.get<number>('agentMaxDiffBytes', 200_000)),
		findFiles: async (pattern) => {
			const uris = await vscode.workspace.findFiles(pattern, FIND_EXCLUDE)
			return uris.map((u) => vscode.workspace.asRelativePath(u, false))
		},
	}
}

/**
 * Run a tool, leaving a one-line trail in the GitBraid output channel for
 * anything that changes state.  The trail is how a user finds out what an
 * agent did to their stack.
 */
export async function runTool(
	tool: AgentTool,
	api: GitBraidExportedAPI,
	rawInput: unknown,
	caller: ToolSurface,
): Promise<string> {
	const ctx = createAgentContext(caller)
	if (tool.kind === 'write') {
		log.info(`[${caller}] ${tool.name} ${JSON.stringify(rawInput ?? {}).slice(0, 300)}`)
	}
	try {
		return await tool.run(api, rawInput, ctx)
	} catch (e) {
		if (tool.kind === 'write') {
			log.warn(`[${caller}] ${tool.name} failed: ${describeError(e).message}`)
		}
		throw e
	}
}

/** A failure as text a model can act on: the code, what was wrong, and the fix. */
export function formatToolError(e: unknown): string {
	if (e instanceof ToolInputError) return e.message
	const d = describeError(e)
	if (d.code === 'ERROR') return String(e)
	return `${d.code}: ${d.message}${d.hint ? ` Hint: ${d.hint}` : ''}`
}
