import * as vscode from 'vscode'
import * as path from 'node:path'
import { log } from '../channelLogger'
import { git } from '../gitFunctions'
import { getDefaultGitRunner } from '../gitRunner'
import { unhideAssignedFile } from '../gitIndex'
import { BranchNode } from '../branchStackTreeProvider'
import { SHARED_DIR, SHARED_FILE } from '../stackShareService'
import { withErrorHandler } from '../errorSurfacer'
import {
	buildBaseList,
	buildAddBranchPickItems,
	filesAssignedTo,
	reorderForMove,
	toolDisplayName as _toolDisplayName,
	type BranchPickItem,
} from './_helpers'
import type { CommandDeps } from './types'

const cmd = withErrorHandler

/**
 * Best-effort detection of the repository's default branch.  Checks, in order:
 * 1. `git config init.defaultBranch` (user override / symbolic ref)
 * 2. The currently checked-out branch name
 * 3. Falls back to `"main"`.
 */
async function detectDefaultBranch(workspaceUri: vscode.Uri): Promise<string> {
	try {
		const symbolic = await git.defaultBranch()
		if (symbolic) return symbolic
	} catch {
		// fall through to current branch
	}
	try {
		const cur = await git.branch(workspaceUri)
		if (cur) return cur
	} catch {
		// fall through
	}
	return 'main'
}

/**
 * Move `branchName` one position up (toward the top of the stack / higher
 * order) or down (toward the base / lower order) within the sorted stack.
 * The stack is treated as ascending by `order` field; "up" means the branch
 * becomes a higher layer (larger order number, wins over more other branches).
 *
 * The pure ordering math lives in {@link reorderForMove} so it can be
 * unit-tested without a `ConfigService`; this shell just drives it.
 */
async function _moveBranch(
	ctx: import('./types').CommandDeps['primary'],
	branchName: string,
	direction: 'up' | 'down',
): Promise<void> {
	const names = reorderForMove(ctx.config.getStack(), branchName, direction)
	if (!names) return
	// Preserve scratch branches at their current orders — pass only non-scratch names.
	await ctx.config.reorderStack(names)
}

