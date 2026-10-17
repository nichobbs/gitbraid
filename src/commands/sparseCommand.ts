import * as vscode from 'vscode'
import { withErrorHandler } from '../errorSurfacer'
import { BranchNode } from '../branchStackTreeProvider'
import { branchNameFromScmArg } from '../scmProviderId'
import type { CommandDeps } from './types'

const cmd = withErrorHandler

export function registerSparseCommand(deps: CommandDeps): vscode.Disposable[] {
	const { activeContext } = deps

	return [
		vscode.commands.registerCommand('gitbraid.setWorktreeSparse', cmd(async (arg?: unknown) => {
			const ctx = activeContext()
			let name = arg instanceof BranchNode ? arg.entry.name : branchNameFromScmArg(arg)
			if (!name) {
				const real = ctx.config.getStack().filter((e) => e.virtual !== true).map((e) => e.name)
				if (real.length === 0) {
					await vscode.window.showInformationMessage('No branches with a worktree in the current stack.')
					return
				}
				name = await vscode.window.showQuickPick(real, { placeHolder: 'Branch whose worktree to convert' })
				if (!name) return
			}
			const mode = await vscode.window.showQuickPick(
				[
					{ label: 'Sparse', description: 'Check out only the directories this branch owns', sparse: true },
					{ label: 'Full', description: 'Check out the whole tree', sparse: false },
				],
				{ placeHolder: `Worktree layout for "${name}"` },
			)
			if (!mode) return
			await ctx.branchStack.setWorktreeSparse(name, mode.sparse)
			await vscode.window.showInformationMessage(`GitBraid: "${name}" worktree is now ${mode.label.toLowerCase()}.`)
		})),
	]
}
