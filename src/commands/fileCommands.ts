import * as vscode from 'vscode'
import { log } from '../channelLogger'
import { FileNode, FloatingFileNode } from '../branchStackTreeProvider'
import { hideAssignedFile, unhideAssignedFile } from '../gitIndex'
import { git } from '../gitFunctions'
import { getDefaultGitRunner } from '../gitRunner'
import { recordAssignFile, recordUnassignFile } from '../undoStack'
import { withErrorHandler } from '../errorSurfacer'
import type { CommandDeps } from './types'

const cmd = withErrorHandler

export function registerFileCommands(deps: CommandDeps): vscode.Disposable[] {
	const { activeContext, contextForUri, relativePathIn, extractFileUri } = deps

	return [
		vscode.commands.registerCommand('gitbraid.assignFile', cmd(async (arg?: unknown, allArgs?: unknown[]) => {
			let uris: vscode.Uri[]
			if (allArgs && allArgs.length > 0) {
				uris = allArgs.map(extractFileUri).filter((u): u is vscode.Uri => u !== undefined)
			} else if (arg instanceof FloatingFileNode) {
				uris = arg.resourceUri ? [arg.resourceUri] : []
			} else if (arg instanceof vscode.Uri) {
				uris = [arg]
			} else {
				const u = extractFileUri(arg)
				if (u) {
					uris = [u]
				} else {
					const active = vscode.window.activeTextEditor?.document.uri
					if (!active) {
						await vscode.window.showWarningMessage('No file selected to assign.')
						return
					}
					uris = [active]
				}
			}
			if (uris.length === 0) {
				await vscode.window.showWarningMessage('No file selected to assign.')
				return
			}
			// Expand directories to their contained changed files (honours .gitignore).
			const targets: vscode.Uri[] = []
			for (const uri of uris) {
				const stat = await vscode.workspace.fs.stat(uri)
				if (stat.type === vscode.FileType.Directory) {
					const folderCtx = contextForUri(uri)
					const relFolder = relativePathIn(folderCtx, uri)
					const result = await getDefaultGitRunner().run(
						['ls-files', '--modified', '--others', '--exclude-standard', '--', relFolder],
						{ cwd: folderCtx.root.fsPath },
					)
					for (const f of result.stdout.split('\n').filter(Boolean)) {
						targets.push(vscode.Uri.joinPath(folderCtx.root, f))
					}
				} else {
					targets.push(uri)
				}
			}
			if (targets.length === 0) {
				void vscode.window.showWarningMessage('No files found to assign.')
				return
			}
			const pickerCtx = contextForUri(targets[0])
			const stack = pickerCtx.config.getStack()
			const currentBranch = await git.branch(pickerCtx.root).catch(() => undefined)
			const currentInStack = currentBranch ? stack.some(e => e.name === currentBranch) : true
			const pickItems: Array<{ label: string; description?: string }> = []
			if (currentBranch && !currentInStack) {
				pickItems.push({ label: currentBranch, description: '(current branch — stays in workspace)' })
			}
			pickItems.push(...stack.map((e) => ({ label: e.name, description: e.color })))
			if (pickItems.length === 0) {
				await vscode.window.showWarningMessage('No branches in the stack for the active folder. Add a branch first.')
				return
			}
			const picked = await vscode.window.showQuickPick(pickItems, { placeHolder: 'Assign file to branch' })
			if (!picked) return

			const runner = getDefaultGitRunner()
			for (const target of targets) {
				const ctx = contextForUri(target)
				const rel = relativePathIn(ctx, target)
				const branchInStack = !!ctx.config.getBranch(picked.label)
				if (!branchInStack && picked.label !== currentBranch) {
					log.warn(`assignFile: skipping ${rel} — branch "${picked.label}" not in folder ${ctx.root.fsPath}`)
					continue
				}
				const previous = ctx.config.getAssignment(rel)
				await ctx.config.setAssignment(rel, picked.label)
				recordAssignFile(ctx.undoStack, ctx.config, rel, picked.label, previous)
				if (branchInStack && ctx.branchStack.worktreeExists(picked.label)) {
					await hideAssignedFile(runner, ctx.root.fsPath, rel)
				}
			}
			const msg = targets.length === 1
				? `Assigned ${vscode.workspace.asRelativePath(targets[0])} → ${picked.label}`
				: `Assigned ${targets.length} files → ${picked.label}`
			await vscode.window.showInformationMessage(msg)
		})),

		// Delegates to assignFile — separate entry so the menu label reads
		// "Assign Folder to Branch" rather than "Assign File to Branch".
		vscode.commands.registerCommand('gitbraid.assignFolder', cmd(async (arg?: unknown, allArgs?: unknown[]) => {
			await vscode.commands.executeCommand('gitbraid.assignFile', arg, allArgs)
		})),

		vscode.commands.registerCommand('gitbraid.unassignFile', cmd(async (arg?: unknown) => {
			const target = arg instanceof FileNode
				? arg.resourceUri
				: (extractFileUri(arg) ?? vscode.window.activeTextEditor?.document.uri)
			if (!target) {
				await vscode.window.showWarningMessage('No file selected to unassign.')
				return
			}
			const ctx = contextForUri(target)
			const rel = relativePathIn(ctx, target)
			const previous = ctx.config.getAssignment(rel)
			await ctx.config.removeAssignment(rel)
			if (previous !== undefined) {
				recordUnassignFile(ctx.undoStack, ctx.config, rel, previous)
				await unhideAssignedFile(getDefaultGitRunner(), ctx.root.fsPath, rel)
			}
			await vscode.window.showInformationMessage(`Unassigned ${rel}`)
		})),

		vscode.commands.registerCommand('gitbraid.unassignFolder', cmd(async (arg?: unknown) => {
			const folderUri = extractFileUri(arg)
			if (!folderUri) {
				await vscode.window.showWarningMessage('No folder selected to unassign.')
				return
			}
			const ctx = contextForUri(folderUri)
			const relFolder = relativePathIn(ctx, folderUri)
			const result = await getDefaultGitRunner().run(
				['ls-files', '--modified', '--others', '--exclude-standard', '--', relFolder],
				{ cwd: ctx.root.fsPath },
			)
			const files = result.stdout.split('\n').filter(Boolean)
			const runner = getDefaultGitRunner()
			let count = 0
			for (const f of files) {
				const previous = ctx.config.getAssignment(f)
				if (previous === undefined) continue
				await ctx.config.removeAssignment(f)
				recordUnassignFile(ctx.undoStack, ctx.config, f, previous)
				await unhideAssignedFile(runner, ctx.root.fsPath, f)
				count++
			}
			if (count === 0) {
				await vscode.window.showInformationMessage('No assigned files found under that folder.')
			} else {
				await vscode.window.showInformationMessage(
					`Unassigned ${count} file${count === 1 ? '' : 's'} under ${relFolder}`,
				)
			}
		})),

		vscode.commands.registerCommand('gitbraid.copyToWorktree', cmd(async (node?: FileNode | FloatingFileNode) => {
			const fileUri = (node instanceof FileNode || node instanceof FloatingFileNode)
				? node.resourceUri
				: vscode.window.activeTextEditor?.document.uri
			if (!fileUri) return
			const ctx = contextForUri(fileUri)
			const picked = await vscode.window.showQuickPick(
				ctx.config.getStack().map(e => e.name),
				{ placeHolder: 'Copy file to branch worktree' },
			)
			if (!picked) return
			const rel = relativePathIn(ctx, fileUri)
			await vscode.workspace.fs.copy(
				fileUri,
				vscode.Uri.joinPath(ctx.branchStack.getWorktreePath(picked), rel),
				{ overwrite: true },
			)
			await vscode.window.showInformationMessage(`Copied ${rel} → ${picked}`)
		})),

		vscode.commands.registerCommand('gitbraid.moveToWorktree', cmd(async (node?: FileNode | FloatingFileNode) => {
			const fileUri = (node instanceof FileNode || node instanceof FloatingFileNode)
				? node.resourceUri
				: vscode.window.activeTextEditor?.document.uri
			if (!fileUri) return
			const ctx = contextForUri(fileUri)
			const picked = await vscode.window.showQuickPick(
				ctx.config.getStack().map(e => e.name),
				{ placeHolder: 'Move file to branch worktree' },
			)
			if (!picked) return
			const rel = relativePathIn(ctx, fileUri)
			await vscode.workspace.fs.copy(
				fileUri,
				vscode.Uri.joinPath(ctx.branchStack.getWorktreePath(picked), rel),
				{ overwrite: true },
			)
			await vscode.workspace.fs.delete(fileUri)
			if (node instanceof FileNode) {
				await ctx.config.removeAssignment(rel)
			}
			await vscode.window.showInformationMessage(`Moved ${rel} → ${picked}`)
		})),
	]
}
