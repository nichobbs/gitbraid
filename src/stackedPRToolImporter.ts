import * as vscode from 'vscode'
import * as path from 'node:path'
import { promises as fsp } from 'node:fs'
import { log } from './channelLogger'
import { ConfigService } from './configService'
import { BranchStackEntry } from './configTypes'
import { IGitRunner, getDefaultGitRunner } from './gitRunner'

/**
 * Names of stacked-PR tools this importer knows how to read metadata from.
 * `'upstream'` is the fallback — it uses only the tracking-branch info
 * already present in `.git/config`, so it covers repos that aren't using
 * any named tool but still have parent/child branch relationships.
 */
export type StackedTool =
	| 'graphite'
	| 'git-spr'
	| 'git-stack'
	| 'gitbutler'
	| 'upstream'

/** One import-candidate branch derived from a tool's metadata. */
export interface DetectedBranch {
	name: string
	base: string
	/** 1-based position from the base of the stack (topological). */
	order: number
}

/** Result of probing the repo for one tool's metadata. */
export interface DetectedStack {
	tool: StackedTool
	/** Human-readable source path / config key — shown in the preview. */
	source: string
	branches: DetectedBranch[]
	warnings: string[]
}

/** Diff between a detected stack and the current GitBraid config. */
export interface ImportPreview {
	tool: StackedTool
	source: string
	newBranches: DetectedBranch[]
	conflicts: Array<{
		detected: DetectedBranch
		existing: BranchStackEntry
	}>
	/** Branches referenced as a base but missing from the detected set. */
	unknownBases: string[]
	warnings: string[]
}

/** Summary returned from `apply()`. */
export interface ImportSummary {
	tool: StackedTool
	addedBranches: number
	skipped: number
	errors: Array<{ branch: string, message: string }>
}

/**
 * Cross-tool stack importer (RM-012).
 *
 * Detects metadata written by Graphite, git-spr, git-stack, or GitButler
 * (and a plain-git upstream fallback), previews the inferred branch stack,
 * and on apply seeds `.worktrees/local-config.json` via {@link ConfigService}
 * so the user doesn't have to rebuild their stack by hand when moving to
 * GitBraid.
 *
 * See `docs/plans/07-import-from-tools.md` for the full design rationale.
 *
 * The importer is read-only with respect to the source tool; it does not
 * delete or mutate any of the source metadata.
 */
export class StackedPRToolImporter {

	constructor(
		private readonly _config: ConfigService,
		private readonly _workspaceRoot: vscode.Uri,
		private readonly _runner: IGitRunner = getDefaultGitRunner(),
	) {}

	/**
	 * Probe the repo for every tool we know about and return a result for
	 * each match.  Order of the returned array is stable: graphite,
	 * git-stack, git-spr, gitbutler, upstream — so a QuickPick rendering
	 * them in that order is deterministic.
	 */
	async detectAll(): Promise<DetectedStack[]> {
		const root = this._workspaceRoot.fsPath
		const results: DetectedStack[] = []

		const detectors: Array<() => Promise<DetectedStack | undefined>> = [
			() => detectGraphite(root),
			() => detectGitStack(root, this._runner),
			() => detectGitSpr(root, this._runner),
			() => detectGitButler(root),
			() => detectUpstream(root, this._runner),
		]

		for (const fn of detectors) {
			try {
				const found = await fn()
				if (found && found.branches.length > 0) {
					results.push(found)
				}
			} catch (e: unknown) {
				log.warn('StackedPRToolImporter: detector failed — ' + (e instanceof Error ? e.message : String(e)))
			}
		}

		return results
	}

