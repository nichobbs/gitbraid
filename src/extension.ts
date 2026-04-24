import * as vscode from 'vscode'
import * as path from 'node:path'
import { log } from './channelLogger'
import { BranchFileDecorationProvider } from './fileDecorationProvider'
import { BranchNode, BranchStackTreeProvider, FloatingStatusBarItem } from './branchStackTreeProvider'
import { HunkCodeLensProvider, OverlayDiagnostics } from './hunkCodeLensProvider'
import { StackContentProvider } from './stackContentProvider'
import { recordAssignFile, recordUnassignFile } from './undoStack'
import { PRAwareness } from './prAwareness'
import { registerLmTools } from './lmTools'
import { FolderRegistry } from './folderRegistry'
import { FolderContext } from './folderContext'
import { GitBraidApiFacade } from './gitBraidApiFacade'
import { withErrorHandler, showError } from './errorSurfacer'
import { registerAllCommands } from './commands'
import type { CommandDeps } from './commands'
import { GitBraidMcpServer } from './mcpServer'
export { showError }

export async function activate(context: vscode.ExtensionContext) {
	if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
		log.info('gitbraid activation skipped: no workspace folder')
		return
	}

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
	const registry = new FolderRegistry()
	const contexts = await registry.initializeAll()
	context.subscriptions.push(registry)

	if (contexts.length === 0) {
		log.warn('gitbraid: no git-eligible workspace folders; activation is idle')
		return
	}

	const primary = contexts[0]
	const workspaceRoot = primary.root
	const configService = primary.config
	const workspaceSync = primary.workspaceSync

	const activeContext = (): FolderContext => registry.getActive() ?? primary

	const contextForUri = (uri: vscode.Uri | undefined): FolderContext => {
		if (uri) {
			const ctx = registry.getForUri(uri)
			if (ctx) return ctx
		}
		return activeContext()
	}

	const relativePathIn = (ctx: FolderContext, uri: vscode.Uri): string =>
		path.relative(ctx.root.fsPath, uri.fsPath).replaceAll('\\', '/')

	// ─── Phase 2: SCM Integration & UI ────────────────────────────────────────
	const stackResolver = primary.stackResolver
	const diffEngine = primary.diffEngine

	const decorationProvider = new BranchFileDecorationProvider(configService, workspaceSync, registry)
	context.subscriptions.push(decorationProvider)

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
	)
	const stackView = vscode.window.createTreeView('gitbraid.stackView', {
		treeDataProvider: stackTreeProvider,
		dragAndDropController: stackTreeProvider,
		showCollapseAll: true,
		canSelectMany: true,
	})
	stackView.title = 'Branch Stack'
	context.subscriptions.push(stackTreeProvider, stackView)

	const statusBar = new FloatingStatusBarItem(workspaceSync, configService)
	context.subscriptions.push(statusBar)

	// When a file first becomes floating, offer to assign it to the branch that
	// owns all its siblings in the same directory.  Shown once per session per path.
	const _wireAutoAssign = (ctx: FolderContext) => {
		const suggestedPaths = new Set<string>()
		ctx.workspaceSync.onDidFloatFile(async ({ relativePath }) => {
			if (suggestedPaths.has(relativePath)) return
			suggestedPaths.add(relativePath)

			const dir = path.dirname(relativePath.replaceAll('\\', '/'))
			if (!dir || dir === '.') return

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
	const hunkCodeLens = new HunkCodeLensProvider(diffEngine, configService, registry)
	const overlayDiagnostics = new OverlayDiagnostics(diffEngine, configService, registry)
	context.subscriptions.push(
		hunkCodeLens,
		overlayDiagnostics,
		vscode.languages.registerCodeLensProvider({ scheme: 'file', pattern: '**' }, hunkCodeLens),
	)

	// ─── Phase 4: Branch hierarchy & stacking ─────────────────────────────────
	const stackContentProvider = new StackContentProvider(registry, workspaceRoot, stackResolver)
	context.subscriptions.push(stackContentProvider)

	const contentRefreshSubs = new Map<string, vscode.Disposable>()
	const wireContentRefresh = (ctx: FolderContext) => {
		contentRefreshSubs.set(ctx.root.fsPath, ctx.config.onDidChangeAssignment((e) => {
			if (e.relativePath) stackContentProvider.refresh(e.relativePath, ctx.root)
		}))
	}
	for (const ctx of registry.getAll()) wireContentRefresh(ctx)
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

	// Shared command helpers defined here so they close over the activation-
	// scoped locals (registry, primary, stackTreeProvider, etc.) and can be
	// passed cleanly into the command modules via CommandDeps.

	const resolveBranchNameArg = async (arg: unknown, placeholder: string): Promise<string | undefined> => {
		if (typeof arg === 'string') return arg
		if (arg && typeof arg === 'object' && 'id' in arg) {
			const id = (arg as { id?: unknown }).id
			if (typeof id === 'string' && id.startsWith('gitbraid-')) return id.slice('gitbraid-'.length)
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
		arg: unknown,
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
			: (arg ?? await vscode.window.showQuickPick(stack.map((e) => e.name), { placeHolder: placeholder }))
		if (!name) return undefined
		if (!ctx.branchStack.worktreeExists(name as string)) {
			await vscode.window.showWarningMessage(`No worktree exists for "${String(name)}".`)
			return undefined
		}
		return { ctx, worktreeDir: ctx.branchStack.getWorktreePath(name as string).fsPath }
	}

	const extractFileUri = (a: unknown): vscode.Uri | undefined => {
		if (a instanceof vscode.Uri) return a
		if (a && typeof a === 'object' && 'resourceUri' in a) {
			const uri = (a as { resourceUri?: unknown }).resourceUri
			if (uri instanceof vscode.Uri) return uri
		}
		return undefined
	}

	// ─── Phase 5: Command registration ────────────────────────────────────────
	const cmdDeps: CommandDeps = {
		registry,
		primary,
		activeContext,
		contextForUri,
		relativePathIn,
		resolveBranchNameArg,
		resolveActiveBranchWorktree,
		extractFileUri,
		stackTreeProvider,
		stackView,
		statusBar,
		prAwareness,
		overlayDiagnostics,
	}
	context.subscriptions.push(...registerAllCommands(cmdDeps))

	// ─── Phase 6: Exported API & LM tools ─────────────────────────────────────
	const gitbraidExportedApi = new GitBraidApiFacade(registry)
	context.subscriptions.push(gitbraidExportedApi, ...registerLmTools(gitbraidExportedApi))

	// ─── Phase 7: MCP server (opt-in) ─────────────────────────────────────────
	const mcpServer = new GitBraidMcpServer(gitbraidExportedApi, stackContentProvider)
	context.subscriptions.push(mcpServer)

	const mcpStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90)
	mcpStatusBar.command = 'gitbraid.startMcpServer'
	mcpStatusBar.text = '$(plug) MCP: off'
	mcpStatusBar.tooltip = 'GitBraid MCP server is stopped. Click to start.'
	mcpStatusBar.show()
	context.subscriptions.push(mcpStatusBar)

	context.subscriptions.push(
		vscode.commands.registerCommand('gitbraid.startMcpServer', async () => {
			if (mcpServer.isRunning) {
				await mcpServer.stop()
				mcpStatusBar.text = '$(plug) MCP: off'
				mcpStatusBar.tooltip = 'GitBraid MCP server is stopped. Click to start.'
			} else {
				await mcpServer.start()
				mcpStatusBar.text = '$(plug) MCP: on'
				mcpStatusBar.tooltip = 'GitBraid MCP server is running. Click to stop.'
			}
		}),
	)

	await filesExcludeWorktreesDir()
	log.info('extension activation complete')
	return gitbraidExportedApi
}

async function filesExcludeWorktreesDir() {
	const filesExclude = vscode.workspace.getConfiguration('files')
	log.info('197 ' + filesExclude.inspect)
	log.info('198 ' + JSON.stringify(filesExclude.inspect))
	log.info('199 ' + JSON.stringify(filesExclude.inspect('exclude'), null, 2))
	const insp = filesExclude.inspect('exclude')

	let current: { [k: string]: boolean } = {}
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
