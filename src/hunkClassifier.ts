import { languageRulesFor } from './languageRules'
import type { LanguageRules, StringRule } from './languageRules'

/**
 * Conservative classification of diff hunks (plan 18).
 *
 * The one rule: a hunk is never labelled trivial unless it provably is.
 * Anything the lexer cannot establish (unknown lexical state, a hunk that
 * opens or closes a comment or string, an earlier hunk that did, magic
 * comments, languages with constructs we do not lex) is `logic`.
 *
 * Pure module: no `vscode` import, no I/O.
 */

export type HunkKind = 'whitespace' | 'comment' | 'import' | 'logic' | 'mixed'

/** The parts of a `DiffHunk` the classifier needs. */
export interface HunkLike {
	startLine: number
	endLine: number
	patch: string
}

/** Kinds that auto-routing and absorb may treat as safe to skip or inherit. */
export function isTrivialKind(kind: HunkKind): kind is 'whitespace' | 'comment' {
	return kind === 'whitespace' || kind === 'comment'
}

// ─── Lexer ───────────────────────────────────────────────────────────────────

type LexState =
	| { kind: 'code' }
	| { kind: 'block', depth: number }
	| { kind: 'string', rule: StringRule }

const CODE: LexState = { kind: 'code' }

function sameState(a: LexState, b: LexState): boolean {
	if (a.kind !== b.kind) return false
	if (a.kind === 'block' && b.kind === 'block') return a.depth === b.depth
	if (a.kind === 'string' && b.kind === 'string') return a.rule === b.rule
	return true
}

interface CodeChar { ch: string, str: boolean }

interface LineLex {
	/** Code with comments replaced by a space; string literals kept verbatim. */
	code: CodeChar[]
	/** All comment text on the line, markers included. */
	comment: string
	startState: LexState
	endState: LexState
	/** The line begins inside a string literal, so its text is string content. */
	startsInString: boolean
}

/** Comment text that changes behaviour or tooling, so editing it is not "just a comment". */
const MAGIC_COMMENT = new RegExp(
	'^(?:\\/\\/+|\\/\\*+|#+|--|\\*)\\s*(?:' +
	[
		'@ts-', '@jsx', '@flow', '@vite-ignore', '@vitest', '@jest', 'eslint', 'tslint', 'prettier', 'istanbul', 'c8\\b', 'v8\\b',
		'jshint', 'biome', 'deno-lint', 'webpack', 'sonar', 'NOSONAR', 'NOLINT', 'nolint', 'noinspection', 'noqa', 'nosec',
		'pylint', 'type:', 'pragma', 'clang-format', 'shellcheck', 'cspell', 'jscpd', 'SPDX', 'go:', '\\+build',
		'-\\*-', 'coding[:=]', '!', 'region\\b', 'endregion\\b', '#region', '#endregion', 'lint', 'codeql', 'checkov', 'trivy',
	].join('|') + ')',
	'i',
)

function startsWithAt(text: string, i: number, token: string): boolean {
	return token.length > 0 && text.startsWith(token, i)
}

