import * as vscode from 'vscode'
import { log } from './channelLogger'
import type { MbcApi } from './mbcApi'

// ─── Tool result helpers ──────────────────────────────────────────────────────

function textResult(text: string): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)])
}

function jsonResult(value: unknown): vscode.LanguageModelToolResult {
	return textResult(JSON.stringify(value, null, 2))
}

// ─── Tool implementations ─────────────────────────────────────────────────────

class GetStackTool implements vscode.LanguageModelTool<Record<string, never>> {
	readonly name = 'mbc_getStack'

	constructor(private readonly _api: MbcApi) {}

	async invoke(
		_options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const stack = this._api.getStack()
		return jsonResult(stack)
	}

	prepareInvocation(
		_options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, never>>,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return { invocationMessage: 'Fetching branch stack…' }
	}
}

// ─── assignFile ───────────────────────────────────────────────────────────────

interface AssignFileInput {
	relativePath: string
	branch: string
}

class AssignFileTool implements vscode.LanguageModelTool<AssignFileInput> {
	readonly name = 'mbc_assignFile'

	constructor(private readonly _api: MbcApi) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<AssignFileInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const { relativePath, branch } = options.input
		await this._api.assignFile(relativePath, branch)
		return textResult(`Assigned "${relativePath}" to branch "${branch}".`)
	}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<AssignFileInput>,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const { relativePath, branch } = options.input
		return {
			invocationMessage: `Assigning "${relativePath}" to "${branch}"…`,
			confirmationMessages: {
				title: 'Assign File to Branch',
				message: new vscode.MarkdownString(
					`Assign \`${relativePath}\` to branch **${branch}**?`,
				),
			},
		}
	}
}

// ─── assignHunk ───────────────────────────────────────────────────────────────

interface AssignHunkInput {
	relativePath: string
	hunkIndex: number
	branch: string
}

class AssignHunkTool implements vscode.LanguageModelTool<AssignHunkInput> {
	readonly name = 'mbc_assignHunk'

	constructor(private readonly _api: MbcApi) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<AssignHunkInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const { relativePath, hunkIndex, branch } = options.input
		await this._api.assignHunk(relativePath, hunkIndex, branch)
		return textResult(`Assigned hunk ${String(hunkIndex)} in "${relativePath}" to branch "${branch}".`)
	}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<AssignHunkInput>,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const { relativePath, hunkIndex, branch } = options.input
		return {
			invocationMessage: `Assigning hunk ${String(hunkIndex)} in "${relativePath}" to "${branch}"…`,
			confirmationMessages: {
				title: 'Assign Hunk to Branch',
				message: new vscode.MarkdownString(
					`Assign hunk **${String(hunkIndex)}** in \`${relativePath}\` to branch **${branch}**?`,
				),
			},
		}
	}
}

// ─── getFloatingFiles ─────────────────────────────────────────────────────────

class GetFloatingFilesTool implements vscode.LanguageModelTool<Record<string, never>> {
	readonly name = 'mbc_getFloatingFiles'

	constructor(private readonly _api: MbcApi) {}

	async invoke(
		_options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const files = this._api.getFloatingFiles()
		if (files.length === 0) {
			return textResult('No floating (unassigned) files.')
		}
		return jsonResult(files)
	}

	prepareInvocation(
		_options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, never>>,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return { invocationMessage: 'Fetching floating files…' }
	}
}

// ─── commitBranch ─────────────────────────────────────────────────────────────

interface CommitBranchInput {
	branch: string
	message: string
}

class CommitBranchTool implements vscode.LanguageModelTool<CommitBranchInput> {
	readonly name = 'mbc_commitBranch'

	constructor(private readonly _api: MbcApi) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<CommitBranchInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const { branch, message } = options.input
		await this._api.commitBranch(branch, message, { stageAll: true })
		return textResult(`Committed to branch "${branch}" with message: "${message}".`)
	}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<CommitBranchInput>,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const { branch, message } = options.input
		return {
			invocationMessage: `Committing to "${branch}"…`,
			confirmationMessages: {
				title: 'Commit Branch',
				message: new vscode.MarkdownString(
					`Commit all staged changes to branch **${branch}** with message: "${message}"?`,
				),
			},
		}
	}
}

// ─── getBranchStatus ─────────────────────────────────────────────────────────

interface GetBranchStatusInput {
	branch: string
}

class GetBranchStatusTool implements vscode.LanguageModelTool<GetBranchStatusInput> {
	readonly name = 'mbc_getBranchStatus'

	constructor(private readonly _api: MbcApi) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<GetBranchStatusInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const status = await this._api.getBranchStatus(options.input.branch)
		return jsonResult(status)
	}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<GetBranchStatusInput>,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return { invocationMessage: `Fetching status for "${options.input.branch}"…` }
	}
}

// ─── addBranch ────────────────────────────────────────────────────────────────

interface AddBranchInput {
	name: string
	base: string
	color?: string
}

class AddBranchTool implements vscode.LanguageModelTool<AddBranchInput> {
	readonly name = 'mbc_addBranch'

	constructor(private readonly _api: MbcApi) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<AddBranchInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const { name, base, color } = options.input
		await this._api.addBranch(name, base, { color })
		return textResult(`Branch "${name}" added to the stack (base: "${base}").`)
	}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<AddBranchInput>,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const { name, base } = options.input
		return {
			invocationMessage: `Adding branch "${name}" to stack…`,
			confirmationMessages: {
				title: 'Add Branch to Stack',
				message: new vscode.MarkdownString(
					`Create branch **${name}** based on **${base}** and add it to the stack?`,
				),
			},
		}
	}
}

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Registers all MBC language model tools with VS Code.
 * Returns disposables that unregister the tools when disposed.
 */
export function registerLmTools(api: MbcApi): vscode.Disposable[] {
	const tools: Array<vscode.LanguageModelTool<never>> = [
		new GetStackTool(api) as unknown as vscode.LanguageModelTool<never>,
		new AssignFileTool(api) as unknown as vscode.LanguageModelTool<never>,
		new AssignHunkTool(api) as unknown as vscode.LanguageModelTool<never>,
		new GetFloatingFilesTool(api) as unknown as vscode.LanguageModelTool<never>,
		new CommitBranchTool(api) as unknown as vscode.LanguageModelTool<never>,
		new GetBranchStatusTool(api) as unknown as vscode.LanguageModelTool<never>,
		new AddBranchTool(api) as unknown as vscode.LanguageModelTool<never>,
	]

	const disposables: vscode.Disposable[] = []
	for (const tool of tools) {
		try {
			const d = vscode.lm.registerTool(tool.name, tool)
			disposables.push(d)
			log.info(`LmTools: registered tool "${tool.name}"`)
		} catch (e: unknown) {
			// vscode.lm may not be available in older VS Code versions
			log.warn(`LmTools: could not register "${tool.name}": ${JSON.stringify(e)}`)
		}
	}
	return disposables
}
