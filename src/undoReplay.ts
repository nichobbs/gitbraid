import * as vscode from 'vscode'
import { log } from './channelLogger'
import { ConfigService } from './configService'
import { PersistentUndoLog, UndoLogEntry } from './persistentUndoLog'

/**
 * Plan 09 — replay-through-this-action support.
 *
 * Turns a tail of {@link UndoLogEntry} records into an ordered sequence of
 * inverse operations applied against {@link ConfigService}.  Callers pick a
 * target entry from `gitbraid.showUndoLog`; everything newer than the
 * target is unwound, newest first, so the user lands in the state that
 * existed *immediately after* the target entry was logged.
 *
 * Non-goals:
 *
 * - No worktree lifecycle replay (add/remove-branch replays only touch the
 *   config entry; worktrees aren't recreated or pruned).  A best-effort
 *   warning is surfaced so the user knows the filesystem side may need
 *   manual follow-up.
 * - No redo.  Once replayed the newer entries are removed from the log;
 *   reverse-redo is out of scope for this iteration.
 * - No conflict resolution UI.  Divergence (e.g. the file was reassigned
 *   since the entry) produces a `skipped` record that the caller can
 *   surface as a single summary notification.
 */

/** Shape of a single step in a replay plan — one-to-one with a log entry. */
export interface ReplayStep {
	entry: UndoLogEntry
	/** A one-line summary of what the inverse action will do. */
	description: string
	/** Why the step will be skipped.  `undefined` ⇒ applicable. */
	skipReason?: string
}

export interface ReplayPlan {
	/** Entries to replay, newest first (reverse of log order). */
	steps: ReplayStep[]
	/** The target entry — the one the user clicked in the QuickPick. */
	targetTs: string
}

export interface ReplayResult {
	applied: number
	skipped: number
	errors: Array<{ entry: UndoLogEntry; error: string }>
}

/**
 * Build the replay plan for a given target timestamp.  Every entry strictly
 * newer than `targetTs` contributes a {@link ReplayStep}; the target entry
 * itself is preserved (the user wanted to keep its effect, not undo it).
 */
export function buildReplayPlan(entries: UndoLogEntry[], targetTs: string, config: ConfigService): ReplayPlan {
	// Log is insertion order; iterate from the end back to the target.
	const steps: ReplayStep[] = []
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i]
		if (e.ts === targetTs) break
		const { description, skipReason } = describeInverse(e, config)
		steps.push({ entry: e, description, skipReason })
	}
	return { steps, targetTs }
}

/** Human-readable summary used by the confirmation modal. */
export function summarisePlan(plan: ReplayPlan): string {
	if (plan.steps.length === 0) return 'Nothing to replay.'
	const lines = plan.steps.map((s, i) => {
		const marker = s.skipReason ? '⚠' : '↶'
		return `${marker} ${String(i + 1)}. ${s.description}`
	})
	return lines.join('\n')
}

/**
 * Apply the plan, touching `ConfigService` only (worktree side-effects are
 * intentionally out of scope — see module JSDoc).  Each step's inverse is
 * attempted in order; failures don't short-circuit the rest.
 */
export async function applyReplay(plan: ReplayPlan, config: ConfigService, undoLog: PersistentUndoLog): Promise<ReplayResult> {
	const result: ReplayResult = { applied: 0, skipped: 0, errors: [] }

	for (const step of plan.steps) {
		if (step.skipReason) {
			result.skipped += 1
			log.info(`undoReplay: skip ${step.entry.action} (${step.skipReason})`)
			continue
		}
		try {
			await applyInverse(step.entry, config)
			result.applied += 1
			log.info(`undoReplay: applied inverse of ${step.entry.action} @ ${step.entry.ts}`)
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e)
			result.errors.push({ entry: step.entry, error: msg })
			log.warn(`undoReplay: inverse of ${step.entry.action} failed: ${msg}`)
		}
	}

	// Truncate the log to everything up to and including the target.
	const remaining = await undoLog.load()
	const keep: UndoLogEntry[] = []
	for (const e of remaining) {
		keep.push(e)
		if (e.ts === plan.targetTs) break
	}
	await undoLog.writeAll(keep)

	return result
}

