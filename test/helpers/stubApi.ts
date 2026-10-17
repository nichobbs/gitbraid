import type * as vscode from 'vscode'
import type { GitBraidExportedAPI } from '../../src/@types/GitBraidAPI'
import type { AssignmentChangeEvent, StackChangeEvent } from '../../src/configTypes'

/** Methods that change state. A tool of kind "read" must never call one. */
export const MUTATING_METHODS = [
	'addBranch', 'removeBranch', 'materialiseBranch', 'assignFile', 'assignHunk', 'unassignFile',
	'commitBranch', 'stageBranch', 'pullBranch', 'syncBranch', 'reorderStack', 'removeHunkAssignment',
	'rebaseBranch', 'routeHunks',
] as const

export interface StubApi {
	api: GitBraidExportedAPI
	/** `method:arg1:arg2` for every call, in order. */
	calls: string[]
}

const noopEvent = (_listener: unknown) => ({ dispose: () => { /* */ } })

/**
 * A complete `GitBraidExportedAPI` that records calls and returns plausible data.
 * Pass `overrides` to change behaviour; set `trapMutations` to make any mutating
 * method throw, which is how read tools are proven read-only.
 */
export function makeStubApi(
	overrides: Partial<GitBraidExportedAPI> = {},
	opts: { trapMutations?: boolean } = {},
): StubApi {
	const calls: string[] = []
	const rec = (name: string, ...args: unknown[]) => { calls.push([name, ...args.map(String)].join(':')) }
	const api: GitBraidExportedAPI = {
		getStack: () => [
			{ name: 'feat/a', base: 'main', order: 1, color: '#111111' },
			{ name: 'feat/b', base: 'feat/a', order: 2, color: '#222222' },
		],
		addBranch: async (n, b) => { rec('addBranch', n, b) },
		removeBranch: async (n, f) => { rec('removeBranch', n, f ?? false) },
		materialiseBranch: async (n) => { rec('materialiseBranch', n) },
		getVirtualBranches: () => [],
		getAssignment: () => undefined,
		assignFile: async (p, b) => { rec('assignFile', p, b) },
		assignHunk: async (p, i, b) => { rec('assignHunk', p, i, b) },
		unassignFile: async (p) => { rec('unassignFile', p) },
		getFloatingFiles: () => ['src/foo.ts'],
		getFileOwnership: (p) => ({ path: p, branch: 'feat/a', hunkAssignments: {}, floating: false }),
		getFileHunks: async (_p, o) => [
			{ index: 0, startLine: 1, endLine: 3, header: '@@ -1,3 +1,3 @@', ...(o?.includePatch ? { patch: 'PATCH' } : {}) },
		],
		getBranchStatus: async (branch) => ({ branch, staged: 1, unstaged: 0, untracked: 0, floating: 0 }),
		getStackStatus: async () => ({ branches: [], totalFloating: 0 }),
		getBranchDiff: async (branch, o) => ({ branch, base: 'main', diff: o?.stat ? ' x | 1 +\n' : '+hello\n', truncated: false }),
		getUndoLog: async () => [{ ts: 't', action: 'assign-file', detail: {} }],
		commitBranch: async (b, m) => { rec('commitBranch', b, m) },
		stageBranch: async (b) => { rec('stageBranch', b) },
		pullBranch: async (b) => { rec('pullBranch', b) },
		syncBranch: async (b) => { rec('syncBranch', b) },
		reorderStack: async (names) => { rec('reorderStack', names.join(',')) },
		getHunkAssignments: () => undefined,
		removeHunkAssignment: async (p, i) => { rec('removeHunkAssignment', p, i) },
		rebaseBranch: async (b) => { rec('rebaseBranch', b) },
		routeHunks: async (p) => { rec('routeHunks', p); return { routed: 2, skipped: 1 } },
		onDidChangeAssignment: noopEvent as unknown as vscode.Event<AssignmentChangeEvent>,
		onDidChangeStack: noopEvent as unknown as vscode.Event<StackChangeEvent>,
		onDidSyncFile: noopEvent as unknown as vscode.Event<{ relativePath: string, branch: string }>,
		onDidFloatFile: noopEvent as unknown as vscode.Event<{ relativePath: string }>,
		...overrides,
	}
	if (opts.trapMutations) {
		for (const m of MUTATING_METHODS) {
			;(api as unknown as Record<string, unknown>)[m] = async () => { throw new Error(`MUTATION: ${m} was called`) }
		}
	}
	return { api, calls }
}
