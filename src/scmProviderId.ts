/**
 * Source-control provider ids for per-branch SCM entries.
 *
 * VS Code exposes the provider id to `when` clauses as `scmProvider`, and it
 * is the only per-provider key menu contributions can match on.  Virtual
 * branches get a distinct prefix so menus (for example Materialise) can be
 * scoped to them.  `:` is not allowed in git ref names, so a virtual id can
 * never collide with a regular branch id.
 */

const PREFIX = 'gitbraid-'
const VIRTUAL_PREFIX = 'gitbraid-virtual:'

export function scmProviderId(branchName: string, virtual: boolean): string {
	return (virtual ? VIRTUAL_PREFIX : PREFIX) + branchName
}

/** Inverse of {@link scmProviderId}; `undefined` if `id` is not a GitBraid provider id. */
export function branchNameFromScmProviderId(id: unknown): string | undefined {
	if (typeof id !== 'string') return undefined
	if (id.startsWith(VIRTUAL_PREFIX)) return id.slice(VIRTUAL_PREFIX.length)
	if (id.startsWith(PREFIX)) return id.slice(PREFIX.length)
	return undefined
}

/**
 * Extract a branch name from a command argument.  Menus under `scm/sourceControl`
 * pass the `SourceControl` instance, whose `id` encodes the branch.
 */
export function branchNameFromScmArg(arg: unknown): string | undefined {
	if (arg && typeof arg === 'object' && 'id' in arg) {
		return branchNameFromScmProviderId((arg as { id?: unknown }).id)
	}
	return undefined
}
