import * as vscode from 'vscode'
import { log } from './channelLogger'
import type { GitBraidExportedAPI } from './@types/GitBraidAPI'
import { lmToolName, toolsFor } from './agentToolRegistry'
import type { AgentTool } from './agentToolRegistry'
import { formatToolError, runTool } from './agentHost'

type GitBraidApi = GitBraidExportedAPI

/**
 * One VS Code chat tool, driven by a registry entry (see `agentToolRegistry.ts`).
 * The tool's name, description and input schema are declared in `package.json`
 * under `languageModelTools`; a test keeps those in step with the registry.
 */
class RegistryLmTool implements vscode.LanguageModelTool<unknown> {

	readonly name: string

	constructor(
		private readonly _tool: AgentTool,
		private readonly _api: GitBraidApi,
	) {
		this.name = lmToolName(_tool)
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<unknown>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const text = await runTool(this._tool, this._api, options.input, 'lm')
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)])
		} catch (e) {
			// A thrown error is how a chat tool reports failure to the model; give it
			// the code and the hint, not just a message.
			throw new Error(formatToolError(e))
		}
	}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<unknown>,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		let invocationMessage: string
		let confirmation: { title: string, message: string } | undefined
		try {
			invocationMessage = this._tool.progress(options.input)
			confirmation = this._tool.confirm?.(options.input)
		} catch {
			// Invalid input is reported when the tool runs; do not fail the prepare step.
			return { invocationMessage: `Running ${this._tool.name}…` }
		}
		return {
			invocationMessage,
			...(confirmation
				? {
					confirmationMessages: {
						title: confirmation.title,
						message: new vscode.MarkdownString(confirmation.message),
					},
				}
				: {}),
		}
	}
}

/**
 * Registers every registry tool offered to chat with VS Code.
 * Returns disposables that unregister the tools when disposed.
 */
export function registerLmTools(api: GitBraidApi): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = []
	for (const def of toolsFor('lm')) {
		const tool = new RegistryLmTool(def, api)
		try {
			disposables.push(vscode.lm.registerTool(tool.name, tool))
			log.info(`LmTools: registered tool "${tool.name}"`)
		} catch (e: unknown) {
			// Not contributed in package.json, or vscode.lm is unavailable (older VS Code).
			log.warn(`LmTools: could not register "${tool.name}": ${e instanceof Error ? e.message : JSON.stringify(e)}`)
		}
	}
	return disposables
}