/** Lex one line starting in `state`. */
function lexLine(line: string, state: LexState, rules: LanguageRules): LineLex {
	const code: CodeChar[] = []
	let comment = ''
	const startState = state
	const startsInString = state.kind === 'string'
	let i = 0
	const n = line.length
	const push = (s: string, str: boolean) => { for (const ch of s) code.push({ ch, str }) }

	while (i < n) {
		if (state.kind === 'block') {
			const bc = rules.blockComment!
			const close = line.indexOf(bc.close, i)
			const open = bc.nests ? line.indexOf(bc.open, i) : -1
			if (open >= 0 && (close < 0 || open < close)) {
				comment += line.slice(i, open + bc.open.length)
				i = open + bc.open.length
				state = { kind: 'block', depth: state.depth + 1 }
			} else if (close >= 0) {
				comment += line.slice(i, close + bc.close.length)
				i = close + bc.close.length
				state = state.depth > 1 ? { kind: 'block', depth: state.depth - 1 } : CODE
				if (state.kind === 'code') push(' ', false)
			} else {
				comment += line.slice(i)
				i = n
			}
			continue
		}

		if (state.kind === 'string') {
			const rule = state.rule
			let closed = false
			while (i < n) {
				if (rule.escape && line[i] === '\\') {
					push(line.slice(i, i + 2), true)
					i += 2
					continue
				}
				if (startsWithAt(line, i, rule.close)) {
					push(rule.close, true)
					i += rule.close.length
					closed = true
					break
				}
				push(line[i], true)
				i++
			}
			if (closed) state = CODE
			continue
		}

		// Code state.
		const prev = i > 0 ? line[i - 1] : ''
		const escapedByBackslash = rules.regexLiterals && prev === '\\'

		if (!escapedByBackslash) {
			let lineComment: string | undefined
			for (const marker of rules.lineComments) {
				if (!startsWithAt(line, i, marker)) continue
				if (rules.lineCommentNeedsSpace && i > 0 && !/\s/.test(prev)) continue
				lineComment = marker
				break
			}
			if (lineComment) {
				comment += line.slice(i)
				push(' ', false)
				i = n
				continue
			}
			const bc = rules.blockComment
			if (bc && startsWithAt(line, i, bc.open)) {
				comment += bc.open
				i += bc.open.length
				state = { kind: 'block', depth: 1 }
				continue
			}
		}

		if (rules.charLiteral && line[i] === "'") {
			rules.charLiteral.lastIndex = i
			const m = rules.charLiteral.exec(line)
			if (m && m.index === i) {
				push(m[0], true)
				i += m[0].length
				continue
			}
		}

		const opener = rules.strings.find((s) => startsWithAt(line, i, s.open))
		if (opener && !(rules.quotesOnlyAtValueStart && !atValueStart(code))) {
			push(opener.open, true)
			i += opener.open.length
			state = { kind: 'string', rule: opener }
			continue
		}

		push(line[i], false)
		i++
	}

	// A single-line string left open at the end of a line ends there.
	if (state.kind === 'string' && !state.rule.multiline) state = CODE

	return { code, comment, startState, endState: state, startsInString }
}

/** YAML: a quote opens a scalar only at the start of a value. */
function atValueStart(code: readonly CodeChar[]): boolean {
	for (let k = code.length - 1; k >= 0; k--) {
		const c = code[k]
		if (c.str) return false
		if (/\s/.test(c.ch)) continue
		return c.ch === ':' || c.ch === '-' || c.ch === ',' || c.ch === '[' || c.ch === '{'
	}
	return true
}

// ─── Normalisation ───────────────────────────────────────────────────────────

type CharClass = 'W' | 'O' | 'P'

function classOf(c: CodeChar): CharClass {
	if (c.str) return 'W'
	if (/[\w$\u0080-￿]/.test(c.ch)) return 'W'
	if ('()[]{},;'.includes(c.ch)) return 'P'
	return 'O'
}

/** Comparable form of a line's code: comments out, spacing normalised as far as the language safely allows. */
function normaliseCode(code: readonly CodeChar[], rules: LanguageRules): string {
	let end = code.length
	while (end > 0 && !code[end - 1].str && /\s/.test(code[end - 1].ch)) end--
	let start = 0
	if (!rules.significantWhitespace) {
		while (start < end && !code[start].str && /\s/.test(code[start].ch)) start++
	}
	const body = code.slice(start, end)
	const exact = body.map((c) => c.ch).join('')
	if (!rules.intraLineWhitespace) return exact
	// Spacing around a possible regex literal is meaningful; leave such lines exact.
	if (rules.regexLiterals && body.some((c) => !c.str && c.ch === '/')) return exact

	let out = ''
	for (let k = 0; k < body.length; k++) {
		const c = body[k]
		if (c.str || !/\s/.test(c.ch)) {
			out += c.ch
			continue
		}
		let m = k
		while (m < body.length && !body[m].str && /\s/.test(body[m].ch)) m++
		const before = k > 0 ? classOf(body[k - 1]) : undefined
		const after = m < body.length ? classOf(body[m]) : undefined
		const keep = before !== undefined && after !== undefined &&
			((before === 'W' && after === 'W') || (before === 'O' && after === 'O'))
		if (keep) out += ' '
		k = m - 1
	}
	return out
}

