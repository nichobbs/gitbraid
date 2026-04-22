import * as vscode from 'vscode'
import { git } from './gitFunctions'
import { log } from './channelLogger'
import { ConfigService } from './configService'
import { BranchStackService } from './branchStackService'
import { WorkspaceSync } from './workspaceSync'
import { BranchFileDecorationProvider } from './fileDecorationProvider'
import { BranchScmProviderManager } from './branchScmProvider'
import { BranchNode, BranchStackTreeProvider, FileNode, FloatingFileNode, FloatingStatusBarItem } from './branchStackTreeProvider'
import { DiffEngine } from './diffEngine'
import { HunkRouter, anchorFor } from './hunkRouter'
import { HunkCodeLensProvider, OverlayDiagnostics } from './hunkCodeLensProvider'
import { StackResolver } from './stackResolver'
import { StackContentProvider } from './stackContentProvider'
import { RebaseSuggestionService } from './rebaseSuggestionService'
import { StackCommands } from './stackCommands'
import { RebaseRecovery } from './rebaseRecovery'
import {
	UndoStack,
	recordAssignFile,
	recordUnassignFile,
	recordAssignHunk,
	recordUnassignHunk,
} from './undoStack'
import { StackShareService, SHARED_DIR, SHARED_FILE } from './stackShareService'
import { PRAwareness } from './prAwareness'
import * as path from 'node:path'
import { MbcApi } from './mbcApi'
import { registerLmTools } from './lmTools'

import { FileChangeBus } from './fileChangeBus'
import { withErrorHandler, showError } from './errorSurfacer'
export { showError }

/**
 * Wraps an async command handler so that any rejection is caught, logged, and
 * surfaced via {@link showError} (notification + "Open Output" action).
 */
const cmd = withErrorHandler

