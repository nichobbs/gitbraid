import * as vscode from 'vscode'
import { git } from './gitFunctions'
import { log } from './channelLogger'
import { BranchFileDecorationProvider } from './fileDecorationProvider'
import { BranchNode, BranchStackTreeProvider, FileNode, FloatingFileNode, FloatingStatusBarItem } from './branchStackTreeProvider'
import { anchorFor } from './hunkRouter'
import { HunkCodeLensProvider, OverlayDiagnostics } from './hunkCodeLensProvider'
import { StackContentProvider } from './stackContentProvider'
import {
	recordAssignFile,
	recordUnassignFile,
	recordAssignHunk,
	recordUnassignHunk,
} from './undoStack'
import { SHARED_DIR, SHARED_FILE } from './stackShareService'
import { PRAwareness } from './prAwareness'
import * as path from 'node:path'
import { hideAssignedFile, unhideAssignedFile } from './gitIndex'
import { getDefaultGitRunner } from './gitRunner'
import { registerLmTools } from './lmTools'

import { FolderRegistry } from './folderRegistry'
import { FolderContext } from './folderContext'
import { GitBraidApiFacade } from './gitBraidApiFacade'
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
	// ─── Phase 1: Per-folder service graph ────────────────────────────────────
	//
	// Every git-eligible workspace folder gets its own `FolderContext`
	// (own `.worktrees/local-config.json`, own file-change bus, own SCM
	// manager, own rebase watcher, etc.).  The `FolderRegistry` owns the
	// lifecycle; each context's `initialize()` wires up all the per-folder
	// plumbing so SCM panels for every folder appear automatically.
	//
	// Multi-root phase 2 (merged): all user-facing surfaces follow the
	// active folder.  Tree view + status bar bind to the primary folder at
	// activation and re-source via `setContext(...)` on editor-focus
	// changes.  Decoration provider, CodeLens, and overlay diagnostics
	// resolve per-URI via the registry.  The `gitbraid-stack:` content
	// provider is a process-wide scheme singleton but registry-aware — URIs
	// carry a `?folder=` query that selects the target folder's resolver.
	// Commands route through `activeContext()` / `contextForUri()` so
	// operations land in the folder the user is editing.  See
	// `docs/remediation/00-overview.md` and `docs/adr/` for the full story.
	const registry = new FolderRegistry()
	const contexts = await registry.initializeAll()
	context.subscriptions.push(registry)

	if (contexts.length === 0) {
		log.warn('gitbraid: no git-eligible workspace folders; activation is idle')
		return
	}

	// Local aliases into the primary context — keeps the rest of activate()
	// readable and minimally changed against pre-refactor history.  The
	// `activeContext()` helper is used by commands to target the folder
	// the user is currently editing rather than always hitting primary.
	const primary = contexts[0]
	const workspaceRoot = primary.root
	const configService = primary.config
	const workspaceSync = primary.workspaceSync

	// Used by folder-aware commands (below) to target the folder the user
	// is currently editing rather than always hitting primary.
	const activeContext = (): FolderContext => registry.getActive() ?? primary

	/**
	 * Resolve the folder context that owns a given URI.  Falls back to the
	 * active folder (which falls back to primary) when the URI doesn't belong
	 * to any registered folder — e.g. an editor argument that came from a
	 * non-file scheme or a URI outside the workspace altogether.
	 */
	const contextForUri = (uri: vscode.Uri | undefined): FolderContext => {
		if (uri) {
			const ctx = registry.getForUri(uri)
			if (ctx) return ctx
		}
		return activeContext()
	}

	/** Relative path for a URI within its owning folder. */
	const relativePathIn = (ctx: FolderContext, uri: vscode.Uri): string => {
		return path.relative(ctx.root.fsPath, uri.fsPath).replaceAll('\\', '/')
	}

	// ─── Phase 2: SCM Integration & UI ────────────────────────────────────────
	//
	// The SCM manager, rebase recovery watcher, stack resolver / content
	// provider, rebase service, stack commands, share service, and exported
	// API instance all live inside each `FolderContext` (so multi-folder
	// workspaces get one of each per folder automatically).  Commands route
	// through `activeContext()` / `contextForUri()` so operations land in the
	// folder the user is editing.  UI singletons (tree provider, status bar)
	// bind to the primary folder at activation and follow the active folder
	// via `setContext(...)` on editor-focus changes.
	const stackResolver = primary.stackResolver
	const diffEngine = primary.diffEngine

	// Decoration provider is multi-root-aware: it resolves the owning
	// folder per-URI via the registry, so decorations render correctly
	// for files in any folder regardless of which is "primary".
	const decorationProvider = new BranchFileDecorationProvider(configService, workspaceSync, registry)
	context.subscriptions.push(decorationProvider)

	// PR awareness — feature-detects the GitHub PR extension at runtime.
	// Absent / inactive / unexpected-API cases all fall back to "no
	// decorations"; gated on `gitbraid.prDecorationsEnabled`.
	const prAwareness = new PRAwareness()
	context.subscriptions.push(prAwareness)
	prAwareness.start()

	const stackTreeProvider = new BranchStackTreeProvider(
		configService,
		workspaceSync,
		(rel, newBranch, previous) => {
			const ctx = activeContext()
			recordAssignFile(ctx.undoStack, ctx.config, rel, newBranch, previous)
		},
		(rel, previous) => {
			const ctx = activeContext()
			recordUnassignFile(ctx.undoStack, ctx.config, rel, previous)
		},
		prAwareness,
		primary.root,
		primary.healthSvc,
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

	// ── Smart auto-assign on new floating file ────────────────────────────
	// When a file first becomes floating, check if all sibling files in the
	// same directory belong to a single branch — if so, offer to assign it
	// there too.  Shown once per session per path to avoid repeat prompts.
	const _wireAutoAssign = (ctx: FolderContext) => {
		const suggestedPaths = new Set<string>()
		ctx.workspaceSync.onDidFloatFile(async ({ relativePath }) => {
			if (suggestedPaths.has(relativePath)) return
			suggestedPaths.add(relativePath)

			const dir = path.dirname(relativePath.replaceAll('\\', '/'))
			if (!dir || dir === '.') return  // root-level file — no siblings to look at

			const assignments = ctx.config.getAllAssignments()
			const siblingBranches = new Set(
				Object.entries(assignments)
					.filter(([p]) => {
						const pd = path.dirname(p.replaceAll('\\', '/'))
						return pd === dir && p !== relativePath
					})
					.map(([, b]) => b),
			)
			if (siblingBranches.size !== 1) return

			const [branch] = siblingBranches
			const choice = await vscode.window.showInformationMessage(
				`New file \`${relativePath}\` — assign to \`${branch}\`?`,
				'Assign',
				'Later',
			)
			if (choice === 'Assign') {
				await ctx.config.setAssignment(relativePath, branch)
				recordAssignFile(ctx.undoStack, ctx.config, relativePath, branch, undefined)
			}
		})
	}
	for (const ctx of contexts) _wireAutoAssign(ctx)
	context.subscriptions.push(
		registry.onDidChangeFolders((e) => {
			for (const addedCtx of e.added) _wireAutoAssign(addedCtx)
		}),
	)

	// ── Multi-root phase 2: re-source UI on active-folder switch ──────────
	// Tree provider + status bar hold references to the primary folder's
	// services.  When the user moves focus to an editor inside a different
	// folder, swap their bindings so the UI reflects the folder being
	// edited.  Decoration provider, CodeLens, and overlay diagnostics are
	// registry-aware per-URI so they need no rebinding.
	const updateActive = () => {
		const ctx = registry.getActive() ?? primary
		stackTreeProvider.setContext(ctx.config, ctx.workspaceSync, ctx.root, ctx.healthSvc)
		statusBar.setContext(ctx.workspaceSync, ctx.config)
	}
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(() => updateActive()),
		registry.onDidChangeFolders(() => updateActive()),
	)

	// ─── Phase 3: Chunk-Level Assignment ──────────────────────────────────────
	// `diffEngine` / `hunkRouter` are per-folder.  The CodeLens and overlay
	// diagnostics singletons route per-URI via the registry so lenses /
	// Problems entries for files in any folder use that folder's diff
	// engine + config.  The fallback pair (primary's diff engine + config)
	// services URIs outside every known folder, which is how tests that
	// construct these without a registry continue to work.
	const hunkCodeLens = new HunkCodeLensProvider(diffEngine, configService, registry)
	const overlayDiagnostics = new OverlayDiagnostics(diffEngine, configService, registry)

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

		// Set the colour of a branch in the stack.
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

			if (!branchName) { return }

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
			if (!selection) { return }

			let color = selection.color
			if (color === '') {
				const input = await vscode.window.showInputBox({
					prompt: `Hex colour for "${branchName}"`,
					placeHolder: '#a0c4ff',
					validateInput: (v) =>
						/^#[0-9a-fA-F]{6}$/.test(v) ? undefined : 'Must be a 6-digit hex colour, e.g. #4ec9b0',
				})
				if (!input) { return }
				color = input
			}

			await ctx.config.setBranchColor(branchName, color)
		})),

		// Re-apply skip-worktree / exclude hiding for all currently assigned
		// files.  Useful after a repo clone, or for files assigned before the
		// hiding logic was introduced.
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

		// Multi-root: show which folder the extension is targeting.  In
		// multi-folder workspaces the picker doubles as a switcher — picking
		// a folder opens one of its README/package.json/first-level file so
		// the active-editor heuristic follows the selection.  Focus swaps
		// happen automatically when the user opens any file in another
		// folder; this command just surfaces the current choice and offers
		// an explicit switch.
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
			// Reveal the folder in the Explorer to give the user a concrete
			// hand-off.  The active-editor heuristic will pick it up when
			// they open a file; `setContext` is also called directly so the
			// tree view and status bar update immediately.
			stackTreeProvider.setContext(picked.ctx.config, picked.ctx.workspaceSync, picked.ctx.root, picked.ctx.healthSvc)
			statusBar.setContext(picked.ctx.workspaceSync, picked.ctx.config)
			await vscode.commands.executeCommand('revealInExplorer', picked.ctx.root)
		})),

		// Force a re-query of PR status without waiting for the 60s poll.
		vscode.commands.registerCommand('gitbraid.refreshPRStatus', cmd(async () => {
			await prAwareness.refresh()
		})),

		// T69 — undo / redo for assignment-level operations.  Session-only,
		// in-memory.  No-ops when the corresponding stack is empty.
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

		vscode.commands.registerCommand('gitbraid.copyStackDiagram', cmd(async () => {
			const ctx = activeContext()
			const stack = ctx.config.getStack()
			if (stack.length === 0) {
				await vscode.window.showInformationMessage('Stack is empty — nothing to diagram.')
				return
			}
			// Gather ahead counts and PR info for each branch
			const runner = getDefaultGitRunner()
			const lines: string[] = []
			// Find the root base (the branch at the bottom of the stack's base)
			const rootBase = stack[0].base
			lines.push(rootBase)
			// Build parent→children map for tree rendering
			const childrenOf = new Map<string, string[]>()
			childrenOf.set(rootBase, [])
			for (const entry of stack) {
				if (!childrenOf.has(entry.base)) childrenOf.set(entry.base, [])
				childrenOf.get(entry.base)!.push(entry.name)
				childrenOf.set(entry.name, [])
			}
			// Collect ahead counts
			const aheadCounts = new Map<string, number>()
			for (const entry of stack) {
				try {
					const { stdout } = await runner.run(
						['rev-list', '--count', `${entry.base}..${entry.name}`],
						{ cwd: ctx.root.fsPath },
					)
					aheadCounts.set(entry.name, parseInt(stdout.trim(), 10) || 0)
				} catch {
					aheadCounts.set(entry.name, 0)
				}
			}
			// Render tree recursively
			const renderChildren = (parent: string, prefix: string): void => {
				const children = childrenOf.get(parent) ?? []
				for (let i = 0; i < children.length; i++) {
					const branch = children[i]
					const isLast = i === children.length - 1
					const connector = isLast ? '└── ' : '├── '
					const childPrefix = isLast ? '    ' : '│   '
					const ahead = aheadCounts.get(branch)
					const aheadStr = ahead !== undefined && ahead > 0 ? ` [↑${ahead}]` : ''
					const prInfo = prAwareness.getForBranch(branch)
					const prStr = prInfo
						? ` PR #${String(prInfo.number)} ${prInfo.state === 'open' ? '✓' : prInfo.state === 'draft' ? '(draft)' : prInfo.state === 'merged' ? '(merged)' : '(closed)'}`
						: ' (no PR)'
					lines.push(`${prefix}${connector}${branch}${aheadStr}${prStr}`)
					renderChildren(branch, prefix + childPrefix)
				}
			}
			renderChildren(rootBase, '')
			const diagram = lines.join('\n')
			await vscode.env.clipboard.writeText(diagram)
			await vscode.window.showInformationMessage('GitBraid: stack diagram copied to clipboard.')
		})),

		vscode.commands.registerCommand('gitbraid.focusStackView', () => {
			stackView.reveal(undefined as never, { focus: true }).then(undefined, (e: unknown) => {
				log.error('focusStackView: ' + e)
			})
		}),

		vscode.commands.registerCommand('gitbraid.scm.commitBranch', cmd(async (arg: string | BranchNode) => {
			const name = arg instanceof BranchNode ? arg.entry.name : arg
			await activeContext().scmManager.commitBranch(name)
		})),

		vscode.commands.registerCommand('gitbraid.scm.refreshAll', cmd(async () => {
			await activeContext().scmManager.refreshAll()
		})),

		vscode.commands.registerCommand(
			'gitbraid.assignHunk',
			cmd(async (uri: vscode.Uri, hunkIndex: number) => {
				// Resolve to the folder that owns this file — hunk assignments
				// live in the URI's folder's config, not primary's.
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
				if (!picked) {
					return
				}
				// Capture a stable anchor for this hunk so later edits that
				// renumber the hunks don't silently apply the assignment to a
				// different line range (T8).
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
				// `gitbraid-stack:` URIs carry the target folder in the query
				// string so the scheme singleton dispatches to the right
				// folder's `StackResolver` in multi-root workspaces.
				const ctx = contextForUri(target)
				const rel = relativePathIn(ctx, target)
				const stackUri = StackContentProvider.uriFor(rel, ctx.root)
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
			'gitbraid.openStackDiff',
			cmd(async (uri?: vscode.Uri) => {
				const target = uri ?? vscode.window.activeTextEditor?.document.uri
				if (!target) {
					await vscode.window.showWarningMessage('Open a file first to see its PR-ready stack diff.')
					return
				}
				const ctx = contextForUri(target)
				const rel = relativePathIn(ctx, target)
				const stack = ctx.config.getStack()
				if (stack.length === 0) {
					await vscode.window.showWarningMessage('No branches in the stack.')
					return
				}
				const base = stack[0].base
				const top = stack.at(-1)!.name
				const baseUri = StackContentProvider.baseUriFor(rel, base, ctx.root)
				const stackUri = StackContentProvider.uriFor(rel, ctx.root)
				await vscode.commands.executeCommand(
					'vscode.diff',
					baseUri,
					stackUri,
					`${rel} (${base} ↔ ${top})`,
				)
			}),
		),

		vscode.commands.registerCommand(
			'gitbraid.previewRouting',
			cmd(async (uri?: vscode.Uri) => {
				const target = uri ?? vscode.window.activeTextEditor?.document.uri
				if (!target) {
					await vscode.window.showWarningMessage('No file active to preview routing for.')
					return
				}
				const ctx = contextForUri(target)
				const rel = relativePathIn(ctx, target)
				const assignments = ctx.config.getHunkAssignments(rel)
				if (!assignments || assignments.size === 0) {
					await vscode.window.showInformationMessage('No hunk assignments found for this file.')
					return
				}
				const hunks = await ctx.diffEngine.getHunksForFile(ctx.root.fsPath, rel)
				if (hunks.length === 0) {
					await vscode.window.showInformationMessage(`No diff hunks found for ${rel}.`)
					return
				}

				// Collect patches per branch
				const byBranch = new Map<string, typeof hunks>()
				for (const [idx, branch] of assignments) {
					const hunk = hunks[idx]
					if (!hunk) continue
					const list = byBranch.get(branch) ?? []
					list.push(hunk)
					byBranch.set(branch, list)
				}
				if (byBranch.size === 0) {
					await vscode.window.showInformationMessage('No routable hunk assignments found.')
					return
				}

				// Dry-run each branch's patch via `git apply --check`
				const runner = getDefaultGitRunner()
				const results: Array<{ branch: string, hunkCount: number, ok: boolean }> = []
				for (const [branch, branchHunks] of byBranch) {
					const patch = ctx.hunkRouter.buildPatch(branchHunks)
					const worktreeUri = ctx.branchStack.worktreeExists(branch)
						? ctx.branchStack.getWorktreePath(branch)
						: ctx.root
					const { exitCode } = await runner.run(
						['apply', '--check', '-'],
						{ cwd: worktreeUri.fsPath, input: patch },
					)
					results.push({ branch, hunkCount: branchHunks.length, ok: exitCode === 0 })
				}

				const allOk = results.every((r) => r.ok)
				const lines = results.map((r) =>
					`${r.ok ? '✓' : '✗'} ${r.branch}: ${String(r.hunkCount)} hunk(s)${r.ok ? '' : ' — would fail to apply'}`,
				)
				const summary = lines.join('\n')

				const actions = allOk
					? ['Apply Routing', 'Show Patches', 'Cancel']
					: ['Show Patches', 'Try Anyway', 'Cancel']
				const title = allOk
					? `Routing preview for ${rel} — all patches apply cleanly`
					: `Routing preview for ${rel} — some patches would fail`

				const choice = await vscode.window.showInformationMessage(
					`${title}\n\n${summary}`,
					...actions,
				)

				if (choice === 'Apply Routing' || choice === 'Try Anyway') {
					await vscode.commands.executeCommand('gitbraid.routeHunks', target)
				} else if (choice === 'Show Patches') {
					const sections: string[] = [`// Routing preview: ${rel}\n`]
					for (const [branch, branchHunks] of byBranch) {
						sections.push(`// ── ${branch} ──────────────────\n`)
						sections.push(ctx.hunkRouter.buildPatch(branchHunks))
					}
					const doc = await vscode.workspace.openTextDocument({
						language: 'diff',
						content: sections.join('\n'),
					})
					await vscode.window.showTextDocument(doc, { preview: true })
				}
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
				// Collect stored anchors for the reconciler (T8).  Missing
				// anchors are tolerated — those assignments fall back to the
				// raw index.
				const anchors = new Map<number, import('./configTypes').HunkAnchor>()
				for (const idx of assignments.keys()) {
					const a = ctx.config.getHunkAnchor(rel, idx)
					if (a) anchors.set(idx, a)
				}
				const ok = await ctx.hunkRouter.routeFile(
					ctx.root.fsPath,
					rel,
					worktreeDirs,
					assignments,
					anchors,
				)
				if (ok) {
					await ctx.config.clearHunkAssignments(rel)
					await vscode.window.showInformationMessage(`Routed hunks for ${rel} successfully.`)
				}
			}),
		),
	)

	// ─── Phase 4: Branch hierarchy & stacking ─────────────────────────────────
	//
	// `stackResolver`, `rebaseSvc`, `stackCommands`, `rebaseRecovery`, and
	// `stackShare` all live inside each `FolderContext`.  The rebase watcher
	// is wired up inside `FolderContext.initialize()`.  The stack-content
	// provider is a process-wide scheme singleton, but is registry-aware: it
	// reads the target folder from the URI's `?folder=` query and dispatches
	// to the owning folder's `StackResolver`.  Callers of `uriFor(...)` must
	// pass the target folder's root in multi-root workspaces; the primary
	// root serves as a fallback for URIs with no folder query.
	const stackContentProvider = new StackContentProvider(registry, workspaceRoot, stackResolver)
	context.subscriptions.push(stackContentProvider)

	// Refresh any open gitbraid-stack: documents when assignments change.
	// Subscribe to every folder's config so refreshes fire with the right
	// folder root for each URI.
	const contentRefreshSubs = new Map<string, vscode.Disposable>()
	const wireContentRefresh = (ctx: FolderContext) => {
		contentRefreshSubs.set(ctx.root.fsPath, ctx.config.onDidChangeAssignment((e) => {
			if (e.relativePath) stackContentProvider.refresh(e.relativePath, ctx.root)
		}))
	}
	for (const ctx of registry.getAll()) {
		wireContentRefresh(ctx)
	}
	context.subscriptions.push(
		registry.onDidChangeFolders((e) => {
			for (const ctx of e.added) wireContentRefresh(ctx)
			for (const ctx of e.removed) {
				contentRefreshSubs.get(ctx.root.fsPath)?.dispose()
				contentRefreshSubs.delete(ctx.root.fsPath)
			}
		}),
		new vscode.Disposable(() => {
			for (const d of contentRefreshSubs.values()) d.dispose()
			contentRefreshSubs.clear()
		}),
	)

	// Helper: resolve a BranchNode argument, a branch-name string, or prompt
	// the user to pick one from the current stack.  Used by the T70 rebase
	// recovery commands so they share a single UX.

	/**
	 * Resolve a branch name from a command argument, which may be:
	 * - a plain string (e.g. from statusBarCommands)
	 * - a SourceControl-like object with an `id` of the form `gitbraid-<branch>`
	 *   (from scm/title menu items)
	 * - undefined — in which case we show a quick-pick
	 */
	const resolveBranchNameArg = async (arg: unknown, placeholder: string): Promise<string | undefined> => {
		if (typeof arg === 'string') return arg
		if (arg && typeof arg === 'object' && 'id' in arg) {
			const id = (arg as { id?: unknown }).id
			if (typeof id === 'string' && id.startsWith('gitbraid-')) {
				return id.slice('gitbraid-'.length)
			}
		}
		const ctx = activeContext()
		const stack = ctx.config.getStack()
		if (stack.length === 0) {
			await vscode.window.showWarningMessage('Stack is empty.')
			return undefined
		}
		return vscode.window.showQuickPick(stack.map((e) => e.name), { placeHolder: placeholder })
	}

	const resolveActiveBranchWorktree = async (
		arg: string | BranchNode | undefined,
		placeholder: string,
	): Promise<{ ctx: FolderContext, worktreeDir: string } | undefined> => {
		const ctx = activeContext()
		const stack = ctx.config.getStack()
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
		if (!ctx.branchStack.worktreeExists(name)) {
			await vscode.window.showWarningMessage(`No worktree exists for "${name}".`)
			return undefined
		}
		return { ctx, worktreeDir: ctx.branchStack.getWorktreePath(name).fsPath }
	}

	// ── Branch-overlay commands ────────────────────────────────────────────────

	/** Extract a file URI from Explorer (vscode.Uri), SCM view (SourceControlResourceState),
	 *  or a tree node (FileNode / FloatingFileNode). */
	const extractFileUri = (a: unknown): vscode.Uri | undefined => {
		if (a instanceof vscode.Uri) return a
		if (a && typeof a === 'object' && 'resourceUri' in a) {
			const uri = (a as { resourceUri?: unknown }).resourceUri
			if (uri instanceof vscode.Uri) return uri
		}
		return undefined
	}

	commands.push(
		vscode.commands.registerCommand('gitbraid.assignFile', cmd(async (arg?: unknown, allArgs?: unknown[]) => {
			// Collect initial URIs — multi-selection from Explorer or SCM view passes allArgs
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
			// Expand any folders to their contained changed files.
			// Uses `git ls-files` so .gitignore is honoured and only modified /
			// untracked files are included — avoids crawling node_modules etc.
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
			// Use the first target's folder to drive the branch picker.
			// Multi-file selection that spans folders is an edge case — the
			// picker defaults to the first target's folder, and targets
			// outside that folder are reassigned inside THEIR own folder
			// (branch names have to match).  Skipping sensibly if they don't.
			const pickerCtx = contextForUri(targets[0])
			const stack = pickerCtx.config.getStack()
			// Also offer the currently checked-out branch so users can assign
			// files to their active workspace branch without them appearing floating.
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
			const picked = await vscode.window.showQuickPick(
				pickItems,
				{ placeHolder: 'Assign file to branch' }
			)
			if (!picked) {
				return
			}
			const runner = getDefaultGitRunner()
			for (const target of targets) {
				const ctx = contextForUri(target)
				const rel = relativePathIn(ctx, target)
				// The chosen branch must exist in the target's own folder
				// (either in its stack, or as its current workspace branch).
				// If it doesn't (cross-folder selection), skip with a warning.
				const branchInStack = !!ctx.config.getBranch(picked.label)
				if (!branchInStack && picked.label !== currentBranch) {
					log.warn(`assignFile: skipping ${rel} — branch "${picked.label}" not in folder ${ctx.root.fsPath}`)
					continue
				}
				const previous = ctx.config.getAssignment(rel)
				await ctx.config.setAssignment(rel, picked.label)
				recordAssignFile(ctx.undoStack, ctx.config, rel, picked.label, previous)
				// Hide assigned file from main git status only when a real
				// worktree exists for the branch in the target's folder.
				if (branchInStack && ctx.branchStack.worktreeExists(picked.label)) {
					await hideAssignedFile(runner, ctx.root.fsPath, rel)
				}
			}
			const msg = targets.length === 1
				? `Assigned ${vscode.workspace.asRelativePath(targets[0])} → ${picked.label}`
				: `Assigned ${targets.length} files → ${picked.label}`
			await vscode.window.showInformationMessage(msg)
		})),

		// gitbraid.assignFolder is a dedicated entry point for folder context
		// menus so the label reads "Assign Folder to Branch" instead of "Assign
		// File to Branch".  It delegates to the same assignFile logic which
		// already handles directory expansion.
		vscode.commands.registerCommand('gitbraid.assignFolder', cmd(async (arg?: unknown, allArgs?: unknown[]) => {
			await vscode.commands.executeCommand('gitbraid.assignFile', arg, allArgs)
		})),

		vscode.commands.registerCommand('gitbraid.unassignFile', cmd(async (arg?: unknown) => {
			const target = arg instanceof FileNode ? arg.resourceUri
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
				// Undo skip-worktree / excludes that assignFile may have set.
				await unhideAssignedFile(getDefaultGitRunner(), ctx.root.fsPath, rel)
			}
			await vscode.window.showInformationMessage(`Unassigned ${rel}`)
		})),

		// gitbraid.unassignFolder — removes assignments for all assigned files
		// under a folder, mirroring assignFolder.  Only files that currently
		// have an assignment are touched.
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
				await vscode.window.showInformationMessage(`Unassigned ${count} file${count === 1 ? '' : 's'} under ${relFolder}`)
			}
		})),

		vscode.commands.registerCommand('gitbraid.addStackBranch', cmd(async () => {
			// Multi-root: add to whichever folder the user is currently
			// editing (not the first workspace folder).
			const ctx = activeContext()
			const workspaceUri = ctx.root
			const stackBranchNames = new Set(ctx.config.getStack().map(e => e.name))

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

			const stack = ctx.config.getStack()
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
			await ctx.branchStack.addBranchToStack(name, basePick)
			await vscode.window.showInformationMessage(`Branch "${name}" added to stack in ${path.basename(ctx.root.fsPath)}`)
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
					{ placeHolder: 'Remove branch from stack' }
				)
			if (!picked) {
				return
			}
			await ctx.branchStack.removeBranchFromStack(picked)
			await vscode.window.showInformationMessage(`Branch "${picked}" removed from stack`)
		})),

		// ── Add scratch worktree ──────────────────────────────────────────────
		// Creates a dedicated scratch worktree — a parking area for files that
		// should be kept out of the way but not committed to any branch.
		vscode.commands.registerCommand('gitbraid.addScratchWorktree', cmd(async () => {
			const ctx = activeContext()
			const SCRATCH_NAME = 'gitbraid-scratch'
			if (ctx.config.getStack().some((e) => e.name === SCRATCH_NAME)) {
				await vscode.window.showInformationMessage('A scratch worktree already exists.')
				return
			}
			const defaultBranch = await detectDefaultBranch(workspaceUri).catch(() => 'main')
			await ctx.branchStack.addBranchToStack(SCRATCH_NAME, defaultBranch, '#888888')
			// Mark the new entry as scratch in config.
			await ctx.config.setScratch(SCRATCH_NAME, true)
			await vscode.window.showInformationMessage(
				`Scratch area "${SCRATCH_NAME}" created. Assign files to it to park them out of the way.`,
			)
		})),

		// ── Reset branch ──────────────────────────────────────────────────────
		// Unassigns every file from a branch, restores those files in the branch's
		// worktree to HEAD (discarding uncommitted changes), and un-hides them in
		// the main workspace so they appear as normal floating changes again.
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

			const allAssignments = ctx.config.getAllAssignments()
			const assignedFiles = Object.entries(allAssignments)
				.filter(([, b]) => b === picked)
				.map(([rel]) => rel)

			if (assignedFiles.length === 0) {
				await vscode.window.showInformationMessage(
					`Branch "${picked}" has no assigned files.`,
				)
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
						// Restore file to HEAD in the worktree (discards uncommitted edits).
						if (wtDir) {
							try {
								await runner.run(
									['checkout', 'HEAD', '--', rel],
									{ cwd: wtDir },
								)
							} catch {
								// File may not exist in HEAD yet (untracked in worktree) — skip restore
							}
						}
						// Undo skip-worktree / .git/info/exclude so main workspace sees the file again.
						await unhideAssignedFile(runner, ctx.root.fsPath, rel)
						// Remove the assignment record.
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
				: (arg ?? (await vscode.window.showQuickPick(
					stack.map((e) => e.name),
					{ placeHolder: 'Rebase branch onto its parent' },
				)))
			if (!name) {
				return
			}
			await ctx.rebaseSvc.rebaseBranch(name)
		})),

		// T67 — stack-wide operations.
		vscode.commands.registerCommand('gitbraid.pushStack', cmd(async () => {
			const ctx = activeContext()
			const stack = ctx.config.getStack()
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
			await ctx.stackCommands.pushStack({ forceWithLease: mode.force })
		})),

		// T71 — share the stack layout with teammates via a committed
		// `.gitbraid/stack.json` file.
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

		// T70 — rebase conflict recovery.
		vscode.commands.registerCommand('gitbraid.rebaseAbort', cmd(async (arg?: string | BranchNode) => {
			const resolved = await resolveActiveBranchWorktree(arg, 'Abort rebase in branch')
			if (!resolved) return
			await resolved.ctx.rebaseRecovery.abort(resolved.worktreeDir)
			void resolved.ctx.healthSvc.refresh()
		})),
		vscode.commands.registerCommand('gitbraid.rebaseContinue', cmd(async (arg?: string | BranchNode) => {
			const resolved = await resolveActiveBranchWorktree(arg, 'Continue rebase in branch')
			if (!resolved) return
			await resolved.ctx.rebaseRecovery.continue(resolved.worktreeDir)
			void resolved.ctx.healthSvc.refresh()
		})),
		vscode.commands.registerCommand('gitbraid.openRebaseConflicts', cmd(async (arg?: string | BranchNode) => {
			const resolved = await resolveActiveBranchWorktree(arg, 'Open conflicts for branch')
			if (!resolved) return
			await resolved.ctx.rebaseRecovery.openConflicts(resolved.worktreeDir)
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

		// ── Per-branch SCM commands ───────────────────────────────────────────

		vscode.commands.registerCommand('gitbraid.scm.pushBranch', cmd(async (arg?: unknown) => {
			const branchName = await resolveBranchNameArg(arg, 'Push branch to origin')
			if (!branchName) return
			await activeContext().scmManager.pushBranch(branchName)
		})),

		vscode.commands.registerCommand('gitbraid.scm.pullBranch', cmd(async (arg?: unknown) => {
			const branchName = await resolveBranchNameArg(arg, 'Pull branch from origin')
			if (!branchName) return
			await activeContext().scmManager.pullBranch(branchName)
		})),

		vscode.commands.registerCommand('gitbraid.scm.syncBranch', cmd(async (arg?: unknown) => {
			const branchName = await resolveBranchNameArg(arg, 'Sync branch (pull then push)')
			if (!branchName) return
			await activeContext().scmManager.syncBranch(branchName)
		})),

		vscode.commands.registerCommand('gitbraid.scm.stashBranch', cmd(async (arg?: unknown) => {
			const branchName = await resolveBranchNameArg(arg, 'Stash changes in branch')
			if (!branchName) return
			await activeContext().scmManager.stashBranch(branchName)
		})),

		vscode.commands.registerCommand('gitbraid.scm.stageFile', cmd(async (resourceState?: unknown) => {
			const uri = (resourceState as { resourceUri?: vscode.Uri } | undefined)?.resourceUri
			if (!uri) return
			await activeContext().scmManager.stageFile(uri.fsPath)
		})),

		vscode.commands.registerCommand('gitbraid.scm.unstageFile', cmd(async (resourceState?: unknown) => {
			const uri = (resourceState as { resourceUri?: vscode.Uri } | undefined)?.resourceUri
			if (!uri) return
			await activeContext().scmManager.unstageFile(uri.fsPath)
		})),

		vscode.commands.registerCommand('gitbraid.scm.stageAll', cmd(async (arg?: unknown) => {
			const branchName = await resolveBranchNameArg(arg, 'Stage all changes in branch')
			if (!branchName) return
			await activeContext().scmManager.stageAll(branchName)
		})),

		// AI-assisted commit message generation.
		// Gets the staged diff (or working-tree diff if nothing staged) from the
		// branch's worktree and asks the active Copilot model for a message.
		vscode.commands.registerCommand('gitbraid.scm.generateCommitMessage', cmd(async (arg?: unknown) => {
			const branchName = await resolveBranchNameArg(arg, 'Generate commit message for branch')
			if (!branchName) return

			const ctx = activeContext()
			if (!ctx.branchStack.worktreeExists(branchName)) {
				await vscode.window.showWarningMessage(`No worktree for "${branchName}"`)
				return
			}
			const worktreeDir = ctx.branchStack.getWorktreePath(branchName).fsPath
			const runner = getDefaultGitRunner()

			// Prefer staged changes; fall back to unstaged
			const staged = await runner.run(['diff', '--cached'], { cwd: worktreeDir })
			const diff = staged.stdout.trim()
				? staged.stdout
				: (await runner.run(['diff'], { cwd: worktreeDir })).stdout

			if (!diff.trim()) {
				await vscode.window.showInformationMessage(`No changes in "${branchName}" to generate a message for.`)
				return
			}

			// Select the best available language model
			const models = await vscode.lm.selectChatModels().catch(() => [] as vscode.LanguageModelChat[])
			const model = models[0]
			if (!model) {
				await vscode.window.showWarningMessage(
					'No language model available. Install GitHub Copilot and sign in to use AI commit message generation.',
				)
				return
			}

			let generatedMessage = ''
			const cts = new vscode.CancellationTokenSource()
			try {
				await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: `Generating commit message for "${branchName}"…`, cancellable: true },
					async (_progress, token) => {
						token.onCancellationRequested(() => cts.cancel())
						const messages = [
							vscode.LanguageModelChatMessage.User(
								'Generate a concise git commit message in Conventional Commits format for the following diff. ' +
								'Respond with ONLY the commit message (subject line optionally followed by a blank line and a body). ' +
								'Do not include any explanation, code blocks, or markdown.\n\n' +
								diff.slice(0, 12_000),
							),
						]
						const response = await model.sendRequest(messages, {}, cts.token)
						for await (const chunk of response.text) {
							generatedMessage += chunk
						}
					},
				)
			} finally {
				cts.dispose()
			}

			generatedMessage = generatedMessage.trim()
			if (generatedMessage) {
				ctx.scmManager.setInputBoxValue(branchName, generatedMessage)
			}
		})),
	)

	// ─── Phase 5: Exported API & LM tools ─────────────────────────────────────
	// The exported API is a facade over `FolderRegistry` that delegates to
	// whichever folder's `GitBraidApi` is active.  Downstream consumers —
	// `vscode.extensions.getExtension(...).exports`, language-model tools,
	// future MCP clients — see a single API object whose operations target
	// the folder the user is currently editing.
	const gitbraidExportedApi = new GitBraidApiFacade(registry)
	context.subscriptions.push(gitbraidExportedApi, ...registerLmTools(gitbraidExportedApi))

	// ─── Phase 6: Worktree management commands ────────────────────────────────
	commands.push(
		vscode.commands.registerCommand('gitbraid.launchWindowForWorktree', cmd(async (node?: BranchNode) => {
			const ctx = activeContext()
			const branchName = node instanceof BranchNode ? node.entry.name
				: await vscode.window.showQuickPick(ctx.config.getStack().map(e => e.name), { placeHolder: 'Open branch worktree in new window' })
			if (!branchName) return
			await vscode.commands.executeCommand('vscode.openFolder', ctx.branchStack.getWorktreePath(branchName), { forceNewWindow: true })
		})),
		vscode.commands.registerCommand('gitbraid.lockWorktree', cmd(async (node?: BranchNode) => {
			const ctx = activeContext()
			const branchName = node instanceof BranchNode ? node.entry.name
				: await vscode.window.showQuickPick(ctx.config.getStack().map(e => e.name), { placeHolder: 'Lock worktree for branch' })
			if (!branchName) return
			await git.worktree.lock(ctx.branchStack.getWorktreePath(branchName).fsPath)
			await vscode.window.showInformationMessage(`Locked worktree for "${branchName}"`)
		})),
		vscode.commands.registerCommand('gitbraid.unlockWorktree', cmd(async (node?: BranchNode) => {
			const ctx = activeContext()
			const branchName = node instanceof BranchNode ? node.entry.name
				: await vscode.window.showQuickPick(ctx.config.getStack().map(e => e.name), { placeHolder: 'Unlock worktree for branch' })
			if (!branchName) return
			await git.worktree.unlock(ctx.branchStack.getWorktreePath(branchName).fsPath)
			await vscode.window.showInformationMessage(`Unlocked worktree for "${branchName}"`)
		})),
		vscode.commands.registerCommand('gitbraid.copyToWorktree', cmd(async (node?: FileNode | FloatingFileNode) => {
			const fileUri = (node instanceof FileNode || node instanceof FloatingFileNode) ? node.resourceUri
				: vscode.window.activeTextEditor?.document.uri
			if (!fileUri) return
			const ctx = contextForUri(fileUri)
			const picked = await vscode.window.showQuickPick(ctx.config.getStack().map(e => e.name), { placeHolder: 'Copy file to branch worktree' })
			if (!picked) return
			const rel = relativePathIn(ctx, fileUri)
			await vscode.workspace.fs.copy(fileUri, vscode.Uri.joinPath(ctx.branchStack.getWorktreePath(picked), rel), { overwrite: true })
			await vscode.window.showInformationMessage(`Copied ${rel} → ${picked}`)
		})),
		vscode.commands.registerCommand('gitbraid.moveToWorktree', cmd(async (node?: FileNode | FloatingFileNode) => {
			const fileUri = (node instanceof FileNode || node instanceof FloatingFileNode) ? node.resourceUri
				: vscode.window.activeTextEditor?.document.uri
			if (!fileUri) return
			const ctx = contextForUri(fileUri)
			const picked = await vscode.window.showQuickPick(ctx.config.getStack().map(e => e.name), { placeHolder: 'Move file to branch worktree' })
			if (!picked) return
			const rel = relativePathIn(ctx, fileUri)
			await vscode.workspace.fs.copy(fileUri, vscode.Uri.joinPath(ctx.branchStack.getWorktreePath(picked), rel), { overwrite: true })
			await vscode.workspace.fs.delete(fileUri)
			if (node instanceof FileNode) {
				await ctx.config.removeAssignment(rel)
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
	return gitbraidExportedApi

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
