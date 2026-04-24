import * as assert from 'node:assert'
import { matchGlob, clearGlobCache, compileGlob } from '../src/globMatcher'

// ─── Targeted unit tests ─────────────────────────────────────────────────────

suite('globMatcher — supported subset', () => {

	setup(() => clearGlobCache())

	// `**/` leading — zero or more prefix segments.

	test('**/node_modules/** matches at root', () => {
		assert.strictEqual(matchGlob('**/node_modules/**', 'node_modules/pkg/index.js'), true)
	})

	test('**/node_modules/** matches single-segment prefix', () => {
		assert.strictEqual(matchGlob('**/node_modules/**', 'a/node_modules/pkg/index.js'), true)
	})

	test('**/node_modules/** matches multi-segment prefix', () => {
		assert.strictEqual(matchGlob('**/node_modules/**', 'a/b/c/node_modules/pkg/sub/nested.js'), true)
	})

	test('**/node_modules/** does not match the directory itself', () => {
		// Trailing `/**` requires at least one char after the slash.
		assert.strictEqual(matchGlob('**/node_modules/**', 'node_modules'), false)
	})

	test('**/.git/objects/** matches the default VS Code exclude', () => {
		assert.strictEqual(matchGlob('**/.git/objects/**', '.git/objects/ab/cdef'), true)
		assert.strictEqual(matchGlob('**/.git/objects/**', 'sub/.git/objects/x'), true)
	})

	// `/**/` middle — zero or more intermediate segments.

	test('a/**/c matches zero intermediates', () => {
		assert.strictEqual(matchGlob('a/**/c', 'a/c'), true)
	})

	test('a/**/c matches one intermediate', () => {
		assert.strictEqual(matchGlob('a/**/c', 'a/b/c'), true)
	})

	test('a/**/c matches many intermediates', () => {
		assert.strictEqual(matchGlob('a/**/c', 'a/b1/b2/b3/c'), true)
	})

	test('a/**/c does not match an unrelated trailing segment', () => {
		assert.strictEqual(matchGlob('a/**/c', 'a/b/cx'), false)
	})

	// Trailing `/**` — one or more segments required.

	test('dist/** does not match the bare directory', () => {
		assert.strictEqual(matchGlob('dist/**', 'dist'), false)
	})

	test('dist/** matches immediate children', () => {
		assert.strictEqual(matchGlob('dist/**', 'dist/bundle.js'), true)
	})

	test('dist/** matches deep descendants', () => {
		assert.strictEqual(matchGlob('dist/**', 'dist/a/b/c/bundle.js'), true)
	})

	// Single `*` — segment-local.

	test('*.log matches at root, not at nested', () => {
		assert.strictEqual(matchGlob('*.log', 'app.log'), true)
		assert.strictEqual(matchGlob('*.log', 'logs/app.log'), false)
	})

	test('**/*.log matches at any depth', () => {
		assert.strictEqual(matchGlob('**/*.log', 'app.log'), true)
		assert.strictEqual(matchGlob('**/*.log', 'logs/app.log'), true)
		assert.strictEqual(matchGlob('**/*.log', 'a/b/c/app.log'), true)
	})

	// `?` — single-character wildcard.

	test('foo?bar matches single-char substitution', () => {
		assert.strictEqual(matchGlob('foo?bar', 'fooxbar'), true)
	})

	test('foo?bar does not match zero or multi-char substitution', () => {
		assert.strictEqual(matchGlob('foo?bar', 'foobar'), false)
		assert.strictEqual(matchGlob('foo?bar', 'fooxxbar'), false)
	})

	test('foo?bar does not match across a slash', () => {
		assert.strictEqual(matchGlob('foo?bar', 'foo/bar'), false)
	})

	// Bare literal — exact only, no implicit descendant behaviour.

	test('node_modules matches only the literal path', () => {
		assert.strictEqual(matchGlob('node_modules', 'node_modules'), true)
		assert.strictEqual(matchGlob('node_modules', 'node_modules/a'), false)
		assert.strictEqual(matchGlob('node_modules', 'a/node_modules'), false)
	})

	// Standalone `**` — matches everything.

	test('** matches everything including empty', () => {
		assert.strictEqual(matchGlob('**', ''), true)
		assert.strictEqual(matchGlob('**', 'x'), true)
		assert.strictEqual(matchGlob('**', 'x/y/z'), true)
	})

	// Escaping — regex metacharacters must be treated as literals.

	test('pattern with a dot matches the dot literally', () => {
		assert.strictEqual(matchGlob('a.b', 'a.b'), true)
		assert.strictEqual(matchGlob('a.b', 'aXb'), false)
	})

	test('pattern with parentheses is treated as literal', () => {
		assert.strictEqual(matchGlob('pkg(1)', 'pkg(1)'), true)
		assert.strictEqual(matchGlob('pkg(1)', 'pkg1'), false)
	})
})

