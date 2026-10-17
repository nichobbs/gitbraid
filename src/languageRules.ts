/**
 * Lexical rules for the conservative hunk classifier (`hunkClassifier.ts`).
 *
 * Pure data, no `vscode` import.  The classifier only needs enough of each
 * language to tell comments, string literals and code apart; where a language
 * has constructs it cannot lex reliably (C# verbatim strings, shell heredocs,
 * YAML block scalars) the rules carry a `disqualifyingFile` pattern so every
 * hunk in such a file is `logic`.
 */

export interface StringRule {
	open: string
	close: string
	/** May continue past the end of the line (template literals, triple quotes, ...). */
	multiline: boolean
	/** A backslash escapes the next character. */
	escape: boolean
}

export interface LanguageRules {
	id: string
	lineComments: readonly string[]
	blockComment?: { open: string, close: string, nests?: boolean }
	/** Ordered longest `open` first. */
	strings: readonly StringRule[]
	/** Sticky pattern for a whole character literal, tried before `strings`. */
	charLiteral?: RegExp
	/** Indentation carries meaning (Python, YAML): never ignore leading whitespace. */
	significantWhitespace: boolean
	/** Spacing inside a line may be normalised (C-like languages). */
	intraLineWhitespace: boolean
	/** `/` may start a regular-expression literal; spacing on such lines is left alone. */
	regexLiterals: boolean
	/** A line comment marker only counts at the start of a line or after whitespace. */
	lineCommentNeedsSpace?: boolean
	/** Quotes only open a string at the start of a value (YAML). */
	quotesOnlyAtValueStart?: boolean
	/** A whole-line import statement. */
	importLine?: RegExp
	/** Any match anywhere in the file makes every hunk `logic`. */
	disqualifyingFile?: RegExp
	/** Never trivial (Markdown: trailing spaces and blank lines are content). */
	alwaysLogic?: boolean
	/** Unknown language: only trailing whitespace and CRLF differences are trivial. */
	whitespaceOnly?: boolean
}

const dq: StringRule = { open: '"', close: '"', multiline: false, escape: true }
const sq: StringRule = { open: "'", close: "'", multiline: false, escape: true }
const CHAR_LITERAL = /'(?:\\(?:x[0-9a-fA-F]{1,2}|u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|[0-7]{1,3}|.)|[^\\'])'/y

const jsLike: LanguageRules = {
	id: 'js',
	lineComments: ['//'],
	blockComment: { open: '/*', close: '*/' },
	strings: [dq, sq, { open: '`', close: '`', multiline: true, escape: true }],
	significantWhitespace: false,
	intraLineWhitespace: true,
	regexLiterals: true,
	importLine: /^\s*import\s+(?:type\s+)?(?:[\w*${}\s,]+\s+from\s+)?['"][^'"]+['"]\s*;?\s*$/,
}

const cLike: Omit<LanguageRules, 'id'> = {
	lineComments: ['//'],
	blockComment: { open: '/*', close: '*/' },
	strings: [dq],
	charLiteral: CHAR_LITERAL,
	significantWhitespace: false,
	intraLineWhitespace: true,
	regexLiterals: false,
}

const RULES: Record<string, LanguageRules> = {
	js: jsLike,
	java: {
		...cLike,
		id: 'java',
		strings: [{ open: '"""', close: '"""', multiline: true, escape: true }, dq],
		importLine: /^\s*import\s+(?:static\s+)?[\w.*]+\s*;\s*$/,
	},
	python: {
		id: 'python',
		lineComments: ['#'],
		strings: [
			{ open: '"""', close: '"""', multiline: true, escape: true },
			{ open: "'''", close: "'''", multiline: true, escape: true },
			dq,
			sq,
		],
		significantWhitespace: true,
		intraLineWhitespace: false,
		regexLiterals: false,
		importLine: /^\s*(?:import\s+[\w., ]+|from\s+[\w.]+\s+import\s+[\w*, ]+)(?:\s+as\s+\w+)?\s*$/,
	},
	go: {
		...cLike,
		id: 'go',
		strings: [{ open: '`', close: '`', multiline: true, escape: false }, dq],
		importLine: /^\s*import\s+(?:\w+\s+)?"[^"]+"\s*$/,
	},
	rust: {
		...cLike,
		id: 'rust',
		blockComment: { open: '/*', close: '*/', nests: true },
		strings: [{ open: '"', close: '"', multiline: true, escape: true }],
		importLine: /^\s*(?:pub\s+)?use\s+.+;\s*$/,
		// Raw strings (r#"..."#) are not lexed.
		disqualifyingFile: /\br#*"/,
	},
	c: {
		...cLike,
		id: 'c',
		importLine: /^\s*#\s*include\s+[<"][^>"]+[>"]\s*$/,
		// Raw string literals are not lexed.
		disqualifyingFile: /\bR"[^(\s]*\(/,
	},
	csharp: {
		...cLike,
		id: 'csharp',
		strings: [{ open: '"""', close: '"""', multiline: true, escape: false }, dq],
		importLine: /^\s*using\s+(?:static\s+)?[\w.]+\s*;\s*$/,
		// Verbatim and interpolated-verbatim strings are not lexed.
		disqualifyingFile: /@\$?"|\$@"/,
	},
	shell: {
		id: 'shell',
		lineComments: ['#'],
		lineCommentNeedsSpace: true,
		strings: [
			{ open: '"', close: '"', multiline: true, escape: true },
			{ open: "'", close: "'", multiline: true, escape: false },
		],
		significantWhitespace: false,
		intraLineWhitespace: false,
		regexLiterals: false,
		// Heredocs are not lexed.
		disqualifyingFile: /<<-?\s*["']?\w/,
	},
	yaml: {
		id: 'yaml',
		lineComments: ['#'],
		lineCommentNeedsSpace: true,
		quotesOnlyAtValueStart: true,
		strings: [
			{ open: '"', close: '"', multiline: true, escape: true },
			{ open: "'", close: "'", multiline: true, escape: false },
		],
		significantWhitespace: true,
		intraLineWhitespace: false,
		regexLiterals: false,
		// Block scalars (| and >) are not lexed.
		disqualifyingFile: /(?:^|[:\-]\s+)[|>][+-]?\d?\s*(?:#.*)?$/m,
	},
	markdown: {
		id: 'markdown',
		lineComments: [],
		strings: [],
		significantWhitespace: true,
		intraLineWhitespace: false,
		regexLiterals: false,
		alwaysLogic: true,
	},
	generic: {
		id: 'generic',
		lineComments: [],
		strings: [],
		significantWhitespace: true,
		intraLineWhitespace: false,
		regexLiterals: false,
		whitespaceOnly: true,
	},
}

const BY_EXTENSION: Record<string, string> = {
	ts: 'js', tsx: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', mts: 'js', cts: 'js',
	java: 'java',
	py: 'python',
	go: 'go',
	rs: 'rust',
	c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c', hxx: 'c',
	cs: 'csharp',
	sh: 'shell', bash: 'shell', zsh: 'shell',
	yml: 'yaml', yaml: 'yaml',
	md: 'markdown', markdown: 'markdown', mdx: 'markdown',
}

/** Rules for `relativePath`, chosen by extension; unknown extensions get whitespace-only rules. */
export function languageRulesFor(relativePath: string): LanguageRules {
	const base = relativePath.replaceAll('\\', '/').split('/').pop() ?? ''
	const dot = base.lastIndexOf('.')
	const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
	return RULES[BY_EXTENSION[ext] ?? 'generic']
}