export async function activate(context: vscode.ExtensionContext) {
	const commands: vscode.Disposable[] = []

	if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
		// VS Code activates the extension whenever a .git dir is present in the
		// window; that can fire before any folder is added. Quietly skip —
		// activation events will re-fire once a folder opens. Previously this
		// threw a raw Error which VS Code surfaced as a red notification.
		log.info('gitbraid activation skipped: no workspace folder')
		return
	}

	// Workspace trust: GitBraid spawns git subprocesses that can trigger
	// repository-defined hooks. In an untrusted workspace we defer real
	// activation until the user grants trust (T23).  Capabilities block in
	// package.json declares untrustedWorkspaces: "limited" so VS Code lets
	// the extension load but keeps it idle.
	if (!vscode.workspace.isTrusted) {
		log.info('gitbraid: workspace is not trusted — waiting for trust grant before activating')
		const disposable = vscode.workspace.onDidGrantWorkspaceTrust(() => {
			disposable.dispose()
			void activate(context)
		})
		context.subscriptions.push(disposable)
		return
	}

	log.info('activating gitbraid (version=' + context.extension.packageJSON.version + ')')
	// ─── Phase 1: Branch-overlay services ─────────────────────────────────────
	const workspaceRoot = vscode.workspace.workspaceFolders[0].uri
	const configService = ConfigService.getInstance()
	await configService.load(workspaceRoot)

	const branchStack = BranchStackService.getInstance(configService)
	await branchStack.initStack(workspaceRoot)

	// Shared file-system watcher for the entire extension (T10).  Subsequent
	// services subscribe to its domain events instead of spawning their own
	// `**/*` watchers.
	const bus = new FileChangeBus(workspaceRoot)
	context.subscriptions.push(bus)

	const workspaceSync = WorkspaceSync.getInstance(configService)
	workspaceSync.init(workspaceRoot, bus)

	// Undo/redo ring for assignment-level operations (T69).  Constructed
	// early so Phase 2 providers can receive it.
	const undoStack = new UndoStack()

	context.subscriptions.push(configService, branchStack, workspaceSync, undoStack)

	// ─── Phase 2: SCM Integration & UI ────────────────────────────────────────
	const decorationProvider = new BranchFileDecorationProvider(configService, workspaceSync)
	context.subscriptions.push(decorationProvider)

	const scmManager = new BranchScmProviderManager(configService, workspaceSync, workspaceRoot)
	await scmManager.initialize()
	context.subscriptions.push(scmManager)

	// PR awareness — feature-detects the GitHub PR extension at runtime.
	// Absent / inactive / unexpected-API cases all fall back to "no
	// decorations"; gated on `gitbraid.prDecorationsEnabled`.
	const prAwareness = new PRAwareness()
	context.subscriptions.push(prAwareness)
	prAwareness.start()

	const stackTreeProvider = new BranchStackTreeProvider(
		configService,
		workspaceSync,
		(rel, newBranch, previous) => recordAssignFile(undoStack, configService, rel, newBranch, previous),
		(rel, previous) => recordUnassignFile(undoStack, configService, rel, previous),
		prAwareness,
	)
	const stackView = vscode.window.createTreeView('gitbraid.stackView', {
		treeDataProvider: stackTreeProvider,
		// Drag-and-drop: file nodes onto branch nodes reassigns; onto the
		// floating group unassigns; branch-onto-branch reorders the stack.
		// Accepts drops of text/uri-list from the Explorer too.
		dragAndDropController: stackTreeProvider,
		showCollapseAll: true,
		canSelectMany: true,
	})
	stackView.title = 'Branch Stack'
	context.subscriptions.push(stackTreeProvider, stackView)

	const statusBar = new FloatingStatusBarItem(workspaceSync, configService)
	context.subscriptions.push(statusBar)

	// ─── Phase 3: Chunk-Level Assignment ──────────────────────────────────────
	const diffEngine = new DiffEngine()
	const hunkRouter = new HunkRouter(diffEngine)
	const hunkCodeLens = new HunkCodeLensProvider(diffEngine, configService)
	const overlayDiagnostics = new OverlayDiagnostics(diffEngine, configService)

	context.subscriptions.push(
		hunkCodeLens,
		overlayDiagnostics,
		vscode.languages.registerCodeLensProvider(
			{ scheme: 'file', pattern: '**' },
			hunkCodeLens,
		),
	)

	// ── Phase 2 & 3 commands ──────────────────────────────────────────────────
	commands.push(
		vscode.commands.registerCommand('gitbraid.stackView.refresh', () => stackTreeProvider.refresh()),

		// Force a re-query of PR status without waiting for the 60s poll.
		vscode.commands.registerCommand('gitbraid.refreshPRStatus', cmd(async () => {
			await prAwareness.refresh()
		})),

		// T69 — undo / redo for assignment-level operations.  Session-only,
		// in-memory.  No-ops when the corresponding stack is empty.
		vscode.commands.registerCommand('gitbraid.undoLastAssignment', cmd(async () => {
			if (!undoStack.canUndo()) {
				await vscode.window.showInformationMessage('GitBraid: nothing to undo.')
				return
			}
			const op = await undoStack.undo()
			if (op) {
				await vscode.window.setStatusBarMessage(`GitBraid: undid — ${op.label}`, 3000)
			}
		})),
		vscode.commands.registerCommand('gitbraid.redoLastAssignment', cmd(async () => {
			if (!undoStack.canRedo()) {
				await vscode.window.showInformationMessage('GitBraid: nothing to redo.')
				return
			}
			const op = await undoStack.redo()
			if (op) {
				await vscode.window.setStatusBarMessage(`GitBraid: redid — ${op.label}`, 3000)
			}
		})),

		vscode.commands.registerCommand('gitbraid.focusStackView', () => {
			stackView.reveal(undefined as never, { focus: true }).then(undefined, (e: unknown) => {
				log.error('focusStackView: ' + e)
			})
		}),

		vscode.commands.registerCommand('gitbraid.scm.commitBranch', cmd(async (arg: string | BranchNode) => {
			const name = arg instanceof BranchNode ? arg.entry.name : arg
			await scmManager.commitBranch(name)
		})),

		vscode.commands.registerCommand('gitbraid.scm.refreshAll', cmd(async () => {
			await scmManager.refreshAll()
		})),

		vscode.commands.registerCommand(
			'gitbraid.assignHunk',
			cmd(async (uri: vscode.Uri, hunkIndex: number) => {
				const rel = vscode.workspace.asRelativePath(uri, false)
				const stack = configService.getStack()
				if (stack.length === 0) {
					await vscode.window.showWarningMessage('No branches in the stack. Add a branch first.')
					return
				}
				const picked = await vscode.window.showQuickPick(
					stack.map((e) => ({ label: e.name, description: e.color })),
					{ placeHolder: `Assign hunk ${String(hunkIndex)} to branch` },
				)
				if (!picked) {
					return
				}
				// Capture a stable anchor for this hunk so later edits that
				// renumber the hunks don't silently apply the assignment to a
				// different line range (T8).
				const hunks = await diffEngine.getHunksForFile(workspaceRoot.fsPath, rel)
				const anchor = hunks[hunkIndex] ? anchorFor(hunks[hunkIndex]) : undefined
				const previousBranch = configService.getHunkAssignments(rel)?.get(hunkIndex)
				await configService.setHunkAssignment(rel, hunkIndex, picked.label, anchor)
				recordAssignHunk(undoStack, configService, rel, hunkIndex, picked.label, previousBranch, anchor)
				await vscode.window.showInformationMessage(`Hunk ${String(hunkIndex)} → ${picked.label}`)
				await overlayDiagnostics.refreshForUri(uri)
			}),
		),

		vscode.commands.registerCommand(
			'gitbraid.unassignHunk',
			cmd(async (uri: vscode.Uri, hunkIndex: number) => {
				const rel = vscode.workspace.asRelativePath(uri, false)
				const previousBranch = configService.getHunkAssignments(rel)?.get(hunkIndex)
				const previousAnchor = configService.getHunkAnchor(rel, hunkIndex)
				await configService.removeHunkAssignment(rel, hunkIndex)
				if (previousBranch !== undefined) {
					recordUnassignHunk(undoStack, configService, rel, hunkIndex, previousBranch, previousAnchor)
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
				const rel = vscode.workspace.asRelativePath(target, false)
				const stackUri = StackContentProvider.uriFor(rel)
				// Side-by-side diff against the on-disk file so the user sees
				// exactly which hunks are layered by branches above.
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
				const rel = vscode.workspace.asRelativePath(target, false)
				const diff = await stackResolver.getStackDiff(workspaceRoot.fsPath, rel)
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
				const rel = vscode.workspace.asRelativePath(target, false)
				const assignments = configService.getHunkAssignments(rel)
				if (!assignments || assignments.size === 0) {
					await vscode.window.showInformationMessage('No hunk assignments found for this file.')
					return
				}
				const worktreeDirs = new Map<string, string>()
				for (const entry of configService.getStack()) {
					worktreeDirs.set(entry.name, branchStack.getWorktreePath(entry.name).fsPath)
				}
				// Collect stored anchors for the reconciler (T8).  Missing
				// anchors are tolerated — those assignments fall back to the
				// raw index.
				const anchors = new Map<number, import('./configTypes').HunkAnchor>()
				for (const idx of assignments.keys()) {
					const a = configService.getHunkAnchor(rel, idx)
					if (a) anchors.set(idx, a)
				}
				const ok = await hunkRouter.routeFile(
					workspaceRoot.fsPath,
					rel,
					worktreeDirs,
					assignments,
					anchors,
				)
				if (ok) {
					await configService.clearHunkAssignments(rel)
					await vscode.window.showInformationMessage(`Routed hunks for ${rel} successfully.`)
				}
			}),
		),
	)

	// ─── Phase 4: Branch hierarchy & stacking ─────────────────────────────────
	const stackResolver = new StackResolver(configService, branchStack)
	const stackContentProvider = new StackContentProvider(stackResolver, workspaceRoot)
	const rebaseSvc = new RebaseSuggestionService(configService, branchStack)
	rebaseSvc.init(workspaceRoot)
	const stackCommands = new StackCommands(configService, branchStack, rebaseSvc, workspaceRoot)
	const rebaseRecovery = new RebaseRecovery()
	const stackShare = new StackShareService(configService, workspaceRoot)
	context.subscriptions.push(rebaseSvc, stackResolver, stackContentProvider, stackCommands, rebaseRecovery)

	// Watch every existing and future worktree for mid-rebase state so the
	// "rebase paused" toast fires the moment a rebase bails (T70).
	const watchAllWorktrees = () => {
		for (const entry of configService.getStack()) {
			if (branchStack.worktreeExists(entry.name)) {
				rebaseRecovery.watch(branchStack.getWorktreePath(entry.name).fsPath)
			}
		}
	}
	watchAllWorktrees()
	context.subscriptions.push(
		configService.onDidChangeStack(() => watchAllWorktrees()),
	)

	// Refresh any open gitbraid-stack: documents when assignments change.
	context.subscriptions.push(
		configService.onDidChangeAssignment((e) => {
			if (e.relativePath) stackContentProvider.refresh(e.relativePath)
		}),
	)

	// Helper: resolve a BranchNode argument, a branch-name string, or prompt
	// the user to pick one from the current stack.  Used by the T70 rebase
	// recovery commands so they share a single UX.
	const pickBranchWorktree = async (
		arg: string | BranchNode | undefined,
		placeholder: string,
	): Promise<string | undefined> => {
		const stack = configService.getStack()
		if (stack.length === 0) {
			await vscode.window.showWarningMessage('Stack is empty.')
			return undefined
		}
		const name = arg instanceof BranchNode
			? arg.entry.name
			: (arg ?? (await vscode.window.showQuickPick(
				stack.map((e) => e.name),
				{ placeHolder: placeholder },
			)))
		if (!name) return undefined
		if (!branchStack.worktreeExists(name)) {
			await vscode.window.showWarningMessage(`No worktree exists for "${name}".`)
			return undefined
		}
		return branchStack.getWorktreePath(name).fsPath
	}

	// ── Branch-overlay commands ────────────────────────────────────────────────
	commands.push(
		vscode.commands.registerCommand('gitbraid.assignFile', cmd(async (arg?: vscode.Uri | FloatingFileNode, allArgs?: vscode.Uri[]) => {
			// Collect initial URIs — multi-selection from Explorer passes all selected URIs as allArgs
			let uris: vscode.Uri[]
			if (allArgs && allArgs.length > 0) {
				uris = allArgs
			} else if (arg instanceof FloatingFileNode) {
				uris = arg.resourceUri ? [arg.resourceUri] : []
			} else if (arg instanceof vscode.Uri) {
				uris = [arg]
			} else {
				const active = vscode.window.activeTextEditor?.document.uri
				if (!active) {
					await vscode.window.showWarningMessage('No file selected to assign.')
					return
				}
				uris = [active]
			}
			if (uris.length === 0) {
				await vscode.window.showWarningMessage('No file selected to assign.')
				return
			}
			// Expand any folders to their contained files
			const targets: vscode.Uri[] = []
			for (const uri of uris) {
				const stat = await vscode.workspace.fs.stat(uri)
				if (stat.type === vscode.FileType.Directory) {
					const rel = vscode.workspace.asRelativePath(uri)
					const found = await vscode.workspace.findFiles(`${rel}/**`, '**/.git/**')
					for (const f of found) { targets.push(f) }
				} else {
					targets.push(uri)
				}
			}
			if (targets.length === 0) {
				void vscode.window.showWarningMessage('No files found to assign.')
				return
			}
			const stack = configService.getStack()
			if (stack.length === 0) {
				await vscode.window.showWarningMessage('No branches in the stack. Add a branch first.')
				return
			}
			const picked = await vscode.window.showQuickPick(
				stack.map((e) => ({ label: e.name, description: e.color })),
				{ placeHolder: 'Assign file to branch' }
			)
			if (!picked) {
				return
			}
			for (const target of targets) {
				const rel = vscode.workspace.asRelativePath(target)
				const previous = configService.getAssignment(rel)
				await configService.setAssignment(rel, picked.label)
				recordAssignFile(undoStack, configService, rel, picked.label, previous)
			}
			const msg = targets.length === 1
				? `Assigned ${vscode.workspace.asRelativePath(targets[0])} → ${picked.label}`
				: `Assigned ${targets.length} files → ${picked.label}`
			await vscode.window.showInformationMessage(msg)
		})),

		vscode.commands.registerCommand('gitbraid.unassignFile', cmd(async (arg?: vscode.Uri | FileNode) => {
			const target = arg instanceof FileNode ? arg.resourceUri : (arg ?? vscode.window.activeTextEditor?.document.uri)
			if (!target) {
				await vscode.window.showWarningMessage('No file selected to unassign.')
				return
			}
			const rel = vscode.workspace.asRelativePath(target)
			const previous = configService.getAssignment(rel)
			await configService.removeAssignment(rel)
			if (previous !== undefined) {
				recordUnassignFile(undoStack, configService, rel, previous)
			}
			await vscode.window.showInformationMessage(`Unassigned ${rel}`)
		})),

		vscode.commands.registerCommand('gitbraid.addStackBranch', cmd(async () => {
			const workspaceUri = vscode.workspace.workspaceFolders![0].uri
			const stackBranchNames = new Set(configService.getStack().map(e => e.name))

			// Build the initial local branch list
			const { local: localBranches } = await git.listBranches(workspaceUri)
			const availableLocal = localBranches.filter(b => !stackBranchNames.has(b))

			type BranchItem = vscode.QuickPickItem & { isNew?: boolean }

			// Build grouped items (new branch on top, then local separator +
			// locals, then remote separator + remotes).
			const buildItems = (value: string, remote: string[] = []): BranchItem[] => {
				const items: BranchItem[] = []
				const trimmed = value.trim()
				if (trimmed && !availableLocal.includes(trimmed) && !remote.includes(trimmed)) {
					items.push({
						label: `$(plus) ${trimmed}`,
						description: 'Create a new branch',
						detail: trimmed,
						isNew: true,
					})
				}
				const localMatches = availableLocal.filter(b => b.includes(trimmed))
				if (localMatches.length > 0) {
					items.push({ label: 'Local', kind: vscode.QuickPickItemKind.Separator })
					for (const b of localMatches) items.push({ label: b, description: 'local' })
				}
				const remoteMatches = remote.filter(b => !stackBranchNames.has(b))
				if (remoteMatches.length > 0) {
					items.push({ label: 'Remote', kind: vscode.QuickPickItemKind.Separator })
					for (const b of remoteMatches) items.push({ label: b, description: 'remote' })
				}
				return items
			}

			const qp = vscode.window.createQuickPick<BranchItem>()
			qp.placeholder = 'Branch name — pick existing or type a new name'
			qp.matchOnDescription = false
			qp.items = buildItems('')

			let remoteDebounce: ReturnType<typeof setTimeout> | undefined

			qp.onDidChangeValue((value) => {
				if (remoteDebounce) {
					clearTimeout(remoteDebounce)
				}
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

			if (remoteDebounce) {
				clearTimeout(remoteDebounce)
			}
			if (!name) {
				return
			}

			const stack = configService.getStack()
			// Detect the repo's default branch (main / master / trunk / develop)
			// instead of hard-coding "main" (T73 in the remediation plan).
			const defaultBranch = await detectDefaultBranch(workspaceUri).catch(() => 'main')
			const bases = [defaultBranch, ...stack.map((e) => e.name).filter(n => n !== defaultBranch)]
			const basePick = await vscode.window.showQuickPick(bases, { placeHolder: 'Base branch (used when creating a new branch)' })
			if (!basePick) {
				// Pressing Escape cancels the whole command rather than defaulting
				// to main — avoids creating a branch the user didn't confirm.
				return
			}
			await branchStack.addBranchToStack(name, basePick)
			await vscode.window.showInformationMessage(`Branch "${name}" added to stack`)
		})),

		vscode.commands.registerCommand('gitbraid.removeStackBranch', cmd(async (node?: BranchNode) => {
			const stack = configService.getStack()
			if (stack.length === 0) {
				await vscode.window.showWarningMessage('Stack is empty.')
				return
			}
			const picked = node instanceof BranchNode
				? node.entry.name
				: await vscode.window.showQuickPick(
					stack.map((e) => e.name),
					{ placeHolder: 'Remove branch from stack' }
				)
			if (!picked) {
				return
			}
			await branchStack.removeBranchFromStack(picked)
			await vscode.window.showInformationMessage(`Branch "${picked}" removed from stack`)
		})),

		vscode.commands.registerCommand('gitbraid.rebaseBranch', cmd(async (arg?: string | BranchNode) => {
			const stack = configService.getStack()
			if (stack.length === 0) {
				await vscode.window.showWarningMessage('Stack is empty.')
				return
			}
			const name = arg instanceof BranchNode
				? arg.entry.name
				: (arg ?? (await vscode.window.showQuickPick(
					stack.map((e) => e.name),
					{ placeHolder: 'Rebase branch onto its parent' },
				)))
			if (!name) {
				return
			}
			await rebaseSvc.rebaseBranch(name)
		})),

		// T67 — stack-wide operations.
		vscode.commands.registerCommand('gitbraid.pushStack', cmd(async () => {
			const stack = configService.getStack()
			if (stack.length === 0) {
				await vscode.window.showInformationMessage('Stack is empty — nothing to push.')
				return
			}
			// Offer --force-with-lease as an opt-in, not the default: safe
			// first-push vs "push over history" is a deliberate choice.
			const mode = await vscode.window.showQuickPick(
				[
					{ label: 'Push', description: 'Fast-forward or fail', force: false },
					{ label: 'Push with --force-with-lease', description: 'Rewrite upstream safely (post-rebase)', force: true },
				],
				{ placeHolder: `Push ${String(stack.length)} branch(es) to origin?` },
			)
			if (!mode) return
			await stackCommands.pushStack({ forceWithLease: mode.force })
		})),

		// T71 — share the stack layout with teammates via a committed
		// `.gitbraid/stack.json` file.
		vscode.commands.registerCommand('gitbraid.exportStack', cmd(async () => {
			const stack = configService.getStack()
			if (stack.length === 0) {
				await vscode.window.showInformationMessage('Stack is empty — nothing to export.')
				return
			}
			const filePath = await stackShare.exportToDisk()
			const rel = path.relative(workspaceRoot.fsPath, filePath)
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
			const shared = await stackShare.readSharedFile()
			if (!shared) {
				await vscode.window.showInformationMessage(
					`GitBraid: no shared stack found.  Run "GitBraid: Export Stack" on a colleague's machine and commit the resulting \`${SHARED_DIR}/${SHARED_FILE}\`.`,
				)
				return
			}
			const diff = stackShare.diffWithCurrent(shared)
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
			const summary = await stackShare.applyImport(shared, resolution)
			await vscode.window.showInformationMessage(
				`GitBraid: imported ${String(summary.addedBranches)} new branch(es), ${String(summary.addedAssignments)} new assignment(s), ` +
				`updated ${String(summary.updatedBranches)}/${String(summary.updatedAssignments)}, skipped ${String(summary.skipped)}.`,
			)
		})),

		// T70 — rebase conflict recovery.
		vscode.commands.registerCommand('gitbraid.rebaseAbort', cmd(async (arg?: string | BranchNode) => {
			const wt = await pickBranchWorktree(arg, 'Abort rebase in branch')
			if (!wt) return
			await rebaseRecovery.abort(wt)
		})),
		vscode.commands.registerCommand('gitbraid.rebaseContinue', cmd(async (arg?: string | BranchNode) => {
			const wt = await pickBranchWorktree(arg, 'Continue rebase in branch')
			if (!wt) return
			await rebaseRecovery.continue(wt)
		})),
		vscode.commands.registerCommand('gitbraid.openRebaseConflicts', cmd(async (arg?: string | BranchNode) => {
			const wt = await pickBranchWorktree(arg, 'Open conflicts for branch')
			if (!wt) return
			await rebaseRecovery.openConflicts(wt)
		})),

		vscode.commands.registerCommand('gitbraid.syncStack', cmd(async () => {
			const stack = configService.getStack()
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
			await stackCommands.syncStack()
		})),
	)

	// ─── Phase 5: Exported API & LM tools ─────────────────────────────────────
	const mbcExportedApi = new MbcApi(configService, branchStack, workspaceSync, workspaceRoot)
	context.subscriptions.push(...registerLmTools(mbcExportedApi))

	// ─── Phase 6: Worktree management commands ────────────────────────────────
	commands.push(
		vscode.commands.registerCommand('gitbraid.launchWindowForWorktree', cmd(async (node?: BranchNode) => {
			const branchName = node instanceof BranchNode ? node.entry.name
				: await vscode.window.showQuickPick(configService.getStack().map(e => e.name), { placeHolder: 'Open branch worktree in new window' })
			if (!branchName) return
			await vscode.commands.executeCommand('vscode.openFolder', branchStack.getWorktreePath(branchName), { forceNewWindow: true })
		})),
		vscode.commands.registerCommand('gitbraid.lockWorktree', cmd(async (node?: BranchNode) => {
			const branchName = node instanceof BranchNode ? node.entry.name
				: await vscode.window.showQuickPick(configService.getStack().map(e => e.name), { placeHolder: 'Lock worktree for branch' })
			if (!branchName) return
			await git.worktree.lock(branchStack.getWorktreePath(branchName).fsPath)
			await vscode.window.showInformationMessage(`Locked worktree for "${branchName}"`)
		})),
		vscode.commands.registerCommand('gitbraid.unlockWorktree', cmd(async (node?: BranchNode) => {
			const branchName = node instanceof BranchNode ? node.entry.name
				: await vscode.window.showQuickPick(configService.getStack().map(e => e.name), { placeHolder: 'Unlock worktree for branch' })
			if (!branchName) return
			await git.worktree.unlock(branchStack.getWorktreePath(branchName).fsPath)
			await vscode.window.showInformationMessage(`Unlocked worktree for "${branchName}"`)
		})),
		vscode.commands.registerCommand('gitbraid.copyToWorktree', cmd(async (node?: FileNode | FloatingFileNode) => {
			const fileUri = (node instanceof FileNode || node instanceof FloatingFileNode) ? node.resourceUri
				: vscode.window.activeTextEditor?.document.uri
			if (!fileUri) return
			const picked = await vscode.window.showQuickPick(configService.getStack().map(e => e.name), { placeHolder: 'Copy file to branch worktree' })
			if (!picked) return
			const rel = vscode.workspace.asRelativePath(fileUri)
			await vscode.workspace.fs.copy(fileUri, vscode.Uri.joinPath(branchStack.getWorktreePath(picked), rel), { overwrite: true })
			await vscode.window.showInformationMessage(`Copied ${rel} → ${picked}`)
		})),
		vscode.commands.registerCommand('gitbraid.moveToWorktree', cmd(async (node?: FileNode | FloatingFileNode) => {
			const fileUri = (node instanceof FileNode || node instanceof FloatingFileNode) ? node.resourceUri
				: vscode.window.activeTextEditor?.document.uri
			if (!fileUri) return
			const picked = await vscode.window.showQuickPick(configService.getStack().map(e => e.name), { placeHolder: 'Move file to branch worktree' })
			if (!picked) return
			const rel = vscode.workspace.asRelativePath(fileUri)
			await vscode.workspace.fs.copy(fileUri, vscode.Uri.joinPath(branchStack.getWorktreePath(picked), rel), { overwrite: true })
			await vscode.workspace.fs.delete(fileUri)
			if (node instanceof FileNode) {
				await configService.removeAssignment(rel)
			}
			await vscode.window.showInformationMessage(`Moved ${rel} → ${picked}`)
		})),
	)

	context.subscriptions.push(...commands)

	await filesExcludeWorktreesDir()
	// .gitignore stamping is owned by ConfigService._ensureGitignore (called
	// on every write). The separate activation-time writer used to race with
	// it and occasionally double-append; consolidated in T24.

	log.info('extension activation complete')
	return mbcExportedApi

}

/**
 * Best-effort detection of the repository's default branch.  Checks, in order:
 * 1. `refs/remotes/origin/HEAD` symbolic-ref (the GitHub/GitLab default).
 * 2. `git config init.defaultBranch` (user override).
 * 3. Falls back to the already-loaded current branch.
 * 4. Finally defaults to `main` if nothing is conclusive.
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

async function filesExcludeWorktreesDir () {
	const filesExclude = vscode.workspace.getConfiguration('files')
	log.info('197 ' + filesExclude.inspect)
	log.info('198 ' + JSON.stringify(filesExclude.inspect))
	log.info('199 ' + JSON.stringify(filesExclude.inspect('exclude'), null, 2))
	const insp = filesExclude.inspect('exclude')

	let  current: { [k: string]: boolean } = {}
	if (insp) {
		current = insp.workspaceValue as { [k: string]: boolean }
	}
	log.info('200 current=' + JSON.stringify(current))
	if (current) {
		log.info('200.1')
	}
	if (current?.['.worktrees/']) {
		log.info('201 current=' + JSON.stringify(current))
		log.info('Pattern \'.worktrees/\' already in files.exclude')
		return
	}
	if (!current) {
		current = {}
	}

	log.info('203 set current[.worktrees/] = true current=' + JSON.stringify(current))
	current['.worktrees/'] = true
	await vscode.workspace.getConfiguration('files').update('exclude', current, vscode.ConfigurationTarget.Workspace).then(() => {
		}, (e: unknown) => {
			log.error('206 Pattern \'.worktrees/\' not added to files.exclude: ' + e)
			throw e
		})
	log.info('Pattern \'.worktrees/\' added to files.exclude')
}

// ignoreWorktreesDir removed in T24: ConfigService._ensureGitignore is now
// the sole owner of the .worktrees/ entry in .gitignore.
