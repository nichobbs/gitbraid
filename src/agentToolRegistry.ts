import { z } from 'zod/v4'
import type { GitBraidExportedAPI } from './@types/GitBraidAPI'
import { requireForceAllowed } from './stackInvariants'

/**
 * Plan 12: every tool GitBraid offers to an agent, defined once.
 *
 * The MCP server (`mcpTools.ts`) and the VS Code chat tools (`lmTools.ts`) are
 * both generated from this list, so a tool has one input schema, one behaviour
 * and one set of messages.  Which surfaces offer a tool is explicit
 * (`surfaces`), and leaving one out requires a reason (`excluded`), so the two
 * lists can differ only on purpose.  `test/agentToolRegistry.test.ts` checks
 * that, and that the chat tools match the manifest in `package.json`.
 *
 * Free of `vscode` imports: host capabilities arrive through
 * {@link AgentToolContext}.
 */

export type ToolSurface = 'mcp' | 'lm'

/** What a host provides to the tools it runs. */
export interface AgentToolContext {
	/** Which surface is calling. Written to the audit log. */
	caller: ToolSurface
	/** `gitbraid.agentAllowForce`: may an agent remove a branch with `force`? */
	allowForce: boolean
	/** `gitbraid.agentMaxDiffBytes`: cap on `getBranchDiff` output. */
	maxDiffBytes: number
	/** Workspace-relative paths matching a glob, excluding `.git`, `.worktrees` and `node_modules`. */
	findFiles(pattern: string): Promise<string[]>
}

export interface ToolConfirmation {
	title: string
	/** Markdown. */
	message: string
}

interface ToolDefinition<S extends z.ZodRawShape> {
	/** MCP name. The chat tool is `gitbraid_<name>`. */
	name: string
	/** Shown to the model by the MCP server. (Chat tools take theirs from `package.json`.) */
	description: string
	input: S
	/** Read tools must not change anything; a test enforces it. */
	kind: 'read' | 'write'
	surfaces: readonly ToolSurface[]
	/** Why a surface does not offer this tool. Required for every surface not in `surfaces`. */
	excluded?: Partial<Record<ToolSurface, string>>
	/** One line shown in chat while the tool runs. */
	progress: (input: z.infer<z.ZodObject<S>>) => string
	/** Chat asks the user to confirm before running tools that give this. */
	confirm?: (input: z.infer<z.ZodObject<S>>) => ToolConfirmation
	run: (api: GitBraidExportedAPI, input: z.infer<z.ZodObject<S>>, ctx: AgentToolContext) => Promise<string>
}

/** A registered tool with its input type erased; `run` validates the raw input first. */
export interface AgentTool {
	name: string
	description: string
	input: z.ZodRawShape
	kind: 'read' | 'write'
	surfaces: readonly ToolSurface[]
	excluded?: Partial<Record<ToolSurface, string>>
	progress(rawInput: unknown): string
	confirm?(rawInput: unknown): ToolConfirmation
	run(api: GitBraidExportedAPI, rawInput: unknown, ctx: AgentToolContext): Promise<string>
}

/** Input did not match the tool's schema. Carries a message a model can act on. */
export class ToolInputError extends Error {
	constructor(toolName: string, issues: readonly z.core.$ZodIssue[]) {
		super(
			`Invalid input for ${toolName}: ` +
			issues.map((i) => `${i.path.length > 0 ? i.path.join('.') : '(input)'}: ${i.message}`).join('; '),
		)
		this.name = 'ToolInputError'
	}
}

function defineTool<S extends z.ZodRawShape>(def: ToolDefinition<S>): AgentTool {
	const schema = z.object(def.input)
	const parse = (raw: unknown): z.infer<typeof schema> => {
		const result = schema.safeParse(raw ?? {})
		if (!result.success) throw new ToolInputError(def.name, result.error.issues)
		return result.data
	}
	return {
		name: def.name,
		description: def.description,
		input: def.input,
		kind: def.kind,
		surfaces: def.surfaces,
		excluded: def.excluded,
		progress: (raw) => def.progress(parse(raw)),
		confirm: def.confirm ? (raw) => def.confirm!(parse(raw)) : undefined,
		run: async (api, raw, ctx) => def.run(api, parse(raw), ctx),
	}
}