// ─── Full glob syntax — brace expansion and character classes ──────────────

suite('globMatcher — full glob syntax', () => {

	test('brace expansion {a,b} expands correctly', () => {
		assert.strictEqual(matchGlob('**/*.{log,tmp}', 'app.log'), true)
		assert.strictEqual(matchGlob('**/*.{log,tmp}', 'app.tmp'), true)
		assert.strictEqual(matchGlob('**/*.{log,tmp}', 'sub/a.log'), true)
		assert.strictEqual(matchGlob('**/*.{log,tmp}', 'app.txt'), false)
	})

	test('character classes [abc] expand correctly', () => {
		assert.strictEqual(matchGlob('**/*.[jt]s', 'script.ts'), true)
		assert.strictEqual(matchGlob('**/*.[jt]s', 'script.js'), true)
		assert.strictEqual(matchGlob('**/*.[jt]s', 'script.py'), false)
	})
})

// ─── Cache — compiled regexes are reused. ───────────────────────────────────

suite('globMatcher — regex cache', () => {

	setup(() => clearGlobCache())

	test('two calls with the same pattern return the identical matcher', () => {
		const m1 = compileGlob('**/*.log')
		const m2 = compileGlob('**/*.log')
		assert.strictEqual(m1, m2, 'compiled matcher should be cached')
	})

	test('clearGlobCache actually clears', () => {
		const m1 = compileGlob('**/*.log')
		clearGlobCache()
		const m2 = compileGlob('**/*.log')
		assert.notStrictEqual(m1, m2, 'post-clear compile should return a fresh matcher')
	})
})

// ─── Differential test vs minimatch ─────────────────────────────────────────
//
// The bus uses this matcher for `files.watcherExclude` — semantically the
// reference is minimatch (what VS Code's internal matcher is modelled on).
// Run a parametric suite that asserts we agree with minimatch on every
// pattern/path pair in the supported subset.  Brace-expansion and
// character-class patterns are listed separately as known differences.

// Dynamic require so the extension bundle never picks minimatch up — it is
// a devDependency used only here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { minimatch } = require('minimatch') as { minimatch: (p: string, g: string, o?: object) => boolean }

const SUPPORTED_PATTERNS = [
	'**/.git/objects/**',
	'**/.git/subtree-cache/**',
	'**/node_modules/**',
	'**/node_modules/*/**',
	'**/.hg/store/**',
	'node_modules/**',
	'node_modules',
	'dist/**',
	'**/*.log',
	'a/**/c',
	'a/*/c',
	'foo?bar',
	'**',
	'.git/**',
	'**/*.{log,tmp}',
	'**/*.[jt]s',
]

const PATHS = [
	'node_modules/pkg/index.js',
	'a/node_modules/pkg/index.js',
	'a/b/node_modules/pkg/index.js',
	'a/b/c/node_modules/pkg/sub/nested.js',
	'.git/objects/ab/cdef',
	'src/.git/objects/x',
	'dist/bundle.js',
	'dist/sub/bundle.js',
	'app.log',
	'logs/app.log',
	'src/app.log',
	'app.tmp',
	'script.ts',
	'script.js',
	'fooxbar',
	'foobar',
	'foo/bar',
	'a/c',
	'a/b/c',
	'a/x/c',
	'a/b/x/c',
	'any.txt',
	'',
]

suite('globMatcher — differential vs minimatch (supported subset)', () => {
	for (const glob of SUPPORTED_PATTERNS) {
		for (const rel of PATHS) {
			const expected = minimatch(rel, glob, { dot: true })
			test(`glob=${JSON.stringify(glob)} vs path=${JSON.stringify(rel)}`, () => {
				const actual = matchGlob(glob, rel)
				assert.strictEqual(
					actual,
					expected,
					`matchGlob disagrees with minimatch for glob=${JSON.stringify(glob)} path=${JSON.stringify(rel)}`,
				)
			})
		}
	}
})
