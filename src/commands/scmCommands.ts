import * as vscode from 'vscode'
import { getDefaultGitRunner } from '../gitRunner'
import { log } from '../channelLogger'
import { withErrorHandler } from '../errorSurfacer'
import type { CommandDeps } from './types'
import type { BranchNode } from '../branchStackTreeProvider'

const cmd = withErrorHandler

export function registerScmCommands(deps: CommandDeps): vscode.Disposable[] {
	const { activeContext, resolveBranchNameArg } = deps

	return [
		vscode.commands.registerCommand('gitbraid.scm.commitBranch', cmd(async (arg: string | BranchNode) => {
			const name = arg && typeof arg === 'object' && 'entry' in arg
				? (arg as { entry: { name: string } }).entry.name
				: arg as string
			await activeContext().scmManager.commitBranch(name)
		})),

		vscode.commands.registerCommand('gitbraid.scm.refreshAll', cmd(async () => {
			await activeContext().scmManager.refreshAll()
		})),

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

			const staged = await runner.run(['diff', '--cached'], { cwd: worktreeDir })
			const diff = staged.stdout.trim()
				? staged.stdout
				: (await runner.run(['diff'], { cwd: worktreeDir })).stdout

			if (!diff.trim()) {
				await vscode.window.showInformationMessage(`No changes in "${branchName}" to generate a message for.`)
				return
			}

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
			log.info(`scm.generateCommitMessage: generated ${generatedMessage.length} chars for "${branchName}"`)
		})),
	]
}
