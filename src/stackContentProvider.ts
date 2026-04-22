import * as vscode from 'vscode'
import { log } from './channelLogger'
import type { FolderRegistry } from './folderRegistry'
import type { StackResolver } from './stackResolver'
/** URI scheme that the provider is registered under. */
export const STACK_SCHEME = 'gitbraid-stack'

/**
 * URI scheme for the "base" side of the cumulative stack diff view.
 * Content is `git show <commit>:<file>` where the commit ref is encoded
 * in the `commit=` query parameter.
 */
export const STACK_BASE_SCHEME = 'gitbraid-base'

/**
 * Exposes {@link StackResolver.getResolvedContent} as a
 * `TextDocumentContentProvider` so users can open any file through the
 * `gitbraid-stack:` scheme and see the cumulative state through the stack.
 *
 * URI shape: `gitbraid-stack:<workspace-relative-path>?folder=<encoded-fspath>`
 *
 *   StackContentProvider.uriFor('src/foo.ts', folderRoot)
 *
 * The `folder` query parameter routes the request to the owning folder's
 * `StackResolver` in multi-root workspaces.  When the parameter is missing
 * (legacy URIs, single-folder workspaces) the provider falls back to the
 * primary folder.  Including the folder in the query also makes URIs unique
 * across folders so VS Code's document cache doesn't collide across them.
 *
 * The resolved document is read-only (the provider never implements write);
 * edits should go through the normal on-disk file.
 */
export class StackContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {

	private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>()
	readonly onDidChange: vscode.Event<vscode.Uri> = this._onDidChange.event

	private readonly _disposables: vscode.Disposable[] = []

	constructor(
		private readonly _registry: FolderRegistry | undefined,
		private readonly _primaryRoot: vscode.Uri,
		private readonly _primaryResolver: StackResolver,
	) {
		this._disposables.push(
			this._onDidChange,
			vscode.workspace.registerTextDocumentContentProvider(STACK_SCHEME, this),
			vscode.workspace.registerTextDocumentContentProvider(STACK_BASE_SCHEME, this),
		)
	}

	dispose(): void {
		for (const d of this._disposables) {
			d.dispose()
		}
	}

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		if (uri.scheme !== STACK_SCHEME && uri.scheme !== STACK_BASE_SCHEME) {
			return ''
		}

		const { resolver, root, relativePath } = this._resolve(uri)

		if (uri.scheme === STACK_BASE_SCHEME) {
			const commit = parseCommitQuery(uri.query)
			if (!commit) return ''
			try {
				const content = await resolver.getCommittedContent(root.fsPath, commit, relativePath)
				return content ? new TextDecoder().decode(content) : ''
			} catch (e) {
				log.warn(`StackContentProvider: failed to resolve base ${commit}:${relativePath}: ${e instanceof Error ? e.message : String(e)}`)
				return ''
			}
		}

		try {
			const content = await resolver.getResolvedContent(root, relativePath)
			if (!content) {
				return ''
			}
			return new TextDecoder().decode(content)
		} catch (e) {
			log.warn(`StackContentProvider: failed to resolve ${relativePath}: ${e instanceof Error ? e.message : String(e)}`)
			return ''
		}
	}

	/** Tell VS Code that a given file's resolved content has changed. */
	refresh(relativePath: string, folderRoot?: vscode.Uri): void {
		this._onDidChange.fire(StackContentProvider.uriFor(relativePath, folderRoot))
	}

	/**
	 * Build a `gitbraid-stack:` URI for the given workspace-relative path.
	 * Pass `folderRoot` in multi-root workspaces so the provider routes the
	 * request to the right folder's `StackResolver`.
	 */
	static uriFor(relativePath: string, folderRoot?: vscode.Uri): vscode.Uri {
		const base = vscode.Uri.parse(`${STACK_SCHEME}:${relativePath}`)
		if (!folderRoot) return base
		return base.with({ query: `folder=${encodeURIComponent(folderRoot.fsPath)}` })
	}

	/**
	 * Build a `gitbraid-base:` URI for the given path at a specific commit ref.
	 * Used as the "before" side of the cumulative stack diff view.
	 */
	static baseUriFor(relativePath: string, commit: string, folderRoot?: vscode.Uri): vscode.Uri {
		const base = vscode.Uri.parse(`${STACK_BASE_SCHEME}:${relativePath}`)
		const params: string[] = [`commit=${encodeURIComponent(commit)}`]
		if (folderRoot) params.push(`folder=${encodeURIComponent(folderRoot.fsPath)}`)
		return base.with({ query: params.join('&') })
	}

	/** Map a URI to the owning folder's resolver / root. */
	private _resolve(uri: vscode.Uri): { resolver: StackResolver, root: vscode.Uri, relativePath: string } {
		const relativePath = uri.path.replace(/^\/+/, '')
		const folderFsPath = parseFolderQuery(uri.query)
		if (folderFsPath && this._registry) {
			const ctx = this._registry.getAll().find((c) => c.root.fsPath === folderFsPath)
			if (ctx) {
				return { resolver: ctx.stackResolver, root: ctx.root, relativePath }
			}
		}
		return { resolver: this._primaryResolver, root: this._primaryRoot, relativePath }
	}
}

function parseFolderQuery(query: string): string | undefined {
	if (!query) return undefined
	for (const pair of query.split('&')) {
		const [key, value] = pair.split('=')
		if (key === 'folder' && value) {
			try { return decodeURIComponent(value) } catch { return undefined }
		}
	}
	return undefined
}

function parseCommitQuery(query: string): string | undefined {
	if (!query) return undefined
	for (const pair of query.split('&')) {
		const [key, value] = pair.split('=')
		if (key === 'commit' && value) {
			try { return decodeURIComponent(value) } catch { return undefined }
		}
	}
	return undefined
}