	/**
	 * Best-effort activation-time suggestion, gated by
	 * `gitbraid.suggestImportOnActivate` (default off — this only runs for
	 * users who've opted in). Mirrors `StackShareService.detectAndOfferTemplate`'s
	 * pattern: only offers when the stack is still empty, so an existing
	 * setup (built by hand or via a previous import) is never second-guessed.
	 *
	 * Delegates the actual import flow to `gitbraid.importStackedTool` —
	 * which re-detects, shows a tool picker when more than one match is
	 * found, previews the diff, and asks for confirmation — rather than
	 * duplicating that UI here.
	 */
	async suggestImportIfEmpty(): Promise<void> {
		if (!vscode.workspace.getConfiguration('gitbraid').get<boolean>('suggestImportOnActivate', false)) return
		if (this._config.getStack().length > 0) return
		const detected = await this.detectAll().catch(() => [])
		if (detected.length === 0) return
		const tools = [...new Set(detected.map((d) => d.tool))].join(', ')
		const pick = await vscode.window.showInformationMessage(
			`GitBraid: detected existing stacked-branch metadata (${tools}) in this repository. Import it?`,
			'Import…', 'Dismiss',
		)
		if (pick === 'Import…') {
			await vscode.commands.executeCommand('gitbraid.importStackedTool')
		}
	}

	/**
	 * Diff a detected stack against the current GitBraid config.
	 */
	preview(stack: DetectedStack): ImportPreview {
		const current = new Map(
			this._config.getStack().map((e) => [e.name, e] as const),
		)
		const detectedNames = new Set(stack.branches.map((b) => b.name))
		const newBranches: DetectedBranch[] = []
		const conflicts: Array<{ detected: DetectedBranch, existing: BranchStackEntry }> = []
		const unknownBases = new Set<string>()

		for (const b of stack.branches) {
			const existing = current.get(b.name)
			if (existing) {
				conflicts.push({ detected: b, existing })
			} else {
				newBranches.push(b)
			}
			// Flag bases that aren't in the detected set and aren't already
			// known to us — these will be preserved literally and rely on
			// the branch existing in git.
			if (!detectedNames.has(b.base) && !current.has(b.base)) {
				unknownBases.add(b.base)
			}
		}

		return {
			tool: stack.tool,
			source: stack.source,
			newBranches,
			conflicts,
			unknownBases: [...unknownBases].sort(),
			warnings: stack.warnings,
		}
	}

	/**
	 * Apply a detected stack.  New branches are added in topological order
	 * so every `base` reference is already in the config when the next
	 * entry is added.  Conflicts are skipped unless `overwriteExisting` is
	 * set, in which case the existing config entry is replaced.
	 */
	async apply(
		stack: DetectedStack,
		overwriteExisting = false,
	): Promise<ImportSummary> {
		const summary: ImportSummary = {
			tool: stack.tool,
			addedBranches: 0,
			skipped: 0,
			errors: [],
		}

		// Sort by detected order so parents land before children.
		const sorted = [...stack.branches].sort((a, b) => a.order - b.order)
		const preview = this.preview(stack)
		const conflictNames = new Set(preview.conflicts.map((c) => c.detected.name))

		for (const b of sorted) {
			if (conflictNames.has(b.name) && !overwriteExisting) {
				summary.skipped += 1
				continue
			}
			if (conflictNames.has(b.name) && overwriteExisting) {
				try {
					await this._config.removeBranch(b.name)
				} catch (e: unknown) {
					summary.errors.push({
						branch: b.name,
						message: 'removeBranch failed: ' + (e instanceof Error ? e.message : String(e)),
					})
					continue
				}
			}
			try {
				await this._config.addBranch({
					name: b.name,
					base: b.base,
					color: '#888888',
					order: b.order,
				})
				summary.addedBranches += 1
			} catch (e: unknown) {
				summary.errors.push({
					branch: b.name,
					message: e instanceof Error ? e.message : String(e),
				})
			}
		}

		log.info('StackedPRToolImporter.apply: ' + JSON.stringify(summary))
		return summary
	}
}

// ─── Detectors ──────────────────────────────────────────────────────────────
//
// Each detector returns a `DetectedStack` or `undefined` if no metadata was
// found.  They are deliberately side-effect-free against the source tool and
// safe to call at activation time.

/**
 * Graphite writes its parent metadata in two places depending on version:
 *   - `.git/refs/branch-metadata/<branch>` — a plain file whose content is a
 *     JSON blob `{ parentBranchName: "…" }`.
 *   - `.graphite_repo_config` — JSON at the repo root listing trunk + ignore
 *     lists (no parent mapping; only used to confirm Graphite is active).
 *
 * We read the metadata refs directly from the filesystem to avoid depending
 * on `gt` being on `PATH`.  When the metadata refs don't parse as JSON we
 * skip the entry with a warning rather than aborting the whole detection.
 */
