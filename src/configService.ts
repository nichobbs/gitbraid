import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { log } from './channelLogger'
import { ConfigError } from './errors'
import {
	AssignmentChangeEvent,
	BranchConfig,
	BranchStackEntry,
	StackChangeEvent,
	emptyConfig,
	isValidConfig,
	migrateConfig,
} from './configTypes'

const CONFIG_FILENAME = 'local-config.json'
const WORKTREES_DIR = '.worktrees'

/**
 * Manages reading and writing `.worktrees/local-config.json`.
 *
 * The file is never committed to the repository. A missing file is treated
 * as an empty (but valid) config — not an error.
 *
 * All write operations are atomic: content is written to a `.tmp` file and
 * then renamed over the target to avoid corruption on crash.
 */
export class ConfigService implements vscode.Disposable {

	private static _instance: ConfigService | undefined

	private _config: BranchConfig = emptyConfig()
	private _configPath: string | undefined

	private readonly _onDidChangeAssignment = new vscode.EventEmitter<AssignmentChangeEvent>()
	private readonly _onDidChangeStack = new vscode.EventEmitter<StackChangeEvent>()

	readonly onDidChangeAssignment: vscode.Event<AssignmentChangeEvent> = this._onDidChangeAssignment.event
	readonly onDidChangeStack: vscode.Event<StackChangeEvent> = this._onDidChangeStack.event

	private constructor() {}

	static getInstance(): ConfigService {
		if (!ConfigService._instance) {
			ConfigService._instance = new ConfigService()
		}
		return ConfigService._instance
	}

	/** Reset the singleton — for use in tests only. */
	static resetInstance(): void {
		ConfigService._instance?.dispose()
		ConfigService._instance = undefined
	}

	dispose(): void {
		this._onDidChangeAssignment.dispose()
		this._onDidChangeStack.dispose()
	}

	// ─── Initialisation ──────────────────────────────────────────────────────

	/**
	 * Load config from disk. Call once at extension activation.
	 * Subsequent writes keep the in-memory state in sync; no need to reload.
	 */
	async load(workspaceRoot: vscode.Uri): Promise<void> {
		const worktreesDir = vscode.Uri.joinPath(workspaceRoot, WORKTREES_DIR)
		this._configPath = path.join(worktreesDir.fsPath, CONFIG_FILENAME)
		this._config = await this._readFromDisk()
		log.info('ConfigService loaded (' + this._config.stack.length + ' branches, ' +
			Object.keys(this._config.assignments).length + ' assignments)')
	}

	// ─── Stack queries ────────────────────────────────────────────────────────

	/** Returns a copy of the stack entries sorted by order (ascending). */
	getStack(): BranchStackEntry[] {
		return [...this._config.stack].sort((a, b) => a.order - b.order)
	}

	getBranch(name: string): BranchStackEntry | undefined {
		return this._config.stack.find((e) => e.name === name)
	}

	// ─── Assignment queries ───────────────────────────────────────────────────

	/** Returns the branch assigned to the given workspace-relative path, or `undefined`. */
	getAssignment(relativePath: string): string | undefined {
		return this._config.assignments[normalisePath(relativePath)]
	}

	/** Returns all assignments as a map copy. */
	getAllAssignments(): Record<string, string> {
		return { ...this._config.assignments }
	}

	// ─── Mutations ────────────────────────────────────────────────────────────

	async setAssignment(relativePath: string, branch: string): Promise<void> {
		const key = normalisePath(relativePath)
		if (!this._config.stack.some((e) => e.name === branch)) {
			throw new ConfigError(`Branch "${branch}" is not in the stack`)
		}
		const previous = this._config.assignments[key]
		this._config.assignments[key] = branch
		await this._writeToDisk()
		this._onDidChangeAssignment.fire({ relativePath: key, branch, previousBranch: previous })
	}

	async removeAssignment(relativePath: string): Promise<void> {
		const key = normalisePath(relativePath)
		const previous = this._config.assignments[key]
		if (previous === undefined) {
			return
		}
		delete this._config.assignments[key]
		await this._writeToDisk()
		this._onDidChangeAssignment.fire({ relativePath: key, branch: undefined, previousBranch: previous })
	}

