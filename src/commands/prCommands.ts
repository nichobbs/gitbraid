import * as vscode from 'vscode'
import * as path from 'node:path'
import { log } from '../channelLogger'
import { BranchNode } from '../branchStackTreeProvider'
import { withErrorHandler } from '../errorSurfacer'
import { runAbsorbUi } from '../absorb'
import { worktreePath } from '../branchStackService'
import { getDefaultGitRunner } from '../gitRunner'
import { PersistentUndoLog } from '../persistentUndoLog'
import { MergeQueueService, progressFromVsCode } from '../mergeQueueService'
import type { CommandDeps } from './types'

const cmd = withErrorHandler

/**
 * Commands related to pull-request submission + status.  Implements the
 * surface described in `docs/plans/01-pr-creation.md`:
 *
 *   gitbraid.submitStack       — push + createPR/updatePR for every stack branch
 *   gitbraid.openStackedPR     — open the current branch's PR in the browser
 *   gitbraid.setGithubToken    — store a PAT in SecretStorage for the Octokit fallback
 *
 * `gitbraid.refreshPRStatus` is registered separately in `viewCommands.ts`
 * (it predates this plan and just refreshes PRAwareness).
 */
export function registerPrCommands(deps: CommandDeps, secrets: vscode.SecretStorage): vscode.Disposable[] {
	const { activeContext, resolveBranchNameArg, prAwareness } = deps

	return [
		vscode.commands.registerCommand('gitbraid.submitStack', cmd(async () => {
			const ctx = activeContext()
			if (ctx.config.getStack().length === 0) {
				await vscode.window.showInformationMessage('GitBraid: stack is empty — nothing to submit.')
				return
			}
			const svc = await ctx.buildSubmitStackService()
			const results = await svc.submit({})
			await prAwareness.refresh().catch(() => { /* best-effort */ })

			const created = results.filter((r) => r.action === 'pushed+created').length
			const updated = results.filter((r) => r.action === 'pushed+updated').length
			const unchanged = results.filter((r) => r.action === 'pushed+unchanged').length
			const failed = results.filter((r) => !r.ok)
			const skipped = results.filter((r) => r.action === 'skipped').length

			const summary =
				`GitBraid: submitted ${String(results.length)} branch(es) — ` +
				`${String(created)} created, ${String(updated)} updated, ${String(unchanged)} unchanged, ` +
				`${String(skipped)} skipped, ${String(failed.length)} failed`
			log.info(summary)

			if (failed.length === 0) {
				await vscode.window.showInformationMessage(summary)
				return
			}
			const detail = failed.slice(0, 3)
				.map((r) => `• ${r.branch}: ${r.message ?? 'unknown error'}`)
				.join('\n')
			const more = failed.length > 3 ? `\n(+${String(failed.length - 3)} more in Output)` : ''
			const pick = await vscode.window.showWarningMessage(
				`${summary}\n${detail}${more}`,
				{ modal: false },
				'Open Output',
			)
			if (pick === 'Open Output') log.show()
		})),

		vscode.commands.registerCommand('gitbraid.openStackedPR', cmd(async (arg?: BranchNode | string) => {
			const ctx = activeContext()
			let branchName: string | undefined
			if (arg instanceof BranchNode) {
				branchName = arg.entry.name
			} else if (typeof arg === 'string') {
				branchName = arg
			} else {
				branchName = await resolveBranchNameArg(undefined, 'Open PR for branch')
			}
			if (!branchName) return

			const entry = ctx.config.getBranch(branchName)
			const cached = prAwareness.getForBranch(branchName)
			if (cached?.url) {
				await vscode.env.openExternal(vscode.Uri.parse(cached.url))
				return
			}
			if (entry?.prNumber) {
				// Construct a URL from the origin remote + cached number as best effort.
				const adapter = await ctx.getPRAdapter()
				const pr = await adapter.getPR(branchName)
				if (pr?.url) {
					await vscode.env.openExternal(vscode.Uri.parse(pr.url))
					return
				}
			}
			await vscode.window.showInformationMessage(
				`GitBraid: no PR is known for "${branchName}". Run "Submit Stack" first.`,
			)
		})),

		vscode.commands.registerCommand('gitbraid.absorbHunks', cmd(async (arg?: vscode.Uri | BranchNode) => {
			const ctx = activeContext()
			// Resolve the files + owning branch from the invocation context.
			const filesByBranch = new Map<string, string[]>()
			if (arg instanceof BranchNode) {
				const branch = arg.entry.name
				const assigned = ctx.config.getAllAssignments()
				const files = Object.entries(assigned).filter(([, b]) => b === branch).map(([p]) => p)
				if (files.length > 0) filesByBranch.set(branch, files)
			} else {
				const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri
				if (!uri) {
					await vscode.window.showInformationMessage('GitBraid: open a file first, then run Absorb.')
					return
				}
				const rel = path.relative(ctx.root.fsPath, uri.fsPath).replaceAll('\\', '/')
				const branch = ctx.config.getAssignment(rel)
				if (!branch) {
					await vscode.window.showInformationMessage(`GitBraid: "${rel}" is not assigned to any branch.`)
					return
				}
				filesByBranch.set(branch, [rel])
			}
			if (filesByBranch.size === 0) {
				await vscode.window.showInformationMessage('GitBraid: no files to absorb.')
				return
			}

			const allowPushed = vscode.workspace.getConfiguration('gitbraid').get<boolean>('absorbRewritePushed', false)
			const runner = getDefaultGitRunner()
			for (const [branch, relPaths] of filesByBranch) {
				const entry = ctx.config.getBranch(branch)
				if (!entry) continue
				if (!ctx.branchStack.worktreeExists(branch)) {
					log.warn(`absorbHunks: worktree missing for ${branch}`)
					continue
				}
				const wt = worktreePath(ctx.root, branch).fsPath
				// merge-base of the branch tip with its parent defines the rewritable range.
				const mb = await runner.run(['merge-base', 'HEAD', entry.base], { cwd: wt })
				const mergeBase = mb.exitCode === 0 ? mb.stdout.trim() : entry.base
				await runAbsorbUi(wt, branch, relPaths, ctx.diffEngine, {
					mergeBase,
					allowPushed,
				})
			}
		})),

		vscode.commands.registerCommand('gitbraid.mergeStack', cmd(async () => {
			const ctx = activeContext()
			if (ctx.config.getStack().length === 0) {
				await vscode.window.showInformationMessage('GitBraid: stack is empty — nothing to merge.')
				return
			}
			const adapter = await ctx.getPRAdapter()
			if (adapter.name === 'none') {
				await vscode.window.showWarningMessage(
					'GitBraid: no PR host configured. Run "Set GitHub Token…" or install the GitHub Pull Requests extension first.',
				)
				return
			}
			const pollSeconds = vscode.workspace.getConfiguration('gitbraid').get<number>('mergeQueuePollSeconds', 30)
			const svc = new MergeQueueService(ctx.config, adapter)
			const abort = new AbortController()
			const results = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: 'GitBraid: queueing stack for merge…',
					cancellable: true,
				},
				async (progress, token) => {
					token.onCancellationRequested(() => abort.abort())
					return svc.mergeStack(
						{ pollIntervalMs: pollSeconds * 1000 },
						progressFromVsCode(progress),
						abort.signal,
					)
				},
			)

			const ok = results.filter((r) => r.ok).length
			const failed = results.filter((r) => !r.ok)
			const summary = `GitBraid merge-stack: ${String(ok)} merged, ${String(failed.length)} failed`
			log.info(summary)
			if (failed.length === 0) {
				await vscode.window.showInformationMessage(summary)
				return
			}
			const detail = failed.slice(0, 3)
				.map((r) => `• ${r.branch}: ${r.message ?? 'unknown'}`)
				.join('\n')
			const more = failed.length > 3 ? `\n(+${String(failed.length - 3)} more in Output)` : ''
			const pick = await vscode.window.showWarningMessage(
				`${summary}\n${detail}${more}`,
				{ modal: false },
				'Open Output',
			)
			if (pick === 'Open Output') log.show()
		})),

		vscode.commands.registerCommand('gitbraid.toggleSingleCommitMode', cmd(async (arg?: BranchNode | string) => {
			const ctx = activeContext()
			let branchName: string | undefined
			if (arg instanceof BranchNode) branchName = arg.entry.name
			else if (typeof arg === 'string') branchName = arg
			else branchName = await resolveBranchNameArg(undefined, 'Toggle single-commit mode for branch')
			if (!branchName) return
			const entry = ctx.config.getBranch(branchName)
			if (!entry) return
			const next = !entry.singleCommit
			await ctx.config.setSingleCommit(branchName, next)
			await vscode.window.showInformationMessage(
				next
					? `GitBraid: "${branchName}" is now single-commit.  New commits will amend the existing HEAD.`
					: `GitBraid: single-commit mode cleared for "${branchName}".`,
			)
		})),

		vscode.commands.registerCommand('gitbraid.showUndoLog', cmd(async () => {
			const ctx = activeContext()
			const maxEntries = vscode.workspace.getConfiguration('gitbraid').get<number>('undoLogMaxEntries', 500)
			const log0 = new PersistentUndoLog(path.join(ctx.root.fsPath, '.worktrees'), { maxEntries })
			const entries = await log0.load()
			if (entries.length === 0) {
				await vscode.window.showInformationMessage('GitBraid: undo log is empty.')
				return
			}
			const items = entries.slice().reverse().map((e) => ({
				label: e.action,
				description: new Date(e.ts).toLocaleString(),
				detail: Object.keys(e.detail).length > 0 ? JSON.stringify(e.detail) : undefined,
			}))
			await vscode.window.showQuickPick(items, { placeHolder: `${String(entries.length)} logged actions` })
		})),

		vscode.commands.registerCommand('gitbraid.setGithubToken', cmd(async () => {
			const existing = await secrets.get('gitbraid.githubToken')
			const input = await vscode.window.showInputBox({
				prompt: 'GitHub personal access token (classic or fine-grained; repo scope)',
				placeHolder: existing ? '••••••• (replace)' : 'ghp_…',
				password: true,
				ignoreFocusOut: true,
			})
			if (input === undefined) return
			if (input === '') {
				await secrets.delete('gitbraid.githubToken')
				await vscode.window.showInformationMessage('GitBraid: GitHub token cleared.')
				return
			}
			await secrets.store('gitbraid.githubToken', input)
			for (const ctx of deps.registry.getAll()) ctx.invalidatePRAdapter()
			await vscode.window.showInformationMessage('GitBraid: GitHub token stored.')
		})),
	]
}
