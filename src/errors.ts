

export class NotImplementedError extends Error {
    constructor(message: string = 'Not implemented') {
        super(message)
		this.name = 'NotImplementedError'
    }
}

export class ConfigError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'ConfigError'
	}
}

export class SyncError extends Error {
	constructor(message: string, public readonly sourcePath?: string) {
		super(message)
		this.name = 'SyncError'
	}
}

export class BranchStackError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'BranchStackError'
	}
}

export class GitError extends Error {
	constructor (message: string, public readonly code: number) {
		super(message)
		this.name = 'GitError'
	}
}

export class WorktreeNotFoundError extends Error {
	constructor (message: string) {
		super(message)
		this.name = 'WorktreeNotFoundError'
	}
}

/**
 * Union of every error type the GitBraid API surface may throw. Downstream
 * consumers (including LM tools) can narrow on `instanceof` rather than
 * parsing `e.message`.
 */
export type GitBraidError =
	| NotImplementedError
	| ConfigError
	| SyncError
	| BranchStackError
	| GitError
	| WorktreeNotFoundError