function normaliseComment(text: string): string {
	return text.replace(/\s+/g, ' ').trim()
}

// ─── Hunk parsing ────────────────────────────────────────────────────────────

interface HunkBody {
	removed: string[]
	added: string[]
	/** Lines present before the change (context + removed), in order. */
	oldLines: Array<{ text: string, changed: boolean }>
	/** Lines present after the change (context + added), in order. */
	newLines: Array<{ text: string, changed: boolean }>
}

function parseBody(patch: string): HunkBody | undefined {
	const lines = patch.split('\n')
	const at = lines.findIndex((l) => l.startsWith('@@'))
	if (at < 0) return undefined
	const body: HunkBody = { removed: [], added: [], oldLines: [], newLines: [] }
	for (let k = at + 1; k < lines.length; k++) {
		const l = lines[k]
		if (l.startsWith('@@')) return undefined   // more than one hunk: not our input
		const text = l.slice(1).replace(/\r$/, '')
		switch (l[0]) {
			case ' ':
				body.oldLines.push({ text, changed: false })
				body.newLines.push({ text, changed: false })
				break
			case '-':
				body.removed.push(text)
				body.oldLines.push({ text, changed: true })
				break
			case '+':
				body.added.push(text)
				body.newLines.push({ text, changed: true })
				break
			default:
				break   // "\ No newline at end of file", trailing blank
		}
	}
	return body
}

// ─── Per-hunk classification ─────────────────────────────────────────────────

export interface HunkVerdict {
	kind: HunkKind
	/** The hunk opens or closes a comment/string, so later hunks' lexical state is unknown. */
	stateChanging: boolean
}

const LOGIC: HunkVerdict = { kind: 'logic', stateChanging: false }

function sameSeq(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i])
}

/** Lex `lines` from `start`, returning per-line results and the final state. */
function lexRun(
	lines: ReadonlyArray<{ text: string, changed: boolean }>,
	start: LexState,
	rules: LanguageRules,
): { lexed: LineLex[], end: LexState } {
	let state = start
	const lexed: LineLex[] = []
	for (const l of lines) {
		const r = lexLine(l.text, state, rules)
		lexed.push(r)
		state = r.endState
	}
	return { lexed, end: state }
}

export function classifyHunk(hunk: HunkLike, rules: LanguageRules, startState: LexState = CODE): HunkVerdict {
	if (rules.alwaysLogic) return LOGIC
	const body = parseBody(hunk.patch)
	if (!body || (body.removed.length === 0 && body.added.length === 0)) return LOGIC

	// Unknown language: trailing whitespace / CRLF only, compared line for line.
	if (rules.whitespaceOnly) {
		const r = body.removed.map((s) => s.replace(/\s+$/, ''))
		const a = body.added.map((s) => s.replace(/\s+$/, ''))
		return sameSeq(r, a) ? { kind: 'whitespace', stateChanging: false } : LOGIC
	}

	const oldRun = lexRun(body.oldLines, startState, rules)
	const newRun = lexRun(body.newLines, startState, rules)
	const balanced = sameState(oldRun.end, newRun.end)
	if (!balanced) return { kind: 'logic', stateChanging: true }

	const changedOld = oldRun.lexed.filter((_, i) => body.oldLines[i].changed)
	const changedNew = newRun.lexed.filter((_, i) => body.newLines[i].changed)
	const changed = [...changedOld, ...changedNew]

	// Text inside a multi-line string is content, whatever it looks like.
	if (changed.some((l) => l.startsInString)) return LOGIC

	// Fold magic comments into the code so editing one counts as a code change.
	const view = (l: LineLex) => {
		const magic = MAGIC_COMMENT.test(l.comment.trim()) ? l.comment : ''
		return {
			code: magic ? [...l.code, ...[...magic].map((ch) => ({ ch, str: true }))] : l.code,
			comment: magic ? '' : l.comment,
		}
	}
	const views = new Map<LineLex, ReturnType<typeof view>>()
	for (const l of [...oldRun.lexed, ...newRun.lexed]) views.set(l, view(l))

	// Compare the WHOLE hunk, context included: moving a statement past its
	// neighbours leaves the removed and added lines identical but changes order.
	const codeLines = (lines: LineLex[]) => lines
		.map((l) => ({ norm: normaliseCode(views.get(l)!.code, rules), raw: views.get(l)!.code.map((c) => c.ch).join('').trim() }))
		.filter((e) => e.norm !== '')
	const commentOf = (lines: LineLex[]) => lines.map((l) => normaliseComment(views.get(l)!.comment)).filter((s) => s !== '')

	const codeOld = codeLines(oldRun.lexed)
	const codeNew = codeLines(newRun.lexed)
	const commentsChanged = !sameSeq(commentOf(changedOld), commentOf(changedNew))

	if (sameSeq(codeOld.map((e) => e.norm), codeNew.map((e) => e.norm))) {
		return { kind: commentsChanged ? 'comment' : 'whitespace', stateChanging: false }
	}

	// Import-only: everything but the import lines is unchanged.
	if (rules.importLine && !commentsChanged) {
		const rest = (es: Array<{ norm: string, raw: string }>) => es.filter((e) => !rules.importLine!.test(e.raw)).map((e) => e.norm)
		const importsTouched = [...changedOld, ...changedNew].some((l) => {
			const raw = views.get(l)!.code.map((c) => c.ch).join('').trim()
			return raw !== '' && rules.importLine!.test(raw)
		})
		if (importsTouched && sameSeq(rest(codeOld), rest(codeNew))) return { kind: 'import', stateChanging: false }
	}

	const hasCommentOnlyLine = changed.some((l) => {
		const v = views.get(l)!
		return normaliseCode(v.code, rules) === '' && normaliseComment(v.comment) !== ''
	})
	return { kind: hasCommentOnlyLine ? 'mixed' : 'logic', stateChanging: false }
}