// ─── Inverse-handler registry ──────────────────────────────────────────────

/**
 * Return a (description, skipReason) pair for an entry.  Pure; does not
 * touch the config.  A non-undefined `skipReason` means the current state
 * has diverged from what the entry describes and the inverse would be a
 * no-op or potentially destructive.
 */
function describeInverse(entry: UndoLogEntry, config: ConfigService): { description: string; skipReason?: string } {
	const d = entry.detail
	switch (entry.action) {
		case 'assign-file': {
			const path = asString(d.path)
			const from = nullableString(d.from)
			const to = asString(d.to)
			if (!path) return { description: `${entry.action} (malformed)`, skipReason: 'missing path' }
			const current = config.getAssignment(path)
			if (to !== undefined && current !== to) {
				return {
					description: `revert assignment of ${path} (current: ${current ?? '<floating>'}, logged: ${to})`,
					skipReason: 'file is no longer assigned to the logged branch',
				}
			}
			if (from === null || from === undefined) {
				return { description: `unassign ${path}` }
			}
			if (config.getBranch(from) === undefined) {
				return {
					description: `restore ${path} → ${from}`,
					skipReason: `branch "${from}" no longer exists`,
				}
			}
			return { description: `restore ${path} → ${from}` }
		}
		case 'unassign-file': {
			const path = asString(d.path)
			const from = nullableString(d.from)
			if (!path) return { description: entry.action, skipReason: 'missing path' }
			if (!from) return { description: `unassign ${path}`, skipReason: 'unknown previous branch' }
			const current = config.getAssignment(path)
			if (current !== undefined && current !== from) {
				return {
					description: `re-assign ${path} → ${from}`,
					skipReason: `file now belongs to "${current}"`,
				}
			}
			if (config.getBranch(from) === undefined) {
				return {
					description: `re-assign ${path} → ${from}`,
					skipReason: `branch "${from}" no longer exists`,
				}
			}
			return { description: `re-assign ${path} → ${from}` }
		}
		case 'add-branch': {
			const name = asString(d.name)
			if (!name) return { description: entry.action, skipReason: 'missing branch name' }
			if (config.getBranch(name) === undefined) {
				return { description: `remove ${name}`, skipReason: 'branch already absent from config' }
			}
			return {
				description: `remove ${name} (config only — worktree not pruned)`,
			}
		}
		case 'remove-branch': {
			const name = asString(d.name)
			const base = asString(d.base) ?? 'main'
			if (!name) return { description: entry.action, skipReason: 'missing branch name' }
			if (config.getBranch(name) !== undefined) {
				return { description: `re-add ${name}`, skipReason: 'branch already present' }
			}
			return { description: `re-add ${name} → ${base} (config only — worktree not recreated)` }
		}
		case 'set-hunk': {
			const path = asString(d.path)
			const idxRaw = d.hunkIndex
			const idx = typeof idxRaw === 'number' ? idxRaw : undefined
			const from = nullableString(d.from)
			if (!path || idx === undefined) {
				return { description: entry.action, skipReason: 'malformed detail' }
			}
			if (from === null || from === undefined) {
				return { description: `clear hunk ${String(idx)} of ${path}` }
			}
			return { description: `restore hunk ${String(idx)} of ${path} → ${from}` }
		}
		default:
			return { description: entry.action, skipReason: 'unsupported action type' }
	}
}

/**
 * Execute the inverse of an entry.  The description branch above decides
 * whether to call us at all; this function should never be asked to
 * invert something with a `skipReason`.
 */