const json = (value: unknown): string => JSON.stringify(value, null, 2)

const BOTH: readonly ToolSurface[] = ['mcp', 'lm']
const MCP_ONLY: readonly ToolSurface[] = ['mcp']
const LM_ONLY: readonly ToolSurface[] = ['lm']

const NOT_IN_CHAT = 'Never offered to VS Code chat (no manifest entry or confirmation text); available over MCP only.'
const NOT_IN_MCP_PUSH = 'Talks to the remote (pull/push); left to VS Code chat, which asks the user to confirm each call.'

// ─── The tools ───────────────────────────────────────────────────────────────

export const AGENT_TOOLS: readonly AgentTool[] = [

	// ── Read ────────────────────────────────────────────────────────────────

	defineTool({
		name: 'getStack',
		description: 'Returns the current GitBraid branch stack entries ordered base-first.',
		input: {},
		kind: 'read',
		surfaces: BOTH,
		progress: () => 'Fetching branch stack…',
		run: async (api) => json(api.getStack()),
	}),

	defineTool({
		name: 'getStackDiagram',
		description: 'Returns an ASCII tree of the branch stack, showing which branch is based on which.',
		input: {},
		kind: 'read',
		surfaces: BOTH,
		progress: () => 'Building stack diagram…',
		run: async (api) => {
			const stack = api.getStack()
			if (stack.length === 0) return 'Stack is empty.'
			const rootBase = stack[0].base
			const lines: string[] = [rootBase]
			const childrenOf = new Map<string, string[]>()
			childrenOf.set(rootBase, [])
			for (const entry of stack) {
				if (!childrenOf.has(entry.base)) childrenOf.set(entry.base, [])
				childrenOf.get(entry.base)!.push(entry.name)
				childrenOf.set(entry.name, [])
			}
			const render = (parent: string, prefix: string): void => {
				const children = childrenOf.get(parent) ?? []
				for (let i = 0; i < children.length; i++) {
					const branch = children[i]
					const isLast = i === children.length - 1
					lines.push(`${prefix}${isLast ? '└── ' : '├── '}${branch}`)
					render(branch, prefix + (isLast ? '    ' : '│   '))
				}
			}
			render(rootBase, '')
			return lines.join('\n')
		},
	}),

	defineTool({
		name: 'getFloatingFiles',
		description: 'Returns workspace-relative paths of files that are modified but not assigned to any branch.',
		input: {},
		kind: 'read',
		surfaces: BOTH,
		progress: () => 'Fetching floating files…',
		run: async (api) => {
			const files = api.getFloatingFiles()
			return files.length === 0 ? 'No floating files.' : json(files)
		},
	}),

	defineTool({
		name: 'getBranchStatus',
		description: 'Returns staged / unstaged / untracked counts for a branch worktree.',
		input: { branch: z.string().describe('Branch name to query.') },
		kind: 'read',
		surfaces: BOTH,
		progress: ({ branch }) => `Fetching status for "${branch}"…`,
		run: async (api, { branch }) => json(await api.getBranchStatus(branch)),
	}),

	defineTool({
		name: 'getStackStatus',
		description: 'Returns status for every branch in the stack plus the total floating file count.',
		input: {},
		kind: 'read',
		surfaces: BOTH,
		progress: () => 'Fetching status for every branch…',
		run: async (api) => json(await api.getStackStatus()),
	}),

	defineTool({
		name: 'getFileOwnership',
		description:
			'Says which branch a file is assigned to, which of its hunks are assigned elsewhere, and whether it is floating. ' +
			'Use it to check a file before assigning it.',
		input: { relativePath: z.string().describe('Workspace-relative path to the file.') },
		kind: 'read',
		surfaces: BOTH,
		progress: ({ relativePath }) => `Checking ownership of "${relativePath}"…`,
		run: async (api, { relativePath }) => json(api.getFileOwnership(relativePath)),
	}),

	defineTool({
		name: 'getFileHunks',
		description:
			'Lists the hunks in a file\'s uncommitted changes: index, line range, header, and the branch each is assigned to. ' +
			'Hunk indices change whenever the file is edited, so call this right before assignHunk.',
		input: {
			relativePath: z.string().describe('Workspace-relative path to the file.'),
			includePatch: z.boolean().optional().describe('Include each hunk\'s patch text. Large; off by default.'),
		},
		kind: 'read',
		surfaces: BOTH,
		progress: ({ relativePath }) => `Listing hunks in "${relativePath}"…`,
		run: async (api, { relativePath, includePatch }) => {
			const hunks = await api.getFileHunks(relativePath, { includePatch })
			return hunks.length === 0 ? `"${relativePath}" has no uncommitted changes.` : json(hunks)
		},
	}),

	defineTool({
		name: 'getBranchDiff',
		description:
			'Returns what a branch changes relative to the point it forked from its base, including uncommitted edits to tracked files. ' +
			'Use stat for a summary first; large output is truncated.',
		input: {
			branch: z.string().describe('Branch name to diff.'),
			stat: z.boolean().optional().describe('Return `git diff --stat` instead of the full diff.'),
		},
		kind: 'read',
		surfaces: BOTH,
		progress: ({ branch }) => `Diffing "${branch}"…`,
		run: async (api, { branch, stat }, ctx) => {
			const d = await api.getBranchDiff(branch, { stat, maxBytes: ctx.maxDiffBytes })
			const header = `# ${stat === true ? 'Diff stat' : 'Diff'} of "${d.branch}" against its fork point from "${d.base}"`
			if (d.diff.trim() === '') return `${header}\n(no changes)`
			const note = d.truncated
				? `\n[truncated at ${String(ctx.maxDiffBytes)} bytes: pass stat, or use getFileHunks for individual files]`
				: ''
			return `${header}\n${d.diff}${note}`
		},
	}),

	defineTool({
		name: 'getUndoLog',
		description: 'Returns the most recent recorded GitBraid actions, newest first.',
		input: { limit: z.number().int().min(1).max(200).optional().describe('How many entries to return. Default 20.') },
		kind: 'read',
		surfaces: BOTH,
		progress: () => 'Reading the undo log…',
		run: async (api, { limit }) => {
			const entries = await api.getUndoLog(limit)
			return entries.length === 0 ? 'The undo log is empty.' : json(entries)
		},
	}),

	// ── Write ───────────────────────────────────────────────────────────────

	defineTool({
		name: 'addBranch',
		description: 'Creates a new branch in the stack with a git worktree.',
		input: {
			name: z.string().describe('Git branch name, e.g. \'feature/docs\'.'),
			base: z.string().describe('Parent branch name, e.g. \'main\'.'),
			color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('Optional hex colour, e.g. \'#4ec9b0\'.'),
		},
		kind: 'write',
		surfaces: BOTH,
		progress: ({ name }) => `Adding branch "${name}" to stack…`,
		confirm: ({ name, base }) => ({
			title: 'Add Branch to Stack',
			message: `Create branch **${name}** based on **${base}** and add it to the stack?`,
		}),
		run: async (api, { name, base, color }) => {
			await api.addBranch(name, base, { color })
			return `Branch "${name}" added to the stack (base: "${base}").`
		},
	}),

	defineTool({
		name: 'removeBranch',
		description: 'Removes a branch from the stack and prunes its worktree. `force` discards uncommitted work and is refused for agents unless the user has allowed it.',
		input: {
			name: z.string().describe('Branch name to remove.'),
			force: z.boolean().optional().describe('Remove even if there are uncommitted changes.'),
		},
		kind: 'write',
		surfaces: MCP_ONLY,
		excluded: { lm: NOT_IN_CHAT },
		progress: ({ name }) => `Removing "${name}"…`,
		run: async (api, { name, force }, ctx) => {
			requireForceAllowed(force ?? false, ctx.allowForce)
			await api.removeBranch(name, force ?? false)
			return `Branch "${name}" removed from the stack.`
		},
	}),

	defineTool({
		name: 'reorderStack',
		description: 'Reorders the stack. `orderedNames` must list every branch in the stack exactly once.',
		input: { orderedNames: z.array(z.string()).describe('Branch names in the desired order.') },
		kind: 'write',
		surfaces: MCP_ONLY,
		excluded: { lm: NOT_IN_CHAT },
		progress: () => 'Reordering the stack…',
		run: async (api, { orderedNames }) => {
			await api.reorderStack(orderedNames)
			return 'Stack reordered.'
		},
	}),

	defineTool({
		name: 'assignFile',
		description: 'Assigns a workspace-relative file path to a branch.',
		input: {
			relativePath: z.string().describe('Workspace-relative path to the file.'),
			branch: z.string().describe('Branch to assign the file to.'),
		},
		kind: 'write',
		surfaces: BOTH,
		progress: ({ relativePath, branch }) => `Assigning "${relativePath}" to "${branch}"…`,
		confirm: ({ relativePath, branch }) => ({
			title: 'Assign File to Branch',
			message: `Assign \`${relativePath}\` to branch **${branch}**?`,
		}),
		run: async (api, { relativePath, branch }) => {
			await api.assignFile(relativePath, branch)
			return `Assigned "${relativePath}" to branch "${branch}".`
		},
	}),

	defineTool({
		name: 'unassignFile',
		description: 'Removes the branch assignment for a file path.',
		input: { relativePath: z.string().describe('Workspace-relative path to unassign.') },
		kind: 'write',
		surfaces: MCP_ONLY,
		excluded: { lm: NOT_IN_CHAT },
		progress: ({ relativePath }) => `Unassigning "${relativePath}"…`,
		run: async (api, { relativePath }) => {
			await api.unassignFile(relativePath)
			return `Unassigned "${relativePath}".`
		},
	}),

	defineTool({
		name: 'assignHunk',
		description: 'Assigns a specific diff hunk within a file to a branch. Get the index from getFileHunks first; indices change when the file is edited.',
		input: {
			relativePath: z.string().describe('Workspace-relative path to the file.'),
			hunkIndex: z.number().int().min(0).describe('Zero-based hunk index from getFileHunks.'),
			branch: z.string().describe('Branch to assign the hunk to.'),
		},
		kind: 'write',
		surfaces: BOTH,
		progress: ({ relativePath, hunkIndex, branch }) => `Assigning hunk ${String(hunkIndex)} in "${relativePath}" to "${branch}"…`,
		confirm: ({ relativePath, hunkIndex, branch }) => ({
			title: 'Assign Hunk to Branch',
			message: `Assign hunk **${String(hunkIndex)}** in \`${relativePath}\` to branch **${branch}**?`,
		}),
		run: async (api, { relativePath, hunkIndex, branch }) => {
			await api.assignHunk(relativePath, hunkIndex, branch)
			return `Assigned hunk ${String(hunkIndex)} in "${relativePath}" to branch "${branch}".`
		},
	}),

	defineTool({
		name: 'removeHunkAssignment',
		description: 'Removes a single hunk assignment.',
		input: {
			relativePath: z.string().describe('Workspace-relative path.'),
			hunkIndex: z.number().int().min(0).describe('Zero-based hunk index.'),
		},
		kind: 'write',
		surfaces: MCP_ONLY,
		excluded: { lm: NOT_IN_CHAT },
		progress: ({ relativePath, hunkIndex }) => `Removing hunk ${String(hunkIndex)} assignment in "${relativePath}"…`,
		run: async (api, { relativePath, hunkIndex }) => {
			await api.removeHunkAssignment(relativePath, hunkIndex)
			return `Removed hunk assignment ${String(hunkIndex)} in "${relativePath}".`
		},
	}),

	defineTool({
		name: 'assignGlob',
		description: 'Assigns every workspace file matching a glob pattern to a branch, e.g. \'src/auth/**\'. Skips .git, .worktrees and node_modules.',
		input: {
			pattern: z.string().describe('Glob pattern relative to the workspace root, e.g. \'src/auth/**\'.'),
			branch: z.string().describe('Branch to assign the matched files to.'),
		},
		kind: 'write',
		surfaces: BOTH,
		progress: ({ pattern, branch }) => `Assigning files matching "${pattern}" to "${branch}"…`,
		confirm: ({ pattern, branch }) => ({
			title: 'Assign Files by Glob to Branch',
			message: `Assign all files matching \`${pattern}\` to branch **${branch}**?`,
		}),
		run: async (api, { pattern, branch }, ctx) => {
			const paths = await ctx.findFiles(pattern)
			if (paths.length === 0) return `No files matched pattern "${pattern}".`
			for (const rel of paths) await api.assignFile(rel, branch)
			return `Assigned ${String(paths.length)} file(s) matching "${pattern}" to branch "${branch}":\n${paths.join('\n')}`
		},
	}),

	defineTool({
		name: 'routeHunks',
		description: 'Applies all pending hunk assignments for a file via git apply, then clears them.',
		input: { relativePath: z.string().describe('Workspace-relative path to route hunks for.') },
		kind: 'write',
		surfaces: MCP_ONLY,
		excluded: { lm: NOT_IN_CHAT },
		progress: ({ relativePath }) => `Routing hunks in "${relativePath}"…`,
		run: async (api, { relativePath }) => {
			const result = await api.routeHunks(relativePath)
			return `Routed ${String(result.routed)} hunk(s) for "${relativePath}" (${String(result.skipped)} skipped).`
		},
	}),

	defineTool({
		name: 'commitBranch',
		description: 'Stages all tracked changes in a branch worktree and creates a commit.',
		input: {
			branch: z.string().describe('Branch to commit.'),
			message: z.string().min(1).describe('Commit message.'),
		},
		kind: 'write',
		surfaces: BOTH,
		progress: ({ branch }) => `Committing to "${branch}"…`,
		confirm: ({ branch, message }) => ({
			title: 'Commit Branch',
			message: `Commit all staged changes to branch **${branch}** with message: "${message}"?`,
		}),
		run: async (api, { branch, message }) => {
			await api.commitBranch(branch, message, { stageAll: true })
			return `Committed to branch "${branch}" with message: "${message}".`
		},
	}),

	defineTool({
		name: 'rebaseBranch',
		description: 'Rebases the branch onto its configured parent branch.',
		input: { branch: z.string().describe('Branch to rebase.') },
		kind: 'write',
		surfaces: MCP_ONLY,
		excluded: { lm: NOT_IN_CHAT },
		progress: ({ branch }) => `Rebasing "${branch}"…`,
		run: async (api, { branch }) => {
			await api.rebaseBranch(branch)
			return `Rebased "${branch}" onto its parent.`
		},
	}),

	defineTool({
		name: 'pullBranch',
		description: 'Pulls the latest changes from origin into a branch worktree (git pull --rebase).',
		input: { branch: z.string().describe('Branch to pull.') },
		kind: 'write',
		surfaces: LM_ONLY,
		excluded: { mcp: NOT_IN_MCP_PUSH },
		progress: ({ branch }) => `Pulling "${branch}"…`,
		confirm: ({ branch }) => ({
			title: 'Pull Branch',
			message: `Pull (rebase) the latest changes from origin into branch **${branch}**?`,
		}),
		run: async (api, { branch }) => {
			await api.pullBranch(branch)
			return `Pulled latest changes into branch "${branch}".`
		},
	}),

	defineTool({
		name: 'syncBranch',
		description: 'Pulls (rebase) then pushes a branch to origin.',
		input: { branch: z.string().describe('Branch to sync.') },
		kind: 'write',
		surfaces: LM_ONLY,
		excluded: { mcp: NOT_IN_MCP_PUSH },
		progress: ({ branch }) => `Syncing "${branch}"…`,
		confirm: ({ branch }) => ({
			title: 'Sync Branch',
			message: `Pull (rebase) then push branch **${branch}**?`,
		}),
		run: async (api, { branch }) => {
			await api.syncBranch(branch)
			return `Synced branch "${branch}" (pull then push).`
		},
	}),
]

/** The chat tool name for a registry tool. */
export function lmToolName(tool: AgentTool): string {
	return `gitbraid_${tool.name}`
}

export function toolsFor(surface: ToolSurface): readonly AgentTool[] {
	return AGENT_TOOLS.filter((t) => t.surfaces.includes(surface))
}