export async function detectGraphite(repoRoot: string): Promise<DetectedStack | undefined> {
	const metadataDir = path.join(repoRoot, '.git', 'refs', 'branch-metadata')
	const repoConfig = path.join(repoRoot, '.graphite_repo_config')

	let metadataExists = false
	try {
		const stat = await fsp.stat(metadataDir)
		metadataExists = stat.isDirectory()
	} catch { /* missing — fine */ }

	let repoConfigExists = false
	try {
		await fsp.access(repoConfig)
		repoConfigExists = true
	} catch { /* missing — fine */ }

	if (!metadataExists && !repoConfigExists) {
		return undefined
	}

	const warnings: string[] = []
	const parentMap = new Map<string, string>() // branch → parent

	if (metadataExists) {
		const files = await listFiles(metadataDir)
		for (const file of files) {
			const branch = path.relative(metadataDir, file).replace(/\\/g, '/')
			let raw: string
			try {
				raw = await fsp.readFile(file, 'utf-8')
			} catch (e: unknown) {
				warnings.push(`Could not read metadata for ${branch}: ${(e as Error).message}`)
				continue
			}
			const parsed = tryParseJson(raw)
			if (!parsed || typeof parsed !== 'object') {
				warnings.push(`Unparseable metadata for ${branch}`)
				continue
			}
			const parent = (parsed as Record<string, unknown>).parentBranchName
			if (typeof parent === 'string' && parent.length > 0) {
				parentMap.set(branch, parent)
			}
		}
	}

	if (parentMap.size === 0) {
		if (repoConfigExists) {
			warnings.push('Graphite config present but no per-branch parent metadata found.')
		}
		return undefined
	}

	const branches = topologicalSort(parentMap)
	return {
		tool: 'graphite',
		source: metadataDir,
		branches,
		warnings,
	}
}

/**
 * git-stack writes parent metadata as symbolic refs under
 * `refs/branch-stack/<branch>`.  Each ref's target is the parent branch.
 * We read it with `git for-each-ref` + `git symbolic-ref` rather than
 * touching `.git/refs/` directly (git-stack also supports packed refs).
 */
