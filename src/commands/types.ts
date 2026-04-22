import type * as vscode from 'vscode'
import type { FolderRegistry } from '../folderRegistry'
import type { FolderContext } from '../folderContext'
import type { BranchStackTreeProvider, FloatingStatusBarItem } from '../branchStackTreeProvider'
import type { OverlayDiagnostics } from '../hunkCodeLensProvider'
import type { PRAwareness } from '../prAwareness'

/**
 * Shared dependencies threaded through to every command registration module.
 * Each module's `register*Commands(deps)` function closes over these instead
 * of closing over `activate()`-local variables.
 */
export interface CommandDeps {
	/** Full folder registry — used for multi-root folder iteration and lookup. */
	registry: FolderRegistry
	/** Primary (first) folder context — fallback when no active editor. */
	primary: FolderContext
	/** Returns the folder context for the currently active editor. */
	activeContext: () => FolderContext
	/** Returns the folder context that owns a URI, falling back to activeContext. */
	contextForUri: (uri: vscode.Uri | undefined) => FolderContext
	/** Compute a path relative to a folder context's root. */
	relativePathIn: (ctx: FolderContext, uri: vscode.Uri) => string
	/**
	 * Resolve a branch name from a command argument (string, SCM SourceControl
	 * object, BranchNode) or prompt the user with a QuickPick.
	 */
	resolveBranchNameArg: (arg: unknown, placeholder: string) => Promise<string | undefined>
	/**
	 * Resolve a branch name and its worktree directory — shows a warning if
	 * the stack is empty or the worktree doesn't exist.
	 */
	resolveActiveBranchWorktree: (
		arg: unknown,
		placeholder: string,
	) => Promise<{ ctx: FolderContext, worktreeDir: string } | undefined>
	/**
	 * Extract a `vscode.Uri` from an Explorer drag argument, SCM resource
	 * state, or tree node.
	 */
	extractFileUri: (a: unknown) => vscode.Uri | undefined
	/** Singleton tree provider — needed by a few view commands. */
	stackTreeProvider: BranchStackTreeProvider
	/** The tree view itself — needed for `focusStackView`. */
	stackView: vscode.TreeView<any>
	/** Status bar item — needed by `showActiveFolder` to rebind on switch. */
	statusBar: FloatingStatusBarItem
	/** PR awareness singleton — needed by `refreshPRStatus`. */
	prAwareness: PRAwareness
	/** Overlay diagnostics — needed after hunk assignment changes. */
	overlayDiagnostics: OverlayDiagnostics
}
