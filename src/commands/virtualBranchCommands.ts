import * as vscode from 'vscode'
import * as path from 'node:path'
import { log } from '../channelLogger'
import { git } from '../gitFunctions'
import { BranchNode, VirtualBranchNode } from '../branchStackTreeProvider'
import { withErrorHandler } from '../errorSurfacer'
import type { CommandDeps } from './types'

const cmd = withErrorHandler

/** Same default-branch detection used by `gitbraid.addStackBranch`. */
async function detectDefaultBranch(workspaceUri: vscode.Uri): Promise<string> {
	try {
		const symbolic = await git.defaultBranch()
		if (symbolic) return symbolic
	} catch { /* fall through */ }
	try {
		const cur = await git.branch(workspaceUri)
		if (cur) return cur
	} catch { /* fall through */ }
	return 'main'
}

/** Resolve a branch name from either a tree-view node argument or a QuickPick. */
async function resolveVirtualBranchName(
	arg: unknown,
	placeholder: string,
	ctx: import('../folderContext').FolderContext,
): Promise<string | undefined> {
	const node = arg instanceof BranchNode || arg instanceof VirtualBranchNode ? arg : undefined
	if (node) return node.entry.name
	const virtuals = ctx.config.getStack().filter((e) => e.virtual === true).map((e) => e.name)
	if (virtuals.length === 0) {
		await vscode.window.showInformationMessage('No virtual branches in the current stack.')
		return undefined
	}
	if (virtuals.length === 1) return virtuals[0]
	return vscode.window.showQuickPick(virtuals, { placeHolder: placeholder })
}

export function registerVirtualBranchCommands(deps: CommandDeps): vscode.Disposable[] {
	const { activeContext } = deps

	return [
		// ─── Add a virtual branch ─────────────────────────────────────────────
		vscode.commands.registerCommand('gitbraid.addVirtualBranch', cmd(async () => {
			const ctx = activeContext()
			const existing = new Set(ctx.config.getStack().map((e) => e.name))

			const name = await vscode.window.showInputBox({
				prompt: 'Virtual branch name',
				placeHolder: 'feature/idea-a',
				validateInput: (v) => {
					const trimmed = v.trim()
					if (!trimmed) return 'Branch name is required'
					if (existing.has(trimmed)) return `"${trimmed}" already exists in the stack`
					return null
				},
			})
			if (!name) return

			const stack = ctx.config.getStack()
			const defaultBranch = await detectDefaultBranch(ctx.root).catch(() => 'main')
			const bases = [defaultBranch, ...stack.map((e) => e.name).filter((n) => n !== defaultBranch)]
			const basePick = await vscode.window.showQuickPick(bases, {
				placeHolder: 'Base branch for the virtual branch (used when it is materialised)',
			})
			if (!basePick) return

			await ctx.branchStack.addBranchToStack(name.trim(), basePick, '#6C8EBF', { virtual: true })
			await vscode.window.showInformationMessage(
				`Virtual branch "${name.trim()}" added to stack in ${path.basename(ctx.root.fsPath)}. ` +
				'Assign files to it; they will be captured in memory until you materialise the branch.',
			)
		})),

		// ─── Materialise a virtual branch ─────────────────────────────────────
		vscode.commands.registerCommand('gitbraid.materialiseVirtualBranch', cmd(async (arg?: unknown) => {
			const ctx = activeContext()
			const name = typeof arg === 'string'
				? arg
				: await resolveVirtualBranchName(arg, 'Materialise which virtual branch?', ctx)
			if (!name) return

			const entry = ctx.config.getBranch(name)
			if (!entry || entry.virtual !== true) {
				await vscode.window.showErrorMessage(`"${name}" is not a virtual branch.`)
				return
			}

			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `GitBraid: materialising "${name}"…`, cancellable: false },
				async () => {
					await ctx.branchStack.materialiseBranch(name)
				},
			)

			await vscode.window.showInformationMessage(
				`GitBraid: materialised "${name}". Commit via the Source Control panel when ready.`,
			)
		})),

		// ─── Discard a virtual branch ─────────────────────────────────────────
		vscode.commands.registerCommand('gitbraid.discardVirtualBranch', cmd(async (arg?: unknown) => {
			const ctx = activeContext()
			const name = typeof arg === 'string'
				? arg
				: await resolveVirtualBranchName(arg, 'Discard which virtual branch?', ctx)
			if (!name) return

			const entry = ctx.config.getBranch(name)
			if (!entry || entry.virtual !== true) {
				await vscode.window.showErrorMessage(`"${name}" is not a virtual branch.`)
				return
			}

			const fileCount = ctx.virtualStore.listFiles(name).length
			const confirm = await vscode.window.showWarningMessage(
				fileCount > 0
					? `Discard virtual branch "${name}"? ${String(fileCount)} file snapshot(s) in the virtual store will be lost.`
					: `Discard virtual branch "${name}"?`,
				{ modal: true },
				'Discard',
			)
			if (confirm !== 'Discard') return

			await ctx.branchStack.removeBranchFromStack(name, true)
			log.info(`gitbraid.discardVirtualBranch: removed "${name}" with ${String(fileCount)} stored file(s)`)
			await vscode.window.showInformationMessage(`Virtual branch "${name}" discarded.`)
		})),
	]
}