export async function detectGitStack(
	repoRoot: string,
	runner: IGitRunner,
): Promise<DetectedStack | undefined> {
	const refs = await runner.run(
		['for-each-ref', '--format=%(refname:short)', 'refs/branch-stack'],
		{ cwd: repoRoot },
	)
	if (refs.exitCode !== 0 || refs.stdout.trim() === '') {
		return undefined
	}

	const warnings: string[] = []
	const parentMap = new Map<string, string>()
	const names = refs.stdout.split('\n').map((s) => s.trim()).filter(Boolean)

	for (const full of names) {
		const branch = full.replace(/^branch-stack\//, '')
		const target = await runner.run(
			['symbolic-ref', `refs/branch-stack/${branch}`],
			{ cwd: repoRoot },
		)
		if (target.exitCode !== 0) {
			warnings.push(`No symbolic-ref for branch-stack/${branch}`)
			continue
		}
		const parent = target.stdout.trim().replace(/^refs\/heads\//, '')
		if (parent && parent !== branch) {
			parentMap.set(branch, parent)
		}
	}

	if (parentMap.size === 0) {
		return undefined
	}

	return {
		tool: 'git-stack',
		source: 'refs/branch-stack/*',
		branches: topologicalSort(parentMap),
		warnings,
	}
}

/**
 * git-spr identifies each PR-shaped commit with a `pr-<id>` trailer.  We
 * look at the tip commit of every local branch (excluding the default
 * branch); any branch whose tip commit carries `pr-<id>` is part of a
 * git-spr stack.  We then derive parent/child order via the first-parent
 * walk from the default branch up to each tip.
 */
export async function detectGitSpr(
	repoRoot: string,
	runner: IGitRunner,
): Promise<DetectedStack | undefined> {
	const branchList = await runner.run(
		['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
		{ cwd: repoRoot },
	)
	if (branchList.exitCode !== 0) return undefined

	const all = branchList.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
	if (all.length === 0) return undefined

	const trailerRe = /^pr-\d+$/m
	const sprBranches: Array<{ name: string, sha: string, id: string }> = []

	for (const name of all) {
		const body = await runner.run(
			['log', '-1', '--format=%B', name],
			{ cwd: repoRoot },
		)
		if (body.exitCode !== 0) continue
		const trailer = body.stdout.split('\n').reverse().find((l) => trailerRe.test(l))
		if (!trailer) continue
		const shaResult = await runner.run(['rev-parse', name], { cwd: repoRoot })
		sprBranches.push({
			name,
			sha: shaResult.stdout.trim(),
			id: trailer.trim(),
		})
	}

	if (sprBranches.length === 0) return undefined

	// Pick the trunk — prefer `main` / `master` / the configured default.
	const trunkResult = await runner.run(['symbolic-ref', '--short', 'HEAD'], { cwd: repoRoot })
	const trunkCandidate = trunkResult.stdout.trim()
	const trunk = ['main', 'master', trunkCandidate].find((n) => all.includes(n) && !sprBranches.some((b) => b.name === n))
		?? 'main'

	const warnings: string[] = []
	const parentMap = new Map<string, string>()

	// Determine order by the number of commits each branch is ahead of trunk.
	const scored: Array<{ name: string, ahead: number }> = []
	for (const b of sprBranches) {
		const countResult = await runner.run(
			['rev-list', '--count', `${trunk}..${b.name}`],
			{ cwd: repoRoot },
		)
		const ahead = Number.parseInt(countResult.stdout.trim(), 10)
		if (Number.isNaN(ahead)) {
			warnings.push(`Could not count commits ahead for ${b.name}`)
			continue
		}
		scored.push({ name: b.name, ahead })
	}

	scored.sort((a, b) => a.ahead - b.ahead)
	for (let i = 0; i < scored.length; i++) {
		const parent = i === 0 ? trunk : scored[i - 1].name
		parentMap.set(scored[i].name, parent)
	}

	if (parentMap.size === 0) return undefined

	return {
		tool: 'git-spr',
		source: 'commit-message trailers (pr-*)',
		branches: topologicalSort(parentMap),
		warnings,
	}
}

/**
 * GitButler persists virtual-branch state in
 * `.git/gitbutler/virtual_branches.toml`.  We parse only the fields we
 * need — `[branches.<id>]` sections with `name` and optional `upstream`.
 * A hand-rolled minimal parser is used so we don't take a runtime
 * dependency on `@iarna/toml` just for this detector.
 */
export async function detectGitButler(repoRoot: string): Promise<DetectedStack | undefined> {
	const tomlPath = path.join(repoRoot, '.git', 'gitbutler', 'virtual_branches.toml')
	let raw: string
	try {
		raw = await fsp.readFile(tomlPath, 'utf-8')
	} catch {
		return undefined
	}

	const branches = parseGitButlerToml(raw)
	if (branches.length === 0) return undefined

	const parentMap = new Map<string, string>()
	for (const b of branches) {
		if (b.upstream && b.upstream !== b.name) {
			parentMap.set(b.name, b.upstream)
		}
	}

	if (parentMap.size === 0) {
		// Flat — treat every virtual branch as a layer above main.
		for (const b of branches) {
			parentMap.set(b.name, 'main')
		}
	}

	return {
		tool: 'gitbutler',
		source: tomlPath,
		branches: topologicalSort(parentMap),
		warnings: [],
	}
}

/**
 * Fallback when no specialised tool is in use: read every
 * `branch.<name>.merge` setting from `.git/config` and treat any branch
 * whose upstream is another local branch as parented to that branch.
 *
 * This is noisy — many repos have upstream = `origin/<same-name>` which
 * is not what we want — so we filter to upstreams that name a different
 * *local* branch.
 */
export async function detectUpstream(
	repoRoot: string,
	runner: IGitRunner,
): Promise<DetectedStack | undefined> {
	const configResult = await runner.run(
		['config', '--local', '--get-regexp', 'branch\\..*\\.merge'],
		{ cwd: repoRoot },
	)
	if (configResult.exitCode !== 0 || configResult.stdout.trim() === '') return undefined

	const headsResult = await runner.run(
		['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
		{ cwd: repoRoot },
	)
	const heads = new Set(
		headsResult.stdout.split('\n').map((s) => s.trim()).filter(Boolean),
	)

	const parentMap = new Map<string, string>()
	for (const line of configResult.stdout.split('\n')) {
		const match = /^branch\.(.+)\.merge (.+)$/.exec(line.trim())
		if (!match) continue
		const [, name, target] = match
		// target looks like `refs/heads/<parent>`; reject remotes & same-name.
		const parent = target.replace(/^refs\/heads\//, '')
		if (!heads.has(parent) || parent === name) continue
		parentMap.set(name, parent)
	}

	if (parentMap.size === 0) return undefined

	return {
		tool: 'upstream',
		source: '.git/config (branch.*.merge)',
		branches: topologicalSort(parentMap),
		warnings: [],
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Recursively list files under `dir` (POSIX separators). */
async function listFiles(dir: string): Promise<string[]> {
	const out: string[] = []
	async function walk(current: string): Promise<void> {
		let entries: Array<{ name: string, isDirectory: () => boolean, isFile: () => boolean }> = []
		try {
			entries = await fsp.readdir(current, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			const full = path.join(current, entry.name)
			if (entry.isDirectory()) {
				await walk(full)
			} else if (entry.isFile()) {
				out.push(full)
			}
		}
	}
	await walk(dir)
	return out
}

/**
 * Topological sort of a parent-map: returns the branches in order such that
 * every branch comes after its parent.  Cycles break by emitting the
 * cycle-start branch at its current depth and marking a warning via the
 * returned `order` being stable (tests cover this).
 */
function topologicalSort(parentMap: Map<string, string>): DetectedBranch[] {
	const depthCache = new Map<string, number>()

	function depthOf(name: string, visiting: Set<string>): number {
		const cached = depthCache.get(name)
		if (cached !== undefined) return cached
		if (visiting.has(name)) {
			// Cycle: freeze at 0 to avoid infinite recursion.
			return 0
		}
		const parent = parentMap.get(name)
		if (parent === undefined) {
			depthCache.set(name, 0)
			return 0
		}
		visiting.add(name)
		const d = 1 + depthOf(parent, visiting)
		visiting.delete(name)
		depthCache.set(name, d)
		return d
	}

	const names = [...parentMap.keys()]
	const withDepth = names.map((n) => ({ name: n, depth: depthOf(n, new Set()) }))
	withDepth.sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name))

	return withDepth.map((entry, i) => ({
		name: entry.name,
		base: parentMap.get(entry.name) ?? 'main',
		order: i + 1,
	}))
}

function tryParseJson(raw: string): unknown {
	try {
		return JSON.parse(raw)
	} catch {
		return undefined
	}
}

/**
 * Minimal TOML parser scoped to the GitButler file layout.  Supports:
 *   [branches.<key>]
 *   name = "string"
 *   upstream = "string"
 *
 * Anything else is ignored.  Strings may be "double" or 'single' quoted;
 * escape sequences are not interpreted (none appear in practice for
 * branch names, which are git-validated).
 */
export function parseGitButlerToml(
	raw: string,
): Array<{ name: string, upstream?: string }> {
	const branches: Array<{ name: string, upstream?: string }> = []
	const lines = raw.split(/\r?\n/)
	let inBranchSection = false
	let current: { name?: string, upstream?: string } = {}

	const flush = (): void => {
		if (current.name) {
			branches.push({ name: current.name, upstream: current.upstream })
		}
		current = {}
	}

	for (const rawLine of lines) {
		const line = rawLine.trim()
		if (line.startsWith('[')) {
			flush()
			inBranchSection = /^\[branches\./.test(line)
			continue
		}
		if (!inBranchSection || line === '' || line.startsWith('#')) continue
		const kv = /^(name|upstream)\s*=\s*(['"])(.+)\2\s*(?:#.*)?$/.exec(line)
		if (!kv) continue
		if (kv[1] === 'name') current.name = kv[3]
		else current.upstream = kv[3]
	}
	flush()

	return branches
}
