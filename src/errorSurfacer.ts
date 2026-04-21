import * as vscode from 'vscode'
import { log } from './channelLogger'

/**
 * Standard error surface for user-initiated failures.  Logs the full error
 * to the output channel and presents a short modal with an "Open Output"
 * action so the user can see the stack trace without needing to know which
 * output channel to search.
 *
 * Prefer this over a bare `vscode.window.showErrorMessage(...)` anywhere a
 * user action failed (sync, routing, rebase, worktree add/remove).
 */
export async function showError(title: string, e: unknown): Promise<void> {
	const msg = e instanceof Error ? e.message : String(e)
	log.error(`${title}: ${msg}`)
	const pick = await vscode.window.showErrorMessage(`${title}: ${msg}`, 'Open Output')
	if (pick === 'Open Output') {
		log.show()
	}
}

/**
 * Wrap an async command handler so that any rejection is caught, logged,
 * and routed through {@link showError}.  The returned function has the same
 * arity as `fn` so it can be passed directly to `vscode.commands.registerCommand`.
 */
export function withErrorHandler<T extends unknown[]>(
	fn: (...args: T) => Promise<void>,
): (...args: T) => Promise<void> {
	return async (...args: T) => {
		try {
			await fn(...args)
		} catch (e) {
			await showError('GitBraid', e)
		}
	}
}