async function applyInverse(entry: UndoLogEntry, config: ConfigService): Promise<void> {
	const d = entry.detail
	switch (entry.action) {
		case 'assign-file': {
			const p = asString(d.path)
			const from = nullableString(d.from)
			if (!p) return
			if (from === null || from === undefined) await config.removeAssignment(p)
			else await config.setAssignment(p, from)
			return
		}
		case 'unassign-file': {
			const p = asString(d.path)
			const from = nullableString(d.from)
			if (!p || !from) return
			await config.setAssignment(p, from)
			return
		}
		case 'add-branch': {
			const n = asString(d.name)
			if (!n) return
			await config.removeBranch(n)
			return
		}
		case 'remove-branch': {
			const n = asString(d.name)
			const base = asString(d.base) ?? 'main'
			const color = asString(d.color) ?? '#888888'
			if (!n) return
			await config.addBranch({ name: n, base, color })
			return
		}
		case 'set-hunk': {
			const p = asString(d.path)
			const idxRaw = d.hunkIndex
			const idx = typeof idxRaw === 'number' ? idxRaw : undefined
			const from = nullableString(d.from)
			if (!p || idx === undefined) return
			if (from === null || from === undefined) await config.removeHunkAssignment(p, idx)
			else await config.setHunkAssignment(p, idx, from)
			return
		}
		default:
			log.warn(`undoReplay.applyInverse: unsupported action ${entry.action}`)
			return
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function asString(v: unknown): string | undefined {
	return typeof v === 'string' ? v : undefined
}

function nullableString(v: unknown): string | null | undefined {
	if (v === null) return null
	return typeof v === 'string' ? v : undefined
}

/** Wire the QuickPick entry point for `gitbraid.showUndoLog`. */
export async function runShowUndoLogCommand(
	undoLog: PersistentUndoLog,
	config: ConfigService,
): Promise<void> {
	const entries = await undoLog.load()
	if (entries.length === 0) {
		await vscode.window.showInformationMessage('GitBraid: undo log is empty.')
		return
	}
	type ItemWithTs = vscode.QuickPickItem & { ts: string }
	const items: ItemWithTs[] = entries.slice().reverse().map((e) => ({
		label: formatAction(e.action),
		description: new Date(e.ts).toLocaleString(),
		detail: Object.keys(e.detail).length > 0 ? JSON.stringify(e.detail) : undefined,
		ts: e.ts,
	}))
	const picked = await vscode.window.showQuickPick<ItemWithTs>(items, {
		placeHolder: `${String(entries.length)} logged actions — pick one to replay back to`,
		matchOnDescription: true,
		matchOnDetail: true,
	})
	if (!picked) return

	const plan = buildReplayPlan(entries, picked.ts, config)
	if (plan.steps.length === 0) {
		await vscode.window.showInformationMessage('GitBraid: nothing to replay — this is the newest entry.')
		return
	}

	const proceed = await vscode.window.showWarningMessage(
		`GitBraid: replay ${String(plan.steps.length)} action(s)?\n\n${summarisePlan(plan)}`,
		{ modal: true },
		'Replay',
	)
	if (proceed !== 'Replay') return

	const result = await applyReplay(plan, config, undoLog)
	const summary =
		`Replayed ${String(result.applied)} action(s)` +
		(result.skipped > 0 ? `, skipped ${String(result.skipped)}` : '') +
		(result.errors.length > 0 ? `, ${String(result.errors.length)} error(s) — see Output` : '')
	await vscode.window.showInformationMessage(`GitBraid: ${summary}`)
	for (const err of result.errors) {
		log.error(`undoReplay: ${err.entry.action} @ ${err.entry.ts}: ${err.error}`)
	}
}

function formatAction(action: string): string {
	switch (action) {
		case 'assign-file':   return '↪ assign file'
		case 'unassign-file': return '⇠ unassign file'
		case 'add-branch':    return '＋ add branch'
		case 'remove-branch': return '– remove branch'
		case 'set-hunk':      return '※ assign hunk'
		default:              return action
	}
}
