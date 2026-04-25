import * as vscode from 'vscode'
import { log } from '../channelLogger'
import { DashboardRequest } from '../dashboardMessages'

/**
 * Plan 02 Wave B — dispatch a {@link DashboardRequest} to the corresponding
 * `gitbraid.*` command.  Kept in its own module so unit tests can drive
 * the dispatcher with a spy executor without needing a real webview.
 */

export interface QuickPickItemLite {
	label: string
	/** Hidden from the user; used by the host to map selection → request. */
	id?: string
	detail?: string
	description?: string
	picked?: boolean
	/** When true, the picker should render the item as non-selectable. */
	disabled?: boolean
}

export interface DashboardDeps {
	/** Executes a VS Code command.  Injected so tests can record calls. */
	executeCommand: (cmd: string, ...args: unknown[]) => Promise<unknown>
	/** Clipboard surface, injected for testability. */
	clipboard: { writeText: (s: string) => Promise<void> }
	/** Show a user-visible info toast. */
	showInformationMessage: (msg: string) => Promise<void>
	/**
	 * Show a native QuickPick.  Resolves to the selected item's `id`
	 * (preferred over `label` so localisation can't break the dispatch), or
	 * `undefined` when the user dismisses the picker.
	 */
	showQuickPick: (items: QuickPickItemLite[], opts: { placeHolder: string }) => Promise<QuickPickItemLite | undefined>
}

export function defaultDashboardDeps(): DashboardDeps {
	return {
		executeCommand: (cmd, ...args) => Promise.resolve(vscode.commands.executeCommand(cmd, ...args)),
		clipboard: { writeText: (s) => Promise.resolve(vscode.env.clipboard.writeText(s)) },
		showInformationMessage: (m) => Promise.resolve(vscode.window.showInformationMessage(m)).then(() => undefined),
		showQuickPick: async (items, opts) => {
			// Filter out disabled items before handing to VS Code — the
			// native picker has no "disabled" state, so the simplest UX is
			// to omit them entirely.
			const enabled = items.filter((i) => !i.disabled)
			const picked = await vscode.window.showQuickPick(enabled, { placeHolder: opts.placeHolder })
			return picked ?? undefined
		},
	}
}

/**
 * Build the menu item list for a row's context menu.  Exported so tests
 * can assert the exact set of actions without rendering any UI.  Each
 * item's `id` is a `DashboardRequest.kind` the dispatcher understands.
 */
export function buildRowContextMenuItems(branch: string, prUrl: string): QuickPickItemLite[] {
	return [
		{ id: 'switchBranch',       label: `Switch to ${branch}` },
		{ id: 'commit',             label: 'Commit…' },
		{ id: 'pushBranch',         label: 'Push' },
		{ id: 'moveBranchUp',       label: 'Move up' },
		{ id: 'moveBranchDown',     label: 'Move down' },
		{ id: 'absorbHunks',        label: 'Absorb hunks…' },
		{ id: 'routeHunks',         label: 'Route hunks…' },
		{ id: 'toggleSingleCommit', label: 'Toggle single-commit mode' },
		{ id: 'setCommitTemplate',  label: 'Set commit template…' },
		{ id: 'openWorktree',       label: 'Open worktree in new window' },
		{ id: 'copyBranchName',     label: 'Copy branch name' },
		{ id: 'copyPrUrl',          label: 'Copy PR URL', disabled: !prUrl, description: prUrl || undefined },
		{ id: 'removeBranch',       label: 'Remove from stack…' },
	]
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

		case 'rowContextMenu': {
			// Replace the hand-rolled webview popup with a native
			// QuickPick.  Map the chosen item's `id` (a dispatch kind)
			// back through this same dispatcher so every action honours
			// the Wave B typed contract.
			const items = buildRowContextMenuItems(req.branch, req.prUrl)
			const picked = await deps.showQuickPick(items, {
				placeHolder: `Actions for ${req.branch}`,
			})
			if (!picked || !picked.id) return
			const next = pickedItemToRequest(picked.id, req.branch, req.prUrl)
			if (!next) {
				log.warn(`dashboardCommands: unmapped QuickPick id ${picked.id}`)
				return
			}
			await handleDashboardRequest(next, deps)
			return
		}

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

/** Map a QuickPick `id` chosen from {@link buildRowContextMenuItems} back
 *  into a typed {@link DashboardRequest}.  Exported for tests. */
export function pickedItemToRequest(
	id: string,
	branch: string,
	prUrl: string,
): DashboardRequest | undefined {
	switch (id) {
		case 'switchBranch':
		case 'commit':
		case 'pushBranch':
		case 'moveBranchUp':
		case 'moveBranchDown':
		case 'absorbHunks':
		case 'routeHunks':
		case 'toggleSingleCommit':
		case 'setCommitTemplate':
		case 'openWorktree':
		case 'copyBranchName':
		case 'removeBranch':
			return { kind: id, branch }
		case 'copyPrUrl':
			if (!prUrl) return undefined
			return { kind: 'copyPrUrl', branch, url: prUrl }
		default:
			return undefined
	}
}
