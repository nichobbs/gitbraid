import * as vscode from 'vscode'
import { anchorFor } from '../hunkRouter'
import { recordAssignHunk, recordUnassignHunk } from '../undoStack'
import { StackContentProvider } from '../stackContentProvider'
import { withErrorHandler } from '../errorSurfacer'
import type { CommandDeps } from './types'

const cmd = withErrorHandler

export function registerHunkCommands(deps: CommandDeps): vscode.Disposable[] {
	const { contextForUri, relativePathIn, overlayDiagnostics } = deps

	return [
		vscode.commands.registerCommand(
			'gitbraid.assignHunk',
			cmd(async (uri: vscode.Uri, hunkIndex: number) => {
				const ctx = contextForUri(uri)
				const rel = relativePathIn(ctx, uri)
				const stack = ctx.config.getStack()
				if (stack.length === 0) {
					await vscode.window.showWarningMessage('No branches in the stack. Add a branch first.')
					return
				}
				const picked = await vscode.window.showQuickPick(
					stack.map((e) => ({ label: e.name, description: e.color })),
					{ placeHolder: `Assign hunk ${String(hunkIndex)} to branch` },
				)
				if (!picked) return
				const hunks = await ctx.diffEngine.getHunksForFile(ctx.root.fsPath, rel)
				const anchor = hunks[hunkIndex] ? anchorFor(hunks[hunkIndex]) : undefined
				const previousBranch = ctx.config.getHunkAssignments(rel)?.get(hunkIndex)
				await ctx.config.setHunkAssignment(rel, hunkIndex, picked.label, anchor)
				recordAssignHunk(ctx.undoStack, ctx.config, rel, hunkIndex, picked.label, previousBranch, anchor)
				await vscode.window.showInformationMessage(`Hunk ${String(hunkIndex)} → ${picked.label}`)
				await overlayDiagnostics.refreshForUri(uri)
			}),
		),

		vscode.commands.registerCommand(
			'gitbraid.unassignHunk',
			cmd(async (uri: vscode.Uri, hunkIndex: number) => {
				const ctx = contextForUri(uri)
				const rel = relativePathIn(ctx, uri)
				const previousBranch = ctx.config.getHunkAssignments(rel)?.get(hunkIndex)
				const previousAnchor = ctx.config.getHunkAnchor(rel, hunkIndex)
				await ctx.config.removeHunkAssignment(rel, hunkIndex)
				if (previousBranch !== undefined) {
					recordUnassignHunk(ctx.undoStack, ctx.config, rel, hunkIndex, previousBranch, previousAnchor)
				}
				await overlayDiagnostics.refreshForUri(uri)
			}),
		),

		vscode.commands.registerCommand(
			'gitbraid.openResolvedAtTop',
			cmd(async (uri?: vscode.Uri) => {
				const target = uri ?? vscode.window.activeTextEditor?.document.uri
				if (!target) {
					await vscode.window.showWarningMessage('Open a file first to see its resolved stack view.')
					return
				}
				const ctx = contextForUri(target)
				const rel = relativePathIn(ctx, target)
				const stackUri = StackContentProvider.uriFor(rel, ctx.root)
				await vscode.commands.executeCommand(
					'vscode.diff',
					target,
					stackUri,
					`${rel} (on-disk ↔ top of stack)`,
				)
			}),
		),

		vscode.commands.registerCommand(
			'gitbraid.showStackDiff',
			cmd(async (uri?: vscode.Uri) => {
				const target = uri ?? vscode.window.activeTextEditor?.document.uri
				if (!target) {
					await vscode.window.showWarningMessage('Open a file first to see its stack diff.')
					return
				}
				const ctx = contextForUri(target)
				const rel = relativePathIn(ctx, target)
				const diff = await ctx.stackResolver.getStackDiff(ctx.root.fsPath, rel)
				if (!diff) {
					await vscode.window.showInformationMessage(`No stack diff for ${rel}.`)
					return
				}
				const doc = await vscode.workspace.openTextDocument({ language: 'diff', content: diff })
				await vscode.window.showTextDocument(doc, { preview: true })
			}),
		),

		vscode.commands.registerCommand(
			'gitbraid.routeHunks',
			cmd(async (uri?: vscode.Uri) => {
				const target = uri ?? vscode.window.activeTextEditor?.document.uri
				if (!target) {
					await vscode.window.showWarningMessage('No file active to route hunks for.')
					return
				}
				const ctx = contextForUri(target)
				const rel = relativePathIn(ctx, target)
				const assignments = ctx.config.getHunkAssignments(rel)
				if (!assignments || assignments.size === 0) {
					await vscode.window.showInformationMessage('No hunk assignments found for this file.')
					return
				}
				const worktreeDirs = new Map<string, string>()
				for (const entry of ctx.config.getStack()) {
					worktreeDirs.set(entry.name, ctx.branchStack.getWorktreePath(entry.name).fsPath)
				}
				const anchors = new Map<number, import('../configTypes').HunkAnchor>()
				for (const idx of assignments.keys()) {
					const a = ctx.config.getHunkAnchor(rel, idx)
					if (a) anchors.set(idx, a)
				}
				const result = await ctx.hunkRouter.routeFile(ctx.root.fsPath, rel, worktreeDirs, assignments, anchors)
				if (result.ok) {
					await ctx.config.clearHunkAssignments(rel)
					await vscode.window.showInformationMessage(`Routed hunks for ${rel} successfully.`)
				} else {
					// Only clear the hunks that actually applied — leaving the
					// failed ones assigned prevents a retry from re-applying an
					// already-applied branch's patch (which would then fail too).
					for (const idx of result.appliedIndices) {
						await ctx.config.removeHunkAssignment(rel, idx)
					}
					if (result.appliedIndices.length > 0) {
						await vscode.window.showWarningMessage(
							`gitbraid: routed ${String(result.appliedIndices.length)} hunk(s) for ${rel}; ` +
							`${String(result.failedIndices.length)} failed and remain assigned.`,
						)
					}
				}
			}),
		),
	]
}
