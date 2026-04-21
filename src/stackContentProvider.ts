import * as vscode from 'vscode'
import { log } from './channelLogger'
import { StackResolver } from './stackResolver'

/** URI scheme that the provider is registered under. */
export const STACK_SCHEME = 'gitbraid-stack'

/**
 * Exposes {@link StackResolver.getResolvedContent} as a
 * `TextDocumentContentProvider` so users can open any file through the
 * `gitbraid-stack:` scheme and see the cumulative state through the stack.
 *
 * URI shape: `gitbraid-stack:<workspace-relative-path>`
 *
 *   vscode.window.showTextDocument(
 *     vscode.Uri.parse('gitbraid-stack:src/foo.ts'),
 *   )
 *
 * The resolved document is read-only (the provider never implements write);
 * edits should go through the normal on-disk file.
 */
export class StackContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {

	private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>()
	readonly onDidChange: vscode.Event<vscode.Uri> = this._onDidChange.event

	private readonly _disposables: vscode.Disposable[] = []

	constructor(
		private readonly _resolver: StackResolver,
		private readonly _workspaceRoot: vscode.Uri,
	) {
		this._disposables.push(
			this._onDidChange,
			vscode.workspace.registerTextDocumentContentProvider(STACK_SCHEME, this),
		)
	}

	dispose(): void {
		for (const d of this._disposables) {
			d.dispose()
		}
	}

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		if (uri.scheme !== STACK_SCHEME) {
			return ''
		}
		const relativePath = uri.path.replace(/^\/+/, '')
		try {
			const content = await this._resolver.getResolvedContent(this._workspaceRoot, relativePath)
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
	refresh(relativePath: string): void {
		this._onDidChange.fire(vscode.Uri.parse(`${STACK_SCHEME}:${relativePath}`))
	}

	/** Build a `gitbraid-stack:` URI for the given workspace-relative path. */
	static uriFor(relativePath: string): vscode.Uri {
		return vscode.Uri.parse(`${STACK_SCHEME}:${relativePath}`)
	}
}
