import * as vscode from 'vscode'
import { log } from './channelLogger'

/**
 * A single reversible user action.
 *
 * `undo` reverts the action.  `redo` re-applies it.  Both must be safe to
 * call repeatedly — after `undo` the op is moved to the redo stack, so a
 * subsequent `redo` call invokes `redo()` and the op returns to the undo
 * stack.  The callbacks should not themselves push further ops, or the
 * stacks will spiral.
 */
export interface UndoableOp {
	/** Short, human-readable description for the status bar / notifications. */
	readonly label: string
	/** Revert the action.  Thrown errors bubble to the command handler. */
	undo(): Promise<void>
	/** Re-apply the action. */
	redo(): Promise<void>
}

/**
 * Bounded in-memory undo / redo ring for assignment-level operations (T69).
 *
 * Not persisted across sessions by design — the review (and the plan) are
 * explicit that undo should be a "this session only" safety net, not a
 * second source of truth competing with `local-config.json`.
 *
 * Loop safety: `undo()` and `redo()` invoke the callbacks *directly*.  They
 * do not call `push(...)` back through any service — they simply move the op
 * between the two stacks.  Command handlers that call `push(...)` run the
 * mutation themselves, so wrapping a mutation as "push → mutate" keeps the
 * logged op in lockstep with the observable state.
 *
 * Capacity is ring-bounded ({@link UndoStack.CAPACITY}, default 100).  When
 * the undo stack overflows the oldest op is dropped; users forfeit the
 * ability to undo very-old actions but keep the ability to undo the most
 * recent 100.  The redo stack is cleared on every new `push()` since
 * re-doing after a fresh action has no well-defined meaning.
 */
export class UndoStack {

	static readonly CAPACITY = 100

	private readonly _undo: UndoableOp[] = []
	private readonly _redo: UndoableOp[] = []

	// Guard against re-entrant pushes triggered by event emitters that may
	// fire during an undo/redo callback.  When `true`, `push(...)` is a
	// no-op — the active undo/redo is the source of truth.
	private _applying = false

	private readonly _onDidChange = new vscode.EventEmitter<void>()
	/** Fires after any operation that might change `canUndo` / `canRedo`. */
	readonly onDidChange: vscode.Event<void> = this._onDidChange.event

	dispose(): void {
		this._onDidChange.dispose()
		this._undo.length = 0
		this._redo.length = 0
	}

	/**
	 * Record a newly-applied op so it can be undone later.  Clears the redo
	 * stack — after a fresh action, "redo the action the user most recently
	 * undid" is no longer a coherent gesture.
	 *
	 * No-op while an undo/redo is currently in flight (see `_applying`).
	 */
	push(op: UndoableOp): void {
		if (this._applying) {
			return
		}
		this._undo.push(op)
		while (this._undo.length > UndoStack.CAPACITY) {
			this._undo.shift()
		}
		this._redo.length = 0
		this._onDidChange.fire()
	}

	canUndo(): boolean { return this._undo.length > 0 }
	canRedo(): boolean { return this._redo.length > 0 }

	peekUndo(): UndoableOp | undefined { return this._undo[this._undo.length - 1] }
	peekRedo(): UndoableOp | undefined { return this._redo[this._redo.length - 1] }

	/** Number of ops currently available to undo. */
	get undoSize(): number { return this._undo.length }
	/** Number of ops currently available to redo. */
	get redoSize(): number { return this._redo.length }

	/**
	 * Pop the most-recent op and run its `undo` callback.  Moves it to the
	 * redo stack on success.  On failure the op stays on the undo stack so
	 * the user can try again without having lost their history.
	 */
	async undo(): Promise<UndoableOp | undefined> {
		const op = this._undo.pop()
		if (!op) return undefined
		this._applying = true
		try {
			await op.undo()
			this._redo.push(op)
			this._onDidChange.fire()
			return op
		} catch (e) {
			// Put it back so the user can retry.
			this._undo.push(op)
			log.error(`UndoStack: undo of "${op.label}" failed: ${e instanceof Error ? e.message : String(e)}`)
			throw e
		} finally {
			this._applying = false
		}
	}

	/** Pop the most-recent undone op and run its `redo` callback. */
	async redo(): Promise<UndoableOp | undefined> {
		const op = this._redo.pop()
		if (!op) return undefined
		this._applying = true
		try {
			await op.redo()
			this._undo.push(op)
			this._onDidChange.fire()
			return op
		} catch (e) {
			this._redo.push(op)
			log.error(`UndoStack: redo of "${op.label}" failed: ${e instanceof Error ? e.message : String(e)}`)
			throw e
		} finally {
			this._applying = false
		}
	}

	/** Drop every recorded op.  Useful after a stack-wide operation. */
	clear(): void {
		this._undo.length = 0
		this._redo.length = 0
		this._onDidChange.fire()
	}
}

// ─── Inverse-op factories for ConfigService ──────────────────────────────────

import type { ConfigService } from './configService'
import type { HunkAnchor } from './configTypes'

/**
 * Record an `assignFile` action.  Call after the assignment has been
 * written; `push(...)` won't fire any extra events.
 */
export function recordAssignFile(
	stack: UndoStack,
	config: ConfigService,
	relativePath: string,
	newBranch: string,
	previousBranch: string | undefined,
): void {
	stack.push({
		label: previousBranch
			? `Reassign ${relativePath} (${previousBranch} → ${newBranch})`
			: `Assign ${relativePath} → ${newBranch}`,
		async undo() {
			if (previousBranch === undefined) {
				await config.removeAssignment(relativePath)
			} else {
				await config.setAssignment(relativePath, previousBranch)
			}
		},
		async redo() {
			await config.setAssignment(relativePath, newBranch)
		},
	})
}

/** Record an `unassignFile` action. */
export function recordUnassignFile(
	stack: UndoStack,
	config: ConfigService,
	relativePath: string,
	previousBranch: string,
): void {
	stack.push({
		label: `Unassign ${relativePath} (was on ${previousBranch})`,
		async undo() {
			await config.setAssignment(relativePath, previousBranch)
		},
		async redo() {
			await config.removeAssignment(relativePath)
		},
	})
}

/** Record an `assignHunk` action. */
export function recordAssignHunk(
	stack: UndoStack,
	config: ConfigService,
	relativePath: string,
	hunkIndex: number,
	newBranch: string,
	previousBranch: string | undefined,
	anchor: HunkAnchor | undefined,
): void {
	stack.push({
		label: `Assign hunk ${String(hunkIndex)} in ${relativePath} → ${newBranch}`,
		async undo() {
			if (previousBranch === undefined) {
				await config.removeHunkAssignment(relativePath, hunkIndex)
			} else {
				await config.setHunkAssignment(relativePath, hunkIndex, previousBranch, anchor)
			}
		},
		async redo() {
			await config.setHunkAssignment(relativePath, hunkIndex, newBranch, anchor)
		},
	})
}

/** Record a `removeHunkAssignment` action. */
export function recordUnassignHunk(
	stack: UndoStack,
	config: ConfigService,
	relativePath: string,
	hunkIndex: number,
	previousBranch: string,
	previousAnchor: HunkAnchor | undefined,
): void {
	stack.push({
		label: `Unassign hunk ${String(hunkIndex)} in ${relativePath}`,
		async undo() {
			await config.setHunkAssignment(relativePath, hunkIndex, previousBranch, previousAnchor)
		},
		async redo() {
			await config.removeHunkAssignment(relativePath, hunkIndex)
		},
	})
}
