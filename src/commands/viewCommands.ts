import * as vscode from 'vscode'
import * as path from 'node:path'
import { log } from '../channelLogger'
import { BranchNode } from '../branchStackTreeProvider'
import { hideAssignedFile } from '../gitIndex'
import { getDefaultGitRunner } from '../gitRunner'
import { git } from '../gitFunctions'
import { withErrorHandler } from '../errorSurfacer'
import type { CommandDeps } from './types'

const cmd = withErrorHandler

export function registerViewCommands(deps: CommandDeps): vscode.Disposable[] {
	const {
		registry, primary, activeContext, stackTreeProvider, stackView,
		statusBar, prAwareness,
	} = deps

	return [
		vscode.commands.registerCommand('gitbraid.stackView.refresh', () => {
			void activeContext().config.reload().then(() => stackTreeProvider.refresh())
		}),

		vscode.commands.registerCommand('gitbraid.setBranchColor', cmd(async (arg?: BranchNode) => {
			const ctx = activeContext()
			const stack = ctx.config.getStack()
			let branchName: string | undefined

			if (arg instanceof BranchNode) {
				branchName = arg.entry.name
			} else {
				const picked = await vscode.window.showQuickPick(
					stack.map((e) => ({ label: e.name, description: e.color })),
					{ placeHolder: 'Select branch to recolour' },
				)
				branchName = picked?.label
			}

			if (!branchName) return

			const presets: Array<vscode.QuickPickItem & { color: string }> = [
				{ label: '$(circle-filled) Teal',    description: '#4ec9b0', color: '#4ec9b0' },
				{ label: '$(circle-filled) Blue',    description: '#2196F3', color: '#2196F3' },
				{ label: '$(circle-filled) Green',   description: '#4CAF50', color: '#4CAF50' },
				{ label: '$(circle-filled) Yellow',  description: '#f0d000', color: '#f0d000' },
				{ label: '$(circle-filled) Orange',  description: '#f5a623', color: '#f5a623' },
				{ label: '$(circle-filled) Red',     description: '#e06c75', color: '#e06c75' },
				{ label: '$(circle-filled) Purple',  description: '#c586c0', color: '#c586c0' },
				{ label: '$(circle-filled) Grey',    description: '#888888', color: '#888888' },
				{ label: '$(edit) Enter hex colour…', description: 'e.g. #a0c4ff', color: '' },
			]

			const selection = await vscode.window.showQuickPick(presets, {
				placeHolder: `Choose colour for "${branchName}"`,
			})
			if (!selection) return

			let color = selection.color
			if (color === '') {
				const input = await vscode.window.showInputBox({
					prompt: `Hex colour for "${branchName}"`,
					placeHolder: '#a0c4ff',
					validateInput: (v) =>
						/^#[0-9a-fA-F]{6}$/.test(v) ? undefined : 'Must be a 6-digit hex colour, e.g. #4ec9b0',
				})
				if (!input) return
				color = input
			}

			await ctx.config.setBranchColor(branchName, color)
		})),

		vscode.commands.registerCommand('gitbraid.rehideAssignedFiles', cmd(async () => {
			const ctx = activeContext()
			const assignments = ctx.config.getAllAssignments()
			const entries = Object.entries(assignments)
			if (entries.length === 0) {
				await vscode.window.showInformationMessage('GitBraid: no files are currently assigned.')
				return
			}
			const runner = getDefaultGitRunner()
			let hidden = 0
			let skipped = 0
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'GitBraid: re-hiding assigned files…', cancellable: false },
				async () => {
					for (const [rel, branch] of entries) {
						if (ctx.branchStack.worktreeExists(branch)) {
							await hideAssignedFile(runner, ctx.root.fsPath, rel)
							hidden++
						} else {
							skipped++
						}
					}
				},
			)
			const msg = skipped > 0
				? `Re-hid ${hidden} file(s). Skipped ${skipped} (assigned to the current branch — no worktree).`
				: `Re-hid ${hidden} file(s).`
			await vscode.window.showInformationMessage(`GitBraid: ${msg}`)
		})),

		vscode.commands.registerCommand('gitbraid.showActiveFolder', cmd(async () => {
			const all = registry.getAll()
			if (all.length <= 1) {
				await vscode.window.showInformationMessage(`GitBraid: single folder — ${primary.root.fsPath}`)
				return
			}
			const current = activeContext()
			const picked = await vscode.window.showQuickPick(
				all.map((ctx) => ({
					label: path.basename(ctx.root.fsPath),
					description: ctx === current ? `${ctx.root.fsPath} (active)` : ctx.root.fsPath,
					ctx,
				})),
				{ placeHolder: `Active: ${path.basename(current.root.fsPath)}` },
			)
			if (!picked || picked.ctx === current) return
			stackTreeProvider.setContext(picked.ctx.config, picked.ctx.workspaceSync, picked.ctx.root)
			statusBar.setContext(picked.ctx.workspaceSync, picked.ctx.config)
			await vscode.commands.executeCommand('revealInExplorer', picked.ctx.root)
		})),

		vscode.commands.registerCommand('gitbraid.refreshPRStatus', cmd(async () => {
			await prAwareness.refresh()
		})),

		vscode.commands.registerCommand('gitbraid.undoLastAssignment', cmd(async () => {
			const stack = activeContext().undoStack
			if (!stack.canUndo()) {
				await vscode.window.showInformationMessage('GitBraid: nothing to undo.')
				return
			}
			const op = await stack.undo()
			if (op) {
				await vscode.window.setStatusBarMessage(`GitBraid: undid — ${op.label}`, 3000)
			}
		})),

		vscode.commands.registerCommand('gitbraid.redoLastAssignment', cmd(async () => {
			const stack = activeContext().undoStack
			if (!stack.canRedo()) {
				await vscode.window.showInformationMessage('GitBraid: nothing to redo.')
				return
			}
			const op = await stack.redo()
			if (op) {
				await vscode.window.setStatusBarMessage(`GitBraid: redid — ${op.label}`, 3000)
			}
		})),

		vscode.commands.registerCommand('gitbraid.focusStackView', () => {
			stackView.reveal(undefined as never, { focus: true }).then(undefined, (e: unknown) => {
				log.error('focusStackView: ' + e)
			})
		}),

		vscode.commands.registerCommand('gitbraid.launchWindowForWorktree', cmd(async (node?: BranchNode) => {
			const ctx = activeContext()
			const branchName = node instanceof BranchNode
				? node.entry.name
				: await vscode.window.showQuickPick(
					ctx.config.getStack().map(e => e.name),
					{ placeHolder: 'Open branch worktree in new window' },
				)
			if (!branchName) return
			await vscode.commands.executeCommand('vscode.openFolder', ctx.branchStack.getWorktreePath(branchName), { forceNewWindow: true })
		})),

		vscode.commands.registerCommand('gitbraid.lockWorktree', cmd(async (node?: BranchNode) => {
			const ctx = activeContext()
			const branchName = node instanceof BranchNode
				? node.entry.name
				: await vscode.window.showQuickPick(
					ctx.config.getStack().map(e => e.name),
					{ placeHolder: 'Lock worktree for branch' },
				)
			if (!branchName) return
			await git.worktree.lock(ctx.branchStack.getWorktreePath(branchName).fsPath)
			await vscode.window.showInformationMessage(`Locked worktree for "${branchName}"`)
		})),

		vscode.commands.registerCommand('gitbraid.unlockWorktree', cmd(async (node?: BranchNode) => {
			const ctx = activeContext()
			const branchName = node instanceof BranchNode
				? node.entry.name
				: await vscode.window.showQuickPick(
					ctx.config.getStack().map(e => e.name),
					{ placeHolder: 'Unlock worktree for branch' },
				)
			if (!branchName) return
			await git.worktree.unlock(ctx.branchStack.getWorktreePath(branchName).fsPath)
			await vscode.window.showInformationMessage(`Unlocked worktree for "${branchName}"`)
		})),

		vscode.commands.registerCommand('gitbraid.copyStackDiagram', cmd(async () => {
			const ctx = activeContext()
			const stack = ctx.config.getStack()
			if (stack.length === 0) {
				await vscode.window.showInformationMessage('GitBraid: stack is empty — nothing to copy.')
				return
			}
			const assignments = ctx.config.getAllAssignments()

			const fileCounts: Record<string, number> = {}
			for (const branch of Object.values(assignments)) {
				fileCounts[branch] = (fileCounts[branch] ?? 0) + 1
			}

			const sorted = [...stack].sort((a, b) => a.order - b.order)
			const children: Record<string, string[]> = {}
			for (const entry of sorted) {
				if (!children[entry.base]) children[entry.base] = []
				children[entry.base].push(entry.name)
			}

			const rootBase = sorted[0].base
			const lines: string[] = [rootBase]

			function renderChildren(parent: string, prefix: string): void {
				const kids = children[parent] ?? []
				for (let i = 0; i < kids.length; i++) {
					const last = i === kids.length - 1
					const branchName = kids[i]
					const count = fileCounts[branchName] ?? 0
					const fileLabel = count === 1 ? '1 file' : `${count} files`
					const countStr = count > 0 ? `  [${fileLabel}]` : ''
					lines.push(`${prefix}${last ? '└── ' : '├── '}${branchName}${countStr}`)
					renderChildren(branchName, prefix + (last ? '    ' : '│   '))
				}
			}

			renderChildren(rootBase, '')
			await vscode.env.clipboard.writeText(lines.join('\n'))
			vscode.window.setStatusBarMessage('GitBraid: stack diagram copied to clipboard.', 3000)
		})),
	]
}