// ─── Per-file classification ─────────────────────────────────────────────────

/** Lexical state at the start of every line of `lines` (index = 0-based line number). */
function lineStartStates(lines: readonly string[], rules: LanguageRules): LexState[] {
	const states: LexState[] = []
	let state: LexState = CODE
	for (const l of lines) {
		states.push(state)
		state = lexLine(l.replace(/\r$/, ''), state, rules).endState
	}
	states.push(state)
	return states
}

/**
 * Classify every hunk of one file.  `fileText` is the working-tree (new)
 * content the hunks were diffed against; it is needed to know whether each
 * hunk starts inside a comment or string.  Returns one kind per hunk, in order.
 *
 * Without a file the lexical state is unknowable, so callers that cannot
 * supply it should treat every hunk as `logic` (this function does if the
 * text is empty or does not contain the hunk's context).
 */
export function classifyFileHunks(
	hunks: readonly HunkLike[],
	fileText: string | undefined,
	relativePath: string,
): HunkKind[] {
	const rules = languageRulesFor(relativePath)
	if (rules.alwaysLogic || fileText === undefined) return hunks.map(() => 'logic')
	if (rules.disqualifyingFile?.test(fileText)) return hunks.map(() => 'logic')

	const fileLines = fileText.split('\n')
	const needsState = !rules.whitespaceOnly
	const states = needsState ? lineStartStates(fileLines, rules) : []

	let tainted = false
	return hunks.map((h): HunkKind => {
		if (tainted) return 'logic'
		const body = parseBody(h.patch)
		if (!body) return 'logic'

		// New-side lines before the hunk.  A pure deletion's startLine is the line above it.
		const pureDeletion = h.endLine < h.startLine
		const preceding = Math.max(0, pureDeletion ? h.startLine : h.startLine - 1)

		// The hunk must describe the text we were given.
		if (!matchesFile(body, fileLines, preceding)) return 'logic'

		const verdict = classifyHunk(h, rules, needsState ? states[preceding] : CODE)
		if (verdict.stateChanging) tainted = true
		return verdict.kind
	})
}

function matchesFile(body: HunkBody, fileLines: readonly string[], preceding: number): boolean {
	for (let k = 0; k < body.newLines.length; k++) {
		const actual = fileLines[preceding + k]
		if (actual === undefined || actual.replace(/\r$/, '') !== body.newLines[k].text) return false
	}
	return true
}