export function registerBranchCommands(deps: CommandDeps): vscode.Disposable[] {
	const { activeContext, resolveBranchNameArg, resolveActiveBranchWorktree, stackView } = deps

	return [
		vscode.commands.registerCommand('gitbraid.addStackBranch', cmd(async () => {
			const ctx = activeContext()
			const workspaceUri = ctx.root
			const stackBranchNames = new Set(ctx.config.getStack().map(e => e.name))

			const { local: localBranches } = await git.listBranches(workspaceUri)
			const availableLocal = localBranches.filter(b => !stackBranchNames.has(b))

			type BranchItem = vscode.QuickPickItem & { isNew?: boolean }

			// Map the pure builder's items to vscode.QuickPickItem (separator kind).
			const buildItems = (value: string, remote: string[] = []): BranchItem[] => {
				const raw: BranchPickItem[] = buildAddBranchPickItems(value, availableLocal, remote, stackBranchNames)
				return raw.map((it) => {
					if (it.kind === 'separator') {
						return { label: it.label, kind: vscode.QuickPickItemKind.Separator } as BranchItem
					}
					return {
						label: it.label,
						description: it.description,
						detail: it.detail,
						isNew: it.isNew,
					} as BranchItem
				})
			}

			const qp = vscode.window.createQuickPick<BranchItem>()
			qp.placeholder = 'Branch name — pick existing or type a new name'
			qp.matchOnDescription = false
			qp.items = buildItems('')

			let remoteDebounce: ReturnType<typeof setTimeout> | undefined

			qp.onDidChangeValue((value) => {
				if (remoteDebounce) clearTimeout(remoteDebounce)
				qp.items = buildItems(value)
				if (value.trim().length >= 2) {
					remoteDebounce = setTimeout(async () => {
						try {
							const { remote } = await git.listBranches(workspaceUri, value.trim())
							qp.items = buildItems(value, remote)
						} catch (e) {
							log.warn(`addStackBranch: remote search failed: ${e instanceof Error ? e.message : String(e)}`)
						}
					}, 300)
				}
			})

			const name = await new Promise<string | undefined>((resolve) => {
				let resolved = false
				const resolveOnce = (value: string | undefined) => {
					if (resolved) return
					resolved = true
					resolve(value)
					qp.dispose()
				}
				qp.onDidAccept(() => {
					const selected = qp.selectedItems[0]
					if (selected?.isNew && selected.detail) {
						resolveOnce(selected.detail)
					} else {
						resolveOnce((selected?.label ?? qp.value.trim()) || undefined)
					}
				})
				qp.onDidHide(() => { resolveOnce(undefined) })
				qp.show()
			})

			if (remoteDebounce) clearTimeout(remoteDebounce)
			if (!name) return

			const stack = ctx.config.getStack()
			const defaultBranch = await detectDefaultBranch(workspaceUri).catch(() => 'main')
			const bases = buildBaseList(stack, defaultBranch)
			const basePick = await vscode.window.showQuickPick(bases, {
				placeHolder: 'Base branch (used when creating a new branch)',
			})
			if (!basePick) return
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `GitBraid: adding "${name}" to stack…`, cancellable: false },
				async () => {
					await ctx.branchStack.addBranchToStack(name, basePick)
				},
			)
			await vscode.window.showInformationMessage(
				`Branch "${name}" added to stack in ${path.basename(ctx.root.fsPath)}`,
			)
		})),

		vscode.commands.registerCommand('gitbraid.removeStackBranch', cmd(async (node?: BranchNode) => {
			const ctx = activeContext()
			const stack = ctx.config.getStack()
			if (stack.length === 0) {
				await vscode.window.showWarningMessage('Stack is empty.')
				return
			}
			const picked = node instanceof BranchNode
				? node.entry.name
				: await vscode.window.showQuickPick(
					stack.map((e) => e.name),
					{ placeHolder: 'Remove branch from stack' },
				)
			if (!picked) return
			await ctx.branchStack.removeBranchFromStack(picked)
			await vscode.window.showInformationMessage(`Branch "${picked}" removed from stack`)
		})),

		vscode.commands.registerCommand('gitbraid.addScratchWorktree', cmd(async () => {
			const ctx = activeContext()
			const SCRATCH_NAME = 'gitbraid-scratch'
			if (ctx.config.getStack().some((e) => e.name === SCRATCH_NAME)) {
				await vscode.window.showInformationMessage('A scratch worktree already exists.')
				return
			}
			const defaultBranch = await detectDefaultBranch(ctx.root).catch(() => 'main')
			await ctx.branchStack.addBranchToStack(SCRATCH_NAME, defaultBranch, '#888888')
			await ctx.config.setScratch(SCRATCH_NAME, true)
			await vscode.window.showInformationMessage(
				`Scratch area "${SCRATCH_NAME}" created. Assign files to it to park them out of the way.`,
			)
		})),

		vscode.commands.registerCommand('gitbraid.resetBranch', cmd(async (arg?: unknown) => {
			const ctx = activeContext()
			const stack = ctx.config.getStack()
			if (stack.length === 0) {
				await vscode.window.showWarningMessage('Stack is empty.')
				return
			}
			const picked = arg instanceof BranchNode
				? arg.entry.name
				: await resolveBranchNameArg(arg, 'Reset branch — unassign all files')
			if (!picked) return

			const assignedFiles = filesAssignedTo(ctx.config.getAllAssignments(), picked)

			if (assignedFiles.length === 0) {
				await vscode.window.showInformationMessage(`Branch "${picked}" has no assigned files.`)
				return
			}

			const confirm = await vscode.window.showWarningMessage(
				`Reset "${picked}"? This will unassign ${assignedFiles.length} file(s) and discard their uncommitted changes in the worktree.`,
				{ modal: true },
				'Reset',
			)
			if (confirm !== 'Reset') return

			const runner = getDefaultGitRunner()
			const hasWorktree = ctx.branchStack.worktreeExists(picked)
			const wtDir = hasWorktree ? ctx.branchStack.getWorktreePath(picked).fsPath : undefined

			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `GitBraid: resetting "${picked}"…`, cancellable: false },
				async () => {
					for (const rel of assignedFiles) {
						if (wtDir) {
							try {
								await runner.run(['checkout', 'HEAD', '--', rel], { cwd: wtDir })
							} catch {
								// File may not exist in HEAD yet (untracked) — skip restore
							}
						}
						await unhideAssignedFile(runner, ctx.root.fsPath, rel)
						await ctx.config.removeAssignment(rel)
					}
				},
			)
			await vscode.window.showInformationMessage(
				`GitBraid: reset "${picked}" — ${assignedFiles.length} file(s) returned to main workspace.`,
			)
		})),

		vscode.commands.registerCommand('gitbraid.rebaseBranch', cmd(async (arg?: string | BranchNode) => {
			const ctx = activeContext()
			const stack = ctx.config.getStack()
			if (stack.length === 0) {
				await vscode.window.showWarningMessage('Stack is empty.')
				return
			}
			const name = arg instanceof BranchNode
				? arg.entry.name
				: (arg ?? await vscode.window.showQuickPick(
					stack.map((e) => e.name),
					{ placeHolder: 'Rebase branch onto its parent' },
				))
			if (!name) return
			await ctx.rebaseSvc.rebaseBranch(name)
		})),

		vscode.commands.registerCommand('gitbraid.rebaseAbort', cmd(async (arg?: string | BranchNode) => {
			const resolved = await resolveActiveBranchWorktree(arg, 'Abort rebase in branch')
			if (!resolved) return
			await resolved.ctx.rebaseRecovery.abort(resolved.worktreeDir)
		})),

		vscode.commands.registerCommand('gitbraid.rebaseContinue', cmd(async (arg?: string | BranchNode) => {
			const resolved = await resolveActiveBranchWorktree(arg, 'Continue rebase in branch')
			if (!resolved) return
			await resolved.ctx.rebaseRecovery.continue(resolved.worktreeDir)
		})),

		vscode.commands.registerCommand('gitbraid.openRebaseConflicts', cmd(async (arg?: string | BranchNode) => {
			const resolved = await resolveActiveBranchWorktree(arg, 'Open conflicts for branch')
			if (!resolved) return
			await resolved.ctx.rebaseRecovery.openConflicts(resolved.worktreeDir)
		})),

		vscode.commands.registerCommand('gitbraid.pushStack', cmd(async () => {
			const ctx = activeContext()
			const stack = ctx.config.getStack()
			if (stack.length === 0) {
				await vscode.window.showInformationMessage('Stack is empty — nothing to push.')
				return
			}
			const mode = await vscode.window.showQuickPick(
				[
					{ label: 'Push', description: 'Fast-forward or fail', force: false },
					{ label: 'Push with --force-with-lease', description: 'Rewrite upstream safely (post-rebase)', force: true },
				],
				{ placeHolder: `Push ${String(stack.length)} branch(es) to origin?` },
			)
			if (!mode) return
			await ctx.stackCommands.pushStack({ forceWithLease: mode.force })
		})),

		vscode.commands.registerCommand('gitbraid.syncStack', cmd(async () => {
			const ctx = activeContext()
			const stack = ctx.config.getStack()
			if (stack.length === 0) {
				await vscode.window.showInformationMessage('Stack is empty — nothing to sync.')
				return
			}
			const proceed = await vscode.window.showWarningMessage(
				`Fetch origin and rebase every branch in the stack (${String(stack.length)}) onto its parent?\n\nDirty worktrees will be skipped.`,
				{ modal: true },
				'Sync',
			)
			if (proceed !== 'Sync') return
			await ctx.stackCommands.syncStack()
		})),

		vscode.commands.registerCommand('gitbraid.exportStack', cmd(async () => {
			const ctx = activeContext()
			const stack = ctx.config.getStack()
			if (stack.length === 0) {
				await vscode.window.showInformationMessage('Stack is empty — nothing to export.')
				return
			}
			const filePath = await ctx.stackShare.exportToDisk()
			const rel = path.relative(ctx.root.fsPath, filePath)
			const open = await vscode.window.showInformationMessage(
				`GitBraid: exported ${String(stack.length)} branch(es) to ${rel}. ` +
				'Commit this file to share the layout with your team.',
				'Open',
			)
			if (open === 'Open') {
				await vscode.window.showTextDocument(vscode.Uri.file(filePath))
			}
		})),

		vscode.commands.registerCommand('gitbraid.importStack', cmd(async () => {
			const ctx = activeContext()
			const shared = await ctx.stackShare.readSharedFile()
			if (!shared) {
				await vscode.window.showInformationMessage(
					`GitBraid: no shared stack found.  Run "GitBraid: Export Stack" on a colleague's machine and commit the resulting \`${SHARED_DIR}/${SHARED_FILE}\`.`,
				)
				return
			}
			const diff = ctx.stackShare.diffWithCurrent(shared)
			const totalChanges =
				diff.newBranches.length + diff.newAssignments.length +
				diff.conflictBranches.length + diff.conflictAssignments.length
			if (totalChanges === 0) {
				await vscode.window.showInformationMessage('GitBraid: shared stack is already applied — nothing to import.')
				return
			}
			const conflicts = diff.conflictBranches.length + diff.conflictAssignments.length
			let resolution: { branches: 'theirs' | 'ours', assignments: 'theirs' | 'ours' } = {
				branches: 'theirs',
				assignments: 'theirs',
			}
			if (conflicts > 0) {
				const pick = await vscode.window.showQuickPick(
					[
						{
							label: 'Prefer shared file',
							detail: `Overwrite ${String(conflicts)} local values with the shared version.`,
							resolution: { branches: 'theirs', assignments: 'theirs' } as const,
						},
						{
							label: 'Keep local values',
							detail: 'Only import branches/assignments that don\'t conflict with the local stack.',
							resolution: { branches: 'ours', assignments: 'ours' } as const,
						},
					],
					{ placeHolder: `${String(conflicts)} conflict(s) with your local stack — choose how to resolve.` },
				)
				if (!pick) return
				resolution = pick.resolution
			}
			const summary = await ctx.stackShare.applyImport(shared, resolution)
			await vscode.window.showInformationMessage(
				`GitBraid: imported ${String(summary.addedBranches)} new branch(es), ${String(summary.addedAssignments)} new assignment(s), ` +
				`updated ${String(summary.updatedBranches)}/${String(summary.updatedAssignments)}, skipped ${String(summary.skipped)}.`,
			)
		})),

		// ─── Cross-tool stack importer (RM-012) ─────────────────────────────────

		vscode.commands.registerCommand('gitbraid.importStackedTool', cmd(async () => {
			const ctx = activeContext()
			const detected = await ctx.stackedToolImporter.detectAll()
			if (detected.length === 0) {
				await vscode.window.showInformationMessage(
					'GitBraid: no stacked-PR tooling detected in this repository. ' +
					'Supported: Graphite, git-stack, git-spr, GitButler, or plain upstream tracking.',
				)
				return
			}

			let chosen = detected[0]
			if (detected.length > 1) {
				const pick = await vscode.window.showQuickPick(
					detected.map((d) => ({
						label: _toolDisplayName(d.tool),
						description: `${String(d.branches.length)} branch(es)`,
						detail: d.source,
						stack: d,
					})),
					{ placeHolder: 'Multiple stacked-PR tools detected — choose one to import from' },
				)
				if (!pick) return
				chosen = pick.stack
			}

			const preview = ctx.stackedToolImporter.preview(chosen)
			const lines: string[] = []
			lines.push(`Detected ${String(chosen.branches.length)} branch(es) via ${_toolDisplayName(chosen.tool)} (${chosen.source}).`)
			lines.push('')
			if (preview.newBranches.length > 0) {
				lines.push(`Will add ${String(preview.newBranches.length)} new branch(es):`)
				for (const b of preview.newBranches) lines.push(`  + ${b.name} → ${b.base}`)
			}
			if (preview.conflicts.length > 0) {
				lines.push('')
				lines.push(`Will skip ${String(preview.conflicts.length)} branch(es) already in the stack.`)
			}
			if (preview.unknownBases.length > 0) {
				lines.push('')
				lines.push(`Warning: ${String(preview.unknownBases.length)} unknown base(s): ${preview.unknownBases.join(', ')}`)
			}
			if (preview.warnings.length > 0) {
				lines.push('')
				lines.push('Detection warnings:')
				for (const w of preview.warnings) lines.push(`  • ${w}`)
			}

			if (preview.newBranches.length === 0) {
				await vscode.window.showInformationMessage(
					`GitBraid: ${String(chosen.branches.length)} branch(es) detected but all of them are already in the stack.`,
				)
				return
			}

			const proceed = await vscode.window.showInformationMessage(
				lines.join('\n'),
				{ modal: true },
				'Import',
			)
			if (proceed !== 'Import') return

			const summary = await ctx.stackedToolImporter.apply(chosen, false)
			const errorText = summary.errors.length > 0
				? ` (${String(summary.errors.length)} error(s); see Output)`
				: ''
			await vscode.window.showInformationMessage(
				`GitBraid: imported ${String(summary.addedBranches)} branch(es), ` +
				`skipped ${String(summary.skipped)}${errorText}.`,
			)
			if (summary.errors.length > 0) {
				for (const err of summary.errors) {
					log.error(`stackedToolImporter: ${err.branch}: ${err.message}`)
				}
			}
		})),

		// ─── Checkpoints ─────────────────────────────────────────────────────────

		vscode.commands.registerCommand('gitbraid.saveCheckpoint', cmd(async () => {
			const ctx = activeContext()
			const label = await vscode.window.showInputBox({
				prompt: 'Optional checkpoint label',
				placeHolder: 'before-rebase',
			})
			if (label === undefined) return
			const filePath = await ctx.checkpoint.saveCheckpoint(label || undefined)
			await vscode.window.showInformationMessage(`Checkpoint saved: ${path.basename(filePath)}`)
		})),

		vscode.commands.registerCommand('gitbraid.restoreCheckpoint', cmd(async () => {
			const ctx = activeContext()
			const metas = await ctx.checkpoint.listCheckpoints()
			if (metas.length === 0) {
				await vscode.window.showInformationMessage('No saved checkpoints found.')
				return
			}
			const items = metas.map((m) => ({
				label: m.filename.replace(/\.json$/, ''),
				description: `${String(m.branchCount)} branches · ${String(m.assignmentCount)} assignments`,
				detail: new Date(m.timestamp).toLocaleString(),
				filePath: m.filePath,
			}))
			const selected = await vscode.window.showQuickPick(items, {
				placeHolder: 'Select a checkpoint to restore',
				title: 'GitBraid: Restore Stack Checkpoint',
			})
			if (!selected) return
			const confirm = await vscode.window.showWarningMessage(
				`Restore checkpoint "${selected.label}"? The current stack and assignments will be replaced.`,
				{ modal: true },
				'Restore',
			)
			if (confirm !== 'Restore') return
			await ctx.checkpoint.restoreCheckpoint(selected.filePath)
			await vscode.window.showInformationMessage(`Restored checkpoint: ${selected.label}`)
		})),

		// ─── Commit message templates ─────────────────────────────────────────────

		vscode.commands.registerCommand('gitbraid.setCommitTemplate', cmd(async (arg?: unknown) => {
			const ctx = activeContext()
			const branchName = await resolveBranchNameArg(arg, 'Branch to set commit template for')
			if (!branchName) return
			const entry = ctx.config.getBranch(branchName)
			const current = entry?.commitTemplate ?? ''
			const template = await vscode.window.showInputBox({
				prompt: `Commit message template for "${branchName}" (leave blank to clear)`,
				value: current,
				placeHolder: 'feat({scope}): {issue} ',
			})
			if (template === undefined) return
			await ctx.config.setCommitTemplate(branchName, template)
			if (template) {
				await vscode.window.showInformationMessage(
					`Template set for "${branchName}". Variables: {branch}, {issue}, {scope}.`,
				)
			} else {
				await vscode.window.showInformationMessage(`Commit template cleared for "${branchName}".`)
			}
		})),

		// ─── Stack reorder (move up / move down) ─────────────────────────────────

		vscode.commands.registerCommand('gitbraid.moveBranchUp', cmd(async (node?: BranchNode) => {
			const ctx = activeContext()
			const target = node instanceof BranchNode
				? node
				: stackView.selection.find((s): s is BranchNode => s instanceof BranchNode)
			if (!target) {
				const name = await resolveBranchNameArg(undefined, 'Select branch to move up')
				if (!name) return
				await _moveBranch(ctx, name, 'up')
				return
			}
			await _moveBranch(ctx, target.entry.name, 'up')
		})),

		vscode.commands.registerCommand('gitbraid.moveBranchDown', cmd(async (node?: BranchNode) => {
			const ctx = activeContext()
			const target = node instanceof BranchNode
				? node
				: stackView.selection.find((s): s is BranchNode => s instanceof BranchNode)
			if (!target) {
				const name = await resolveBranchNameArg(undefined, 'Select branch to move down')
				if (!name) return
				await _moveBranch(ctx, name, 'down')
				return
			}
			await _moveBranch(ctx, target.entry.name, 'down')
		})),

		// ─── Team stack template export ───────────────────────────────────────────

		vscode.commands.registerCommand('gitbraid.exportStackTemplate', cmd(async () => {
			const ctx = activeContext()
			if (ctx.config.getStack().length === 0) {
				await vscode.window.showWarningMessage('Stack is empty — nothing to export as a template.')
				return
			}
			const instructions = await vscode.window.showInputBox({
				prompt: 'Optional onboarding instructions (shown to new teammates)',
				placeHolder: 'Set up the sprint stack: feature/auth → feature/token → main',
			})
			if (instructions === undefined) return
			const filePath = await ctx.stackShare.exportAsTemplate(instructions || undefined)
			const pick = await vscode.window.showInformationMessage(
				`Template exported to ${path.relative(ctx.root.fsPath, filePath)}. Commit this file so teammates can use it.`,
				'Open File',
			)
			if (pick === 'Open File') {
				await vscode.window.showTextDocument(vscode.Uri.file(filePath))
			}
		})),
	]
}
