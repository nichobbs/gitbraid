import { z } from 'zod/v4'
import * as vscode from 'vscode'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { GitBraidExportedAPI } from './@types/GitBraidAPI'
import type { StackContentProvider } from './stackContentProvider'
import { STACK_SCHEME } from './stackContentProvider'

type WriteGate = () => boolean

function writeDisabledError() {
	return {
		content: [{ type: 'text' as const, text: 'Write operations are disabled. Set gitbraid.mcpWriteEnabled to true to enable them.' }],
		isError: true,
	}
}

/**
 * Registers all GitBraid MCP tools and resources on `server`.
 *
 * `writeGate` is called at invocation time; returning false causes write tools
 * to return an error without executing.
 */
export function registerMcpTools(
	server: McpServer,
	api: GitBraidExportedAPI,
	stackContentProvider: StackContentProvider | undefined,
	writeGate: WriteGate,
): void {
	// ── Read tools ────────────────────────────────────────────────────────────

	server.tool(
		'getStack',
		'Returns the current GitBraid branch stack entries ordered base-first.',
		async () => ({
			content: [{ type: 'text', text: JSON.stringify(api.getStack(), null, 2) }],
		}),
	)

	server.tool(
		'getFloatingFiles',
		'Returns workspace-relative paths of files that are modified but not assigned to any branch.',
		async () => {
			const files = api.getFloatingFiles()
			return {
				content: [{ type: 'text', text: files.length === 0 ? 'No floating files.' : JSON.stringify(files, null, 2) }],
			}
		},
	)

	server.tool(
		'getBranchStatus',
		'Returns staged / unstaged / untracked counts for a branch worktree.',
		{ branch: z.string().describe('Branch name to query.') },
		async ({ branch }) => {
			try {
				const status = await api.getBranchStatus(branch)
				return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] }
			} catch (e) {
				return { content: [{ type: 'text', text: String(e) }], isError: true }
			}
		},
	)

	server.tool(
		'getStackStatus',
		'Returns status for every branch in the stack plus the total floating file count.',
		async () => {
			try {
				const status = await api.getStackStatus()
				return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] }
			} catch (e) {
				return { content: [{ type: 'text', text: String(e) }], isError: true }
			}
		},
	)

	// ── Write tools ───────────────────────────────────────────────────────────

	server.tool(
		'addBranch',
		'Creates a new branch in the stack with a git worktree.',
		{
			name: z.string().describe("Git branch name, e.g. 'feature/docs'."),
			base: z.string().describe("Parent branch name, e.g. 'main'."),
			color: z.string().optional().describe("Optional hex colour, e.g. '#4ec9b0'."),
		},
		async ({ name, base, color }) => {
			if (!writeGate()) return writeDisabledError()
			try {
				await api.addBranch(name, base, { color })
				return { content: [{ type: 'text', text: `Branch "${name}" added to the stack (base: "${base}").` }] }
			} catch (e) {
				return { content: [{ type: 'text', text: String(e) }], isError: true }
			}
		},
	)

	server.tool(
		'removeBranch',
		'Removes a branch from the stack and prunes its worktree.',
		{
			name: z.string().describe('Branch name to remove.'),
			force: z.boolean().optional().describe('Remove even if there are uncommitted changes.'),
		},
		async ({ name, force }) => {
			if (!writeGate()) return writeDisabledError()
			try {
				await api.removeBranch(name, force ?? false)
				return { content: [{ type: 'text', text: `Branch "${name}" removed from the stack.` }] }
			} catch (e) {
				return { content: [{ type: 'text', text: String(e) }], isError: true }
			}
		},
	)

	server.tool(
		'reorderStack',
		'Reorders the stack by providing the desired branch name sequence.',
		{ orderedNames: z.array(z.string()).describe('Branch names in the desired order.') },
		async ({ orderedNames }) => {
			if (!writeGate()) return writeDisabledError()
			try {
				await api.reorderStack(orderedNames)
				return { content: [{ type: 'text', text: 'Stack reordered.' }] }
			} catch (e) {
				return { content: [{ type: 'text', text: String(e) }], isError: true }
			}
		},
	)

	server.tool(
		'assignFile',
		'Assigns a workspace-relative file path to a branch.',
		{
			relativePath: z.string().describe('Workspace-relative path to the file.'),
			branch: z.string().describe('Branch to assign the file to.'),
		},
		async ({ relativePath, branch }) => {
			if (!writeGate()) return writeDisabledError()
			try {
				await api.assignFile(relativePath, branch)
				return { content: [{ type: 'text', text: `Assigned "${relativePath}" to branch "${branch}".` }] }
			} catch (e) {
				return { content: [{ type: 'text', text: String(e) }], isError: true }
			}
		},
	)

	server.tool(
		'unassignFile',
		'Removes the branch assignment for a file path.',
		{ relativePath: z.string().describe('Workspace-relative path to unassign.') },
		async ({ relativePath }) => {
			if (!writeGate()) return writeDisabledError()
			try {
				await api.unassignFile(relativePath)
				return { content: [{ type: 'text', text: `Unassigned "${relativePath}".` }] }
			} catch (e) {
				return { content: [{ type: 'text', text: String(e) }], isError: true }
			}
		},
	)

	server.tool(
		'assignHunk',
		'Assigns a specific diff hunk within a file to a branch.',
		{
			relativePath: z.string().describe('Workspace-relative path to the file.'),
			hunkIndex: z.number().int().min(0).describe('Zero-based hunk index from git diff output.'),
			branch: z.string().describe('Branch to assign the hunk to.'),
		},
		async ({ relativePath, hunkIndex, branch }) => {
			if (!writeGate()) return writeDisabledError()
			try {
				await api.assignHunk(relativePath, hunkIndex, branch)
				return { content: [{ type: 'text', text: `Assigned hunk ${String(hunkIndex)} in "${relativePath}" to "${branch}".` }] }
			} catch (e) {
				return { content: [{ type: 'text', text: String(e) }], isError: true }
			}
		},
	)

	server.tool(
		'removeHunkAssignment',
		'Removes a single hunk assignment.',
		{
			relativePath: z.string().describe('Workspace-relative path.'),
			hunkIndex: z.number().int().min(0).describe('Zero-based hunk index.'),
		},
		async ({ relativePath, hunkIndex }) => {
			if (!writeGate()) return writeDisabledError()
			try {
				await api.removeHunkAssignment(relativePath, hunkIndex)
				return { content: [{ type: 'text', text: `Removed hunk assignment ${String(hunkIndex)} in "${relativePath}".` }] }
			} catch (e) {
				return { content: [{ type: 'text', text: String(e) }], isError: true }
			}
		},
	)

	server.tool(
		'routeHunks',
		'Applies all pending hunk assignments for a file via git apply, then clears them.',
		{ relativePath: z.string().describe('Workspace-relative path to route hunks for.') },
		async ({ relativePath }) => {
			if (!writeGate()) return writeDisabledError()
			try {
				const result = await api.routeHunks(relativePath)
				return {
					content: [{
						type: 'text',
						text: `Routed ${String(result.routed)} hunk(s) for "${relativePath}" (${String(result.skipped)} skipped).`,
					}],
				}
			} catch (e) {
				return { content: [{ type: 'text', text: String(e) }], isError: true }
			}
		},
	)

	server.tool(
		'commitBranch',
		'Stages all tracked changes in a branch worktree and creates a commit.',
		{
			branch: z.string().describe('Branch to commit.'),
			message: z.string().min(1).describe('Commit message.'),
		},
		async ({ branch, message }) => {
			if (!writeGate()) return writeDisabledError()
			try {
				await api.commitBranch(branch, message, { stageAll: true })
				return { content: [{ type: 'text', text: `Committed to "${branch}": "${message}".` }] }
			} catch (e) {
				return { content: [{ type: 'text', text: String(e) }], isError: true }
			}
		},
	)

	server.tool(
		'rebaseBranch',
		'Rebases the branch onto its configured parent branch.',
		{ branch: z.string().describe('Branch to rebase.') },
		async ({ branch }) => {
			if (!writeGate()) return writeDisabledError()
			try {
				await api.rebaseBranch(branch)
				return { content: [{ type: 'text', text: `Rebased "${branch}" onto its parent.` }] }
			} catch (e) {
				return { content: [{ type: 'text', text: String(e) }], isError: true }
			}
		},
	)

	// ── Resources ─────────────────────────────────────────────────────────────

	if (stackContentProvider) {
		server.resource(
			'gitbraid-stack-file',
			new ResourceTemplate(`${STACK_SCHEME}://{relativePath}`, { list: undefined }),
			async (uri, { relativePath }) => {
				const rel = Array.isArray(relativePath) ? relativePath[0] : relativePath
				const vsUri = vscode.Uri.parse(`${STACK_SCHEME}:${rel}`)
				try {
					const content = await stackContentProvider.provideTextDocumentContent(vsUri)
					return {
						contents: [{
							uri: uri.href,
							mimeType: 'text/plain',
							text: content,
						}],
					}
				} catch (e) {
					return {
						contents: [{
							uri: uri.href,
							mimeType: 'text/plain',
							text: '',
						}],
					}
				}
			},
		)
	}
}
