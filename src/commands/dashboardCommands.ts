import * as vscode from 'vscode'
import { log } from '../channelLogger'
import { DashboardRequest } from '../dashboardMessages'

/**
 * Plan 02 Wave B — dispatch a {@link DashboardRequest} to the corresponding
 * `gitbraid.*` command.  Kept in its own module so unit tests can drive
 * the dispatcher with a spy executor without needing a real webview.
 */

export interface DashboardDeps {
	/** Executes a VS Code command.  Injected so tests can record calls. */
	executeCommand: (cmd: string, ...args: unknown[]) => Promise<unknown>
	/** Clipboard surface, injected for testability. */
	clipboard: { writeText: (s: string) => Promise<void> }
	/** Show a user-visible info toast. */
	showInformationMessage: (msg: string) => Promise<void>
}

export function defaultDashboardDeps(): DashboardDeps {
	return {
		executeCommand: (cmd, ...args) => Promise.resolve(vscode.commands.executeCommand(cmd, ...args)),
		clipboard: { writeText: (s) => Promise.resolve(vscode.env.clipboard.writeText(s)) },
		showInformationMessage: (m) => Promise.resolve(vscode.window.showInformationMessage(m)).then(() => undefined),
	}
}

/**
 * Run the command that corresponds to `req`.  Every dashboard request
 * kind is handled here — add new kinds in `dashboardMessages.ts`'s union
 * and ensure this switch stays exhaustive so TypeScript flags misses.
 */
export async function handleDashboardRequest(req: DashboardRequest, deps: DashboardDeps): Promise<void> {
	switch (req.kind) {
		case 'refresh':          return void await deps.executeCommand('gitbraid.refreshPRStatus')
		case 'submit':           return void await deps.executeCommand('gitbraid.submitStack')
		case 'mergeStack':       return void await deps.executeCommand('gitbraid.mergeStack')
		case 'addBranch':        return void await deps.executeCommand('gitbraid.addStackBranch')
		case 'saveCheckpoint':   return void await deps.executeCommand('gitbraid.saveCheckpoint')
		case 'showUndoLog':      return void await deps.executeCommand('gitbraid.showUndoLog')
		case 'assignFloating':   return void await deps.executeCommand('gitbraid.assignFile')

		case 'openPr':             return void await deps.executeCommand('gitbraid.openStackedPR', req.branch)
		case 'rebase':             return void await deps.executeCommand('gitbraid.rebaseBranch', req.branch)
		case 'switchBranch':       return void await deps.executeCommand('gitbraid.switchBranch', req.branch)
		case 'moveBranchUp':       return void await deps.executeCommand('gitbraid.moveBranchUp', req.branch)
		case 'moveBranchDown':     return void await deps.executeCommand('gitbraid.moveBranchDown', req.branch)
		case 'removeBranch':       return void await deps.executeCommand('gitbraid.removeStackBranch', req.branch)
		case 'commit':             return void await deps.executeCommand('gitbraid.scm.commitBranch', req.branch)
		case 'pushBranch':         return void await deps.executeCommand('gitbraid.scm.pushBranch', req.branch)
		case 'absorbHunks':        return void await deps.executeCommand('gitbraid.absorbHunks', req.branch)
		case 'routeHunks':         return void await deps.executeCommand('gitbraid.routeHunks', req.branch)
		case 'toggleSingleCommit': return void await deps.executeCommand('gitbraid.toggleSingleCommitMode', req.branch)
		case 'setCommitTemplate':  return void await deps.executeCommand('gitbraid.setCommitTemplate', req.branch)
		case 'openWorktree':       return void await deps.executeCommand('gitbraid.launchWindowForWorktree', req.branch)

		case 'copyBranchName':
			await deps.clipboard.writeText(req.branch)
			await deps.showInformationMessage(`GitBraid: copied "${req.branch}" to clipboard.`)
			return
		case 'copyPrUrl':
			await deps.clipboard.writeText(req.url)
			await deps.showInformationMessage(`GitBraid: copied PR URL for "${req.branch}".`)
			return
		case 'openCommit':
			// The host resolves worktree → SHA and delegates to the
			// existing gitbraid.showCommit content-provider flow.  We
			// don't have the worktreeDir on the webview side, so we
			// pass the branch name through and let the command handler
			// (registered separately) do the lookup.
			await deps.executeCommand('gitbraid.openStackedCommit', { branch: req.branch, sha: req.sha })
			return

		default: {
			// Exhaustiveness — if a new DashboardRequest kind is added
			// without a case above, TypeScript will flag `req` as never-
			// assignable to this branch.  At runtime we log-and-ignore.
			const _never: never = req
			log.warn(`dashboardCommands: unsupported request kind ${JSON.stringify(_never)}`)
			return
		}
	}
}
