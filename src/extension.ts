import * as vscode from 'vscode'
import { git } from './gitFunctions'
import { log } from './channelLogger'
import { fileExists } from './utils'
import { GitBraidAPI } from './commands'
import { nodeMaps, WorktreeFile, WorktreeNode, WorktreeRoot } from './worktreeNodes'
import { ConfigService } from './configService'
import { BranchStackService } from './branchStackService'
import { WorkspaceSync } from './workspaceSync'
import { BranchFileDecorationProvider } from './fileDecorationProvider'
import { BranchScmProviderManager } from './branchScmProvider'
import { BranchStackTreeProvider, FloatingStatusBarItem } from './branchStackTreeProvider'
import { DiffEngine } from './diffEngine'
import { HunkRouter } from './hunkRouter'
import { HunkCodeLensProvider, OverlayDiagnostics } from './hunkCodeLensProvider'
import { StackResolver } from './stackResolver'
import { RebaseSuggestionService } from './rebaseSuggestionService'
import { MbcApi } from './mbcApi'
import { registerLmTools } from './lmTools'

export const api = new GitBraidAPI()

export async function activate(context: vscode.ExtensionContext) {
	const commands: vscode.Disposable[] = []

	if (vscode.workspace.workspaceFolders === undefined) {
		throw new Error('No workspace folder found')
	}

	log.info('activating gitbraid (version=' + context.extension.packageJSON.version + ')')
	api.tempDir = context.storageUri!
	await api.worktreeView.initTreeview()

	// ─── Phase 1: Branch-overlay services ─────────────────────────────────────
	const workspaceRoot = vscode.workspace.workspaceFolders[0].uri
	const configService = ConfigService.getInstance()
	await configService.load(workspaceRoot)

	const branchStack = BranchStackService.getInstance(configService)
	await branchStack.initStack(workspaceRoot)

	const workspaceSync = WorkspaceSync.getInstance(configService)
	workspaceSync.init(workspaceRoot)

	context.subscriptions.push(configService, branchStack, workspaceSync)

	// ─── Phase 2: SCM Integration & UI ────────────────────────────────────────
	const decorationProvider = new BranchFileDecorationProvider(configService, workspaceSync)
	context.subscriptions.push(decorationProvider)

	const scmManager = new BranchScmProviderManager(configService, workspaceSync, workspaceRoot)
	await scmManager.initialize()
	context.subscriptions.push(scmManager)

	const stackTreeProvider = new BranchStackTreeProvider(configService, workspaceSync)
	const stackView = vscode.window.createTreeView('gitbraid.stackView', {
		treeDataProvider: stackTreeProvider,
		showCollapseAll: true,
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

		vscode.commands.registerCommand('gitbraid.focusStackView', () => {
			stackView.reveal(undefined as never, { focus: true }).then(undefined, (e: unknown) => {
				log.error('focusStackView: ' + e)
			})
		}),

		vscode.commands.registerCommand('gitbraid.scm.commitBranch', (branchName: string) => {
			void scmManager.commitBranch(branchName)
		}),

		vscode.commands.registerCommand('gitbraid.scm.refreshAll', () => {
			void scmManager.refreshAll()
		}),

		vscode.commands.registerCommand(
			'gitbraid.assignHunk',
			async (uri: vscode.Uri, hunkIndex: number) => {
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
				await configService.setHunkAssignment(rel, hunkIndex, picked.label)
				await vscode.window.showInformationMessage(`Hunk ${String(hunkIndex)} → ${picked.label}`)
				await overlayDiagnostics.refreshForUri(uri)
			},
		),

		vscode.commands.registerCommand(
			'gitbraid.routeHunks',
			async (uri?: vscode.Uri) => {
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
				const ok = await hunkRouter.routeFile(
					workspaceRoot.fsPath,
					rel,
					worktreeDirs,
					assignments,
				)
				if (ok) {
					await configService.clearHunkAssignments(rel)
					await vscode.window.showInformationMessage(`Routed hunks for ${rel} successfully.`)
				}
			},
		),
	)

	// ─── Phase 4: Branch hierarchy & stacking ─────────────────────────────────
	const _stackResolver = new StackResolver(configService, branchStack)
	const rebaseSvc = new RebaseSuggestionService(configService, branchStack)
	rebaseSvc.init(workspaceRoot)
	context.subscriptions.push(rebaseSvc)

	// ── Branch-overlay commands ────────────────────────────────────────────────
	commands.push(
		vscode.commands.registerCommand('gitbraid.assignFile', async (uri?: vscode.Uri) => {
			const target = uri ?? vscode.window.activeTextEditor?.document.uri
			if (!target) {
				void vscode.window.showWarningMessage('No file selected to assign.')
				return
			}
			const rel = vscode.workspace.asRelativePath(target)
			const stack = configService.getStack()
			if (stack.length === 0) {
				void vscode.window.showWarningMessage('No branches in the stack. Add a branch first.')
				return
			}
			const picked = await vscode.window.showQuickPick(
				stack.map((e) => ({ label: e.name, description: e.color })),
				{ placeHolder: 'Assign file to branch' }
			)
			if (!picked) {
				return
			}
			await configService.setAssignment(rel, picked.label)
			void vscode.window.showInformationMessage(`Assigned ${rel} → ${picked.label}`)
		}),

		vscode.commands.registerCommand('gitbraid.unassignFile', async (uri?: vscode.Uri) => {
			const target = uri ?? vscode.window.activeTextEditor?.document.uri
			if (!target) {
				void vscode.window.showWarningMessage('No file selected to unassign.')
				return
			}
			const rel = vscode.workspace.asRelativePath(target)
			await configService.removeAssignment(rel)
			void vscode.window.showInformationMessage(`Unassigned ${rel}`)
		}),

		vscode.commands.registerCommand('gitbraid.addStackBranch', async () => {
			const name = await vscode.window.showInputBox({ prompt: 'Branch name', placeHolder: 'feature/my-feature' })
			if (!name) {
				return
			}
			const stack = configService.getStack()
			const bases = ['main', ...stack.map((e) => e.name)]
			const base = await vscode.window.showQuickPick(bases, { placeHolder: 'Base branch' }) ?? 'main'
			await branchStack.addBranchToStack(name, base)
			void vscode.window.showInformationMessage(`Branch "${name}" added to stack`)
		}),

		vscode.commands.registerCommand('gitbraid.removeStackBranch', async () => {
			const stack = configService.getStack()
			if (stack.length === 0) {
				void vscode.window.showWarningMessage('Stack is empty.')
				return
			}
			const picked = await vscode.window.showQuickPick(
				stack.map((e) => e.name),
				{ placeHolder: 'Remove branch from stack' }
			)
			if (!picked) {
				return
			}
			await branchStack.removeBranchFromStack(picked)
			void vscode.window.showInformationMessage(`Branch "${picked}" removed from stack`)
		}),

		vscode.commands.registerCommand('gitbraid.rebaseBranch', async (branchName?: string) => {
			const stack = configService.getStack()
			if (stack.length === 0) {
				await vscode.window.showWarningMessage('Stack is empty.')
				return
			}
			const name = branchName ?? (await vscode.window.showQuickPick(
				stack.map((e) => e.name),
				{ placeHolder: 'Rebase branch onto its parent' },
			))
			if (!name) {
				return
			}
			await rebaseSvc.rebaseBranch(name)
		}),
	)

	// ─── Phase 5: Exported API & LM tools ─────────────────────────────────────
	const mbcExportedApi = new MbcApi(configService, branchStack, workspaceSync, workspaceRoot)
	context.subscriptions.push(...registerLmTools(mbcExportedApi))

	// ********** WorktreeView Refresh Events ********** //
	// context.subscriptions.push(api.worktreeView.onDidChangeTreeData((e) => {
	// 	// if (e.uri.fsPath == vscode.workspace.workspaceFolders![0].uri.fsPath) {
	// 	// 	return
	// 	// }
	// 	log.info('onDidChangeTreeData e=' + e?.id + ' ' + e)
	// 	// return worktreeView.refresh()
	// }))

	// ********** WorktreeView Commands ********** //
	commands.push(vscode.commands.registerCommand('gitbraid.refreshView', () => api.refresh()))

	// ********** WorktreeRoot Commands ********** //
	commands.push(
		vscode.commands.registerCommand('gitbraid.refresh', (node?: WorktreeNode) => api.refresh(node)),
		vscode.commands.registerCommand('gitbraid.createWorktree', () => api.createWorktree(vscode.workspace.workspaceFolders![0])),
		vscode.commands.registerCommand('gitbraid.deleteWorktree', (node: WorktreeRoot) => api.deleteWorktree(node)),
		vscode.commands.registerCommand('gitbraid.lockWorktree', (node: WorktreeRoot) => api.lockWorktree(node)),
		vscode.commands.registerCommand('gitbraid.swapWorktrees', (node: WorktreeRoot) => api.swapWorktrees(node)),
		vscode.commands.registerCommand('gitbraid.unlockWorktree', (node: WorktreeRoot) => api.unlockWorktree(node)),
		vscode.commands.registerCommand('gitbraid.launchWindowForWorktree', (node: WorktreeRoot) => api.launchWindowForWorktree(node))
	)

	// ********** WorktreeFile Commands ********** //
	commands.push(
		vscode.commands.registerCommand('gitbraid.selectFileNode', (id: string) => api.selectWorktreeFile(id)),
		vscode.commands.registerCommand('gitbraid.copyToWorktree', (node: WorktreeFile) => api.copyToWorktree(node)),
		vscode.commands.registerCommand('gitbraid.moveToWorktree', (node: WorktreeFile) => api.moveToWorktree(node)),
		// vscode.commands.registerCommand('gitbraid.patchToWorktree', (node: WorktreeFile) => api.patchToWorktree(node)),
		vscode.commands.registerCommand('gitbraid.stageNode', (node: WorktreeNode) => api.stage(node)),
		vscode.commands.registerCommand('gitbraid.unstageNode', (node: WorktreeNode) => api.unstage(node)),
		vscode.commands.registerCommand('gitbraid.discardChanges', (node: WorktreeFile) => api.discardChanges(node)),
		// vscode.commands.registerCommand('gitbraid.compareFileWithMergeBase', (node: WorktreeFile) => api.compare(node)),
	)

	// ********** NON-API commands ********** //
	commands.push(
		vscode.commands.registerCommand('gitbraid.openFile', (node: WorktreeFile) => {
			log.info('gitbraid.openFile')
			return api.openFile(node)
		}),
	)


	context.subscriptions.push(...commands)

	await filesExcludeWorktreesDir()
	await ignoreWorktreesDir()

	log.info('subscribe')
	context.subscriptions.push(api.worktreeView)
	log.info('register worktreeView')
	vscode.window.registerTreeDataProvider('gitbraid.worktreeView', api.worktreeView)

	log.info('register filewatcher')
	const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.workspace.workspaceFolders[0], '**/*'), false, true, false)
	const watcherChange = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.workspace.workspaceFolders[0], '**/.git/index'), true, false, true)
	context.subscriptions.push(watcher)

	watcherChange.onDidChange(async (e) => {
		if (e.scheme !== 'file') {
			return
		}
		const stat = await vscode.workspace.fs.stat(e).then((s) => { return s}, (e) => { return undefined })
		if (!stat) {
			return
		}
		if (stat.type == vscode.FileType.Directory) {
			return
		}
		if (git.ignoreCache.includes(e.fsPath)) {
			return
		}
		log.info('onDidChange: ' + e.fsPath + ' ' + stat.type)
		const repoNode = nodeMaps.getWorktreeForUri(e)
		return api.refresh(repoNode)
	})
	watcher.onDidCreate((e) => {
		if (e.scheme !== 'file') { return }
		log.info('onDidCreate: ' + e.fsPath)
		return api.refreshUri(e)
	})
	watcher.onDidDelete(async (e) => {
		if (e.scheme !== 'file') { return }
		const ignore = await git.checkIgnore(e.fsPath)
		if (ignore) {
			return
		}
		const repoNode = nodeMaps.getWorktreeForUri(e)
		log.info('onDidDelete: ' + e.fsPath)
		return api.refresh(repoNode)
	})
	log.info('extension activation complete')
	return mbcExportedApi

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

async function ignoreWorktreesDir () {
	const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, '.gitignore')
	if (!fileExists(uri)) {
		log.info('.gitignore not updated because it does not exist')
		return
	}

	const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))
	const lines = content.replace(/\\r/g,'').split('\n')
	for (let line of lines) {
		line = line.trim() // NOSONAR
		if (line === '.worktrees/') {
			log.info('Pattern \'.worktrees/\' already in .gitignore')
			return
		}
	}
	await vscode.workspace.fs.writeFile(uri, Uint8Array.from(Buffer.from(content + '\n## added by vscode extension \'nihobbs.gitbraid\'\n.worktrees/\n')))
}
