import { ConfigService } from './configService'
import { WorkspaceSync } from './workspaceSync'
import { IGitRunner, getDefaultGitRunner } from './gitRunner'
import type { PRAwareness } from './prAwareness'
import type { CommitSummary } from './commitListService'
import { renderStackBlock, StackBodyEntry } from './prHostAdapter'

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
	/** Reviewer verdict rollup. */
	reviewState?: 'approved' | 'changesRequested' | 'commented' | 'pending'
	/** Number of review rounds on the PR. */
	reviewCount?: number
	/** Per-check-run detail for the dashboard's Reviews & Checks drawer. */
	checksDetail?: Array<{ name: string; state: ChecksStatus; url?: string }>

	// ── Wave C drill-down payloads (all optional) ────────────────────
	/** Commits unique to this branch vs its base. */
	commits?: CommitSummary[]
	/** Workspace-relative files assigned to this branch. */
	assignedFiles?: string[]
	/** Rendered stacked-PR block that `submitStack` would inject. */
	stackBlockPreview?: string
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
	/**
	 * Follow-up — supplies review + checks detail per branch (lazy, cached
	 * upstream by the adapter).  Only populates `reviewState`,
	 * `reviewCount`, and `checksDetail` on rows where the call succeeds;
	 * missing detail leaves the fields undefined and the UI gracefully
	 * hides the Reviews & Checks drawer.
	 */
	loadPrDetail?: (branch: string) => Promise<{
		reviewState?: 'approved' | 'changesRequested' | 'commented' | 'pending'
		reviewCount?: number
		checksDetail?: Array<{ name: string; state: ChecksStatus; url?: string }>
	} | undefined>
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
	const entries = deps.config.getStack()
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

		let reviewState: 'approved' | 'changesRequested' | 'commented' | 'pending' | undefined
		let reviewCount: number | undefined
		let checksDetail: Array<{ name: string; state: ChecksStatus; url?: string }> | undefined
		if (deps.loadPrDetail) {
			try {
				const detail = await deps.loadPrDetail(e.name)
				if (detail) {
					reviewState = detail.reviewState
					reviewCount = detail.reviewCount
					checksDetail = detail.checksDetail
				}
			} catch {
				// Best-effort — the adapter failing shouldn't void the snapshot.
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
			reviewState,
			reviewCount,
			checksDetail,
		})
	}

	const floatingCount = deps.sync.getFloatingDirty().length
	const workspaceName =
		deps.workspaceRootFsPath.split(/[\\/]/).filter(Boolean).pop() ?? 'workspace'

	// Per-branch stacked-PR body preview: exactly what `submitStack` would
	// inject.  Skips rows whose branch has no PR or no URL — the block only
	// makes sense once submission has happened at least once.  We still
	// render for branches without a prNumber using a `#?` placeholder,
	// since that matches `renderStackBlock`'s "PR not known yet" output.
	const stackEntries: StackBodyEntry[] = rows.map((r) => ({ name: r.name, prNumber: r.prNumber }))
	for (const row of rows) {
		row.stackBlockPreview = renderStackBlock(stackEntries, row.name)
	}

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
