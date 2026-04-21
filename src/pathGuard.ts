import * as path from 'node:path'
import { ConfigError } from './errors'

/**
 * Path-containment guard used by services that pass workspace-relative
 * paths to git commands.  Normalises slashes, resolves against the root,
 * and throws `ConfigError` if the resulting absolute path would escape
 * `workspaceRoot` via `..` segments (POSIX or Windows).
 *
 * The spawn-with-argv migration (remediation T18) removes the shell as an
 * attack vector, but this helper is still the right place to stop the
 * extension from reading / writing files outside the workspace.
 *
 * Usage:
 * ```ts
 * const abs = requireInside(wsRoot, relativePath)
 * await fs.readFile(abs)
 * ```
 */
export function requireInside(workspaceRoot: string, relativePath: string): string {
	// Normalise Windows-style separators so both `..\..\foo` and `../../foo`
	// are detected by `path.resolve` on any host.
	const normalised = relativePath.replace(/\\/g, '/')
	const resolved = path.resolve(workspaceRoot, normalised)
	const rootWithSep = workspaceRoot.endsWith(path.sep) ? workspaceRoot : workspaceRoot + path.sep
	if (resolved !== workspaceRoot && !resolved.startsWith(rootWithSep)) {
		throw new ConfigError(`Path escapes workspace root: ${relativePath}`)
	}
	return resolved
}

/**
 * Pure boolean variant for call sites that prefer branching over
 * exception propagation.  Mirrors `requireInside` but returns `undefined`
 * instead of throwing.
 */
export function resolveInside(workspaceRoot: string, relativePath: string): string | undefined {
	try {
		return requireInside(workspaceRoot, relativePath)
	} catch {
		return undefined
	}
}
