import { ConfigService } from './configService'
import { WorkspaceSync } from './workspaceSync'
import { IGitRunner, getDefaultGitRunner } from './gitRunner'
import type { PRAwareness } from './prAwareness'
import type { CommitSummary } from './commitListService'

/**
 * Plan 02 — Wave A/C: shared snapshot of the stack used by the dashboard
 * webview, the `gitbraid_getStackDiagram` LM tool, and the MCP server.
 *
 * This module is **pure** with respect to VS Code APIs — all inputs
 * (services) are passed explicitly so the snapshot can be computed in a
 * test harness without a running extension host.
 */

/** Checks-status rollup shown next to a PR pill. */
export type ChecksStatus = 'pending' | 'success' | 'failure'

/** One row per branch in the snapshot. */
export interface SnapshotBranch {
	name: string
	base: string
	order: number
	color: string
	scratch?: boolean

	/** `true` when this is the currently checked-out branch. */
	isCurrent?: boolean

	/** Number of files in `ConfigService.getAllAssignments()` pointing at this branch. */
	assignedFilesCount: number

	/** Branch is flagged `singleCommit: true` in config. */
	singleCommit: boolean

	/** Commits the branch contains beyond its parent (`rev-list --count base..branch`). */
	aheadCount?: number
	/** Commits the parent has beyond the branch. */
	behindCount?: number

	prNumber?: number
	prState?: 'open' | 'draft' | 'merged' | 'closed'
	prTitle?: string
	prUrl?: string

	checksStatus?: ChecksStatus

	// ── Wave C drill-down payloads (all optional) ────────────────────
	/** Commits unique to this branch vs its base. */
	commits?: CommitSummary[]
	/** Workspace-relative files assigned to this branch. */
	assignedFiles?: string[]
}

/** Banner-level summary surfaced above the stack. */
export interface SnapshotBanners {
	/** Floating-dirty files (not yet assigned). */
	floatingCount: number
}

/** Adapter-identity strip rendered at the bottom of the dashboard. */
export interface SnapshotAdapter {
	/** Adapter `name` from `PRHostAdapter.name` or 'none'. */
	name: string
	/** Short human label, e.g. "GitHub (Octokit)" / "GitHub (VS Code)" / "None". */
	label: string
}

export interface StackSnapshot {
	workspaceName: string
	branches: SnapshotBranch[]
	banners: SnapshotBanners
	adapter?: SnapshotAdapter
}

// ─── Builder ────────────────────────────────────────────────────────────────

export interface BuildSnapshotDeps {
	config: ConfigService
	sync: WorkspaceSync
	prAwareness?: PRAwareness
	workspaceRootFsPath: string
	worktreeDirOf: (branch: string) => string | undefined
	runner?: IGitRunner
	currentBranch?: string
	adapter?: SnapshotAdapter
	/**
	 * Wave C — supplies the commit list for each branch (lazy).  When
	 * omitted, the snapshot does not populate `branches[].commits`.
	 */
	loadCommits?: (branch: string, base: string, worktreeDir: string) => Promise<CommitSummary[]>
}

/**
 * Compute a fresh snapshot.  May issue one git command per branch to
 * collect ahead/behind counts; those are best-effort — a failing branch
 * yields an entry with the ahead/behind fields left `undefined`.
 */
export async function buildSnapshot(
	deps: BuildSnapshotDeps,
): Promise<StackSnapshot> {
	const runner = deps.runner ?? getDefaultGitRunner()
	const entries = deps.config.getStack().filter((e) => !e.scratch)
	const sorted = [...entries].sort((a, b) => a.order - b.order)
	const assignments = deps.config.getAllAssignments()

	const rows: SnapshotBranch[] = []
	for (const e of sorted) {
		const cwd = deps.worktreeDirOf(e.name)
		const pr = deps.prAwareness?.getForBranch(e.name)
		let ahead: number | undefined
		let behind: number | undefined
		if (cwd) {
			ahead = await countRevs(runner, cwd, `${e.base}..${e.name}`)
			behind = await countRevs(runner, cwd, `${e.name}..${e.base}`)
		}

		const assignedFiles = assignmentsFor(assignments, e.name)

		let commits: CommitSummary[] | undefined
		if (cwd && deps.loadCommits) {
			try {
				commits = await deps.loadCommits(e.name, e.base, cwd)
			} catch {
				// Best-effort only; a commit-list failure shouldn't void the
				// whole snapshot.
				commits = undefined
			}
		}

		rows.push({
			name: e.name,
			base: e.base,
			order: e.order,
			color: e.color,
			scratch: e.scratch,
			isCurrent: deps.currentBranch === e.name,
			assignedFilesCount: assignedFiles.length,
			assignedFiles,
			commits,
			singleCommit: e.singleCommit === true,
			aheadCount: ahead,
			behindCount: behind,
			prNumber: pr?.number,
			prState: pr?.state,
			prTitle: pr?.title,
			prUrl: pr?.url,
			// `checksStatus` intentionally left undefined here — the wave A
			// render path short-circuits when absent so the UI gracefully
			// degrades until a later wave wires the source.
		})
	}

	const floatingCount = deps.sync.getFloatingDirty().length
	const workspaceName =
		deps.workspaceRootFsPath.split(/[\\/]/).filter(Boolean).pop() ?? 'workspace'

	return {
		workspaceName,
		branches: rows,
		banners: { floatingCount },
		adapter: deps.adapter,
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function countRevs(runner: IGitRunner, cwd: string, range: string): Promise<number | undefined> {
	const r = await runner.run(['rev-list', '--count', range], { cwd })
	if (r.exitCode !== 0) return undefined
	const n = Number.parseInt(r.stdout.trim(), 10)
	return Number.isNaN(n) ? undefined : n
}

function assignmentsFor(assignments: Record<string, string>, branch: string): string[] {
	const out: string[] = []
	for (const [k, v] of Object.entries(assignments)) if (v === branch) out.push(k)
	out.sort((a, b) => a.localeCompare(b))
	return out
}
