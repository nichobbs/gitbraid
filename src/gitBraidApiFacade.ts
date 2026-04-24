import * as vscode from 'vscode'
import type { FolderRegistry } from './folderRegistry'
import type { FolderContext } from './folderContext'
import type { GitBraidApi } from './gitBraidApi'
import type {
	GitBraidExportedAPI,
	BranchOptions,
	CommitOptions,
} from './@types/GitBraidAPI'
import type {
	BranchStackEntry,
	BranchStatus,
	StackStatus,
	AssignmentChangeEvent,
	StackChangeEvent,
} from './configTypes'

/**
 * A thin facade over `FolderRegistry` that implements `GitBraidExportedAPI`.
 *
 * Every method delegates to the `GitBraidApi` of the registry's currently-
 * active folder (active editor's folder, or the first registered folder
 * as a fallback).  External consumers — `vscode.extensions.getExtension(...)
 * .exports` callers, language-model tools, and any future MCP server — see
 * a single API object whose operations target the folder the user is
 * currently editing.
 *
 * Events are proxied through per-folder subscriptions so an assignment
 * change in any folder fires through `onDidChangeAssignment`.  That's
 * intentional — downstream listeners typically want "something changed",
 * not "something changed in folder X" — and URIs in the relativePath
 * payloads are naturally folder-scoped, so consumers that care can
 * disambiguate by joining with the current active folder's root.
 */
export class GitBraidApiFacade implements GitBraidExportedAPI, vscode.Disposable {

	private readonly _onDidChangeAssignment = new vscode.EventEmitter<AssignmentChangeEvent>()
	private readonly _onDidChangeStack = new vscode.EventEmitter<StackChangeEvent>()
	private readonly _onDidSyncFile = new vscode.EventEmitter<{ relativePath: string, branch: string }>()
	private readonly _onDidFloatFile = new vscode.EventEmitter<{ relativePath: string }>()

	readonly onDidChangeAssignment = this._onDidChangeAssignment.event
	readonly onDidChangeStack = this._onDidChangeStack.event
	readonly onDidSyncFile = this._onDidSyncFile.event
	readonly onDidFloatFile = this._onDidFloatFile.event

	private readonly _disposables: vscode.Disposable[] = []
	private readonly _ctxSubs = new Map<string, vscode.Disposable[]>()

	constructor(private readonly _registry: FolderRegistry) {
		for (const ctx of _registry.getAll()) {
			this._subscribe(ctx)
		}
		this._disposables.push(
			_registry.onDidChangeFolders((e) => {
				for (const ctx of e.added) this._subscribe(ctx)
				for (const ctx of e.removed) {
					const subs = this._ctxSubs.get(ctx.root.fsPath) ?? []
					for (const d of subs) d.dispose()
					this._ctxSubs.delete(ctx.root.fsPath)
				}
			}),
		)
	}

	private _subscribe(ctx: FolderContext): void {
		const subs: vscode.Disposable[] = [
			ctx.api.onDidChangeAssignment((e) => this._onDidChangeAssignment.fire(e)),
			ctx.api.onDidChangeStack((e) => this._onDidChangeStack.fire(e)),
			ctx.api.onDidSyncFile((e) => this._onDidSyncFile.fire(e)),
			ctx.api.onDidFloatFile((e) => this._onDidFloatFile.fire(e)),
		]
		this._ctxSubs.set(ctx.root.fsPath, subs)
	}

	dispose(): void {
		this._onDidChangeAssignment.dispose()
		this._onDidChangeStack.dispose()
		this._onDidSyncFile.dispose()
		this._onDidFloatFile.dispose()
		for (const subs of this._ctxSubs.values()) {
			for (const d of subs) d.dispose()
		}
		this._ctxSubs.clear()
		for (const d of this._disposables) d.dispose()
	}

	/** Resolve the active folder's API, throwing if the registry is empty. */
	private _api(): GitBraidApi {
		const ctx = this._registry.getActive() ?? this._registry.getAll()[0]
		if (!ctx) {
			throw new Error('GitBraid: no active workspace folder')
		}
		return ctx.api
	}

	// ── GitBraidExportedAPI surface ───────────────────────────────────────────
	// Every method is a one-line delegate to `_api()` — the facade's job is
	// to plumb "which folder" through transparently.

	getStack(): BranchStackEntry[] { return this._api().getStack() }
	async addBranch(name: string, base: string, options?: BranchOptions): Promise<void> {
		await this._api().addBranch(name, base, options)
	}
	async removeBranch(name: string, force?: boolean): Promise<void> {
		await this._api().removeBranch(name, force)
	}

	getAssignment(relativePath: string): string | undefined {
		return this._api().getAssignment(relativePath)
	}
	async assignFile(relativePath: string, branch: string): Promise<void> {
		await this._api().assignFile(relativePath, branch)
	}
	async assignHunk(relativePath: string, hunkIndex: number, branch: string): Promise<void> {
		await this._api().assignHunk(relativePath, hunkIndex, branch)
	}
	async unassignFile(relativePath: string): Promise<void> {
		await this._api().unassignFile(relativePath)
	}
	getFloatingFiles(): string[] {
		return this._api().getFloatingFiles()
	}
	async getBranchStatus(branch: string): Promise<BranchStatus> {
		return this._api().getBranchStatus(branch)
	}
	async getStackStatus(): Promise<StackStatus> {
		return this._api().getStackStatus()
	}
	async commitBranch(branch: string, message: string, options?: CommitOptions): Promise<void> {
		await this._api().commitBranch(branch, message, options)
	}
	async stageBranch(branch: string, files?: string[]): Promise<void> {
		await this._api().stageBranch(branch, files)
	}
	async reorderStack(orderedNames: string[]): Promise<void> {
		await this._api().reorderStack(orderedNames)
	}
	getHunkAssignments(relativePath: string): Map<number, string> | undefined {
		return this._api().getHunkAssignments(relativePath)
	}
	async removeHunkAssignment(relativePath: string, hunkIndex: number): Promise<void> {
		await this._api().removeHunkAssignment(relativePath, hunkIndex)
	}
	async pullBranch(branch: string): Promise<void> {
		await this._api().pullBranch(branch)
	}
	async syncBranch(branch: string): Promise<void> {
		await this._api().syncBranch(branch)
	}
	async rebaseBranch(branch: string): Promise<void> {
		await this._api().rebaseBranch(branch)
	}
	async routeHunks(relativePath: string): Promise<{ routed: number, skipped: number }> {
		return this._api().routeHunks(relativePath)
	}
}