	async addBranch(entry: Omit<BranchStackEntry, 'order'> & { order?: number }): Promise<void> {
		if (this._config.stack.some((e) => e.name === entry.name)) {
			throw new ConfigError(`Branch "${entry.name}" already exists in the stack`)
		}
		const maxOrder = this._config.stack.reduce((m, e) => Math.max(m, e.order), 0)
		const newEntry: BranchStackEntry = {
			...entry,
			order: entry.order ?? maxOrder + 1,
		}
		this._config.stack.push(newEntry)
		await this._writeToDisk()
		this._onDidChangeStack.fire({ type: 'add', branch: entry.name })
	}

	async removeBranch(name: string): Promise<void> {
		const idx = this._config.stack.findIndex((e) => e.name === name)
		if (idx === -1) {
			return
		}
		this._config.stack.splice(idx, 1)
		// Remove all file assignments for this branch
		for (const key of Object.keys(this._config.assignments)) {
			if (this._config.assignments[key] === name) {
				delete this._config.assignments[key]
			}
		}
		await this._writeToDisk()
		this._onDidChangeStack.fire({ type: 'remove', branch: name })
	}

	async reorderStack(orderedNames: string[]): Promise<void> {
		for (let i = 0; i < orderedNames.length; i++) {
			const entry = this._config.stack.find((e) => e.name === orderedNames[i])
			if (entry) {
				entry.order = i + 1
			}
		}
		await this._writeToDisk()
		this._onDidChangeStack.fire({ type: 'reorder', branch: orderedNames[0] ?? '' })
	}

	// ─── Private helpers ──────────────────────────────────────────────────────

	private async _readFromDisk(): Promise<BranchConfig> {
		if (!this._configPath) {
			return emptyConfig()
		}
		try {
			const raw = fs.readFileSync(this._configPath, 'utf-8')
			const parsed: unknown = JSON.parse(raw)
			if (!isValidConfig(parsed)) {
				log.warn('ConfigService: config file has unexpected structure, using empty config')
				return emptyConfig()
			}
			return migrateConfig(parsed)
		} catch (e: unknown) {
			if (isNodeError(e) && e.code === 'ENOENT') {
				// Missing file is fine — user hasn't set up a stack yet
				log.info('ConfigService: no config file found, starting with empty config')
				return emptyConfig()
			}
			if (e instanceof SyntaxError) {
				log.warn('ConfigService: malformed JSON in config file, using empty config: ' + e.message)
				return emptyConfig()
			}
			throw new ConfigError('Failed to read config: ' + String(e))
		}
	}

	/**
	 * Write the current in-memory config to disk atomically.
	 * On the first write, ensures `.worktrees/` is present in `.gitignore`.
	 */
	private async _writeToDisk(): Promise<void> {
		if (!this._configPath) {
			throw new ConfigError('ConfigService not initialised — call load() first')
		}
		const dir = path.dirname(this._configPath)
		fs.mkdirSync(dir, { recursive: true })

		const content = JSON.stringify(this._config, null, 2) + '\n'
		const tmpPath = this._configPath + '.tmp'
		fs.writeFileSync(tmpPath, content, 'utf-8')
		fs.renameSync(tmpPath, this._configPath)

		await this._ensureGitignore()
	}

	/**
	 * Ensure `.worktrees/` appears in the repo root `.gitignore`.
	 * Creates or appends silently — this must never be committed.
	 */
	private async _ensureGitignore(): Promise<void> {
		if (!this._configPath) {
			return
		}
		// Walk up from .worktrees to the workspace root
		const worktreesDir = path.dirname(this._configPath)
		const repoRoot = path.dirname(worktreesDir)
		const gitignorePath = path.join(repoRoot, '.gitignore')

		const entry = '.worktrees/'
		try {
			const existing = fs.readFileSync(gitignorePath, 'utf-8')
			if (existing.split('\n').some((l) => l.trim() === entry || l.trim() === '.worktrees')) {
				return
			}
			const separator = existing.endsWith('\n') ? '' : '\n'
			fs.appendFileSync(gitignorePath, separator + entry + '\n', 'utf-8')
			log.info('ConfigService: added .worktrees/ to .gitignore')
		} catch (e: unknown) {
			if (isNodeError(e) && e.code === 'ENOENT') {
				fs.writeFileSync(gitignorePath, entry + '\n', 'utf-8')
				log.info('ConfigService: created .gitignore with .worktrees/ entry')
				return
			}
			log.warn('ConfigService: could not update .gitignore: ' + String(e))
		}
	}
}

function normalisePath(p: string): string {
	return p.replace(/\\/g, '/')
}

function isNodeError(e: unknown): e is NodeJS.ErrnoException {
	return e instanceof Error && 'code' in e
}
