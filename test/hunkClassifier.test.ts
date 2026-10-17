import * as assert from 'node:assert'
import { classifyFileHunks, isTrivialKind } from '../src/hunkClassifier'
import type { HunkKind } from '../src/hunkClassifier'
import { languageRulesFor } from '../src/languageRules'
import { diffOf } from './helpers/diffOf'

function kinds(oldText: string, newText: string, file: string, context = 3): HunkKind[] {
	return classifyFileHunks(diffOf(oldText, newText, file.split('/').pop(), context), newText, file)
}

interface Case { name: string, file: string, old: string, new: string, expect: HunkKind[], context?: number }

const TS_BASE = [
	'import { a } from "./a"',
	'',
	'export function f(x: number): number {',
	'\tconst s = "http://example.com"',
	'\t// compute',
	'\treturn x + 1',
	'}',
	'',
].join('\n')

const CASES: Case[] = [
	// ── TypeScript / JavaScript ────────────────────────────────────────────
	{ name: 'ts: reindent + spacing is whitespace', file: 'x.ts', old: TS_BASE, new: TS_BASE.replace('\treturn x + 1', '    return x+1'), expect: ['whitespace'] },
	{ name: 'ts: trailing whitespace', file: 'x.ts', old: TS_BASE, new: TS_BASE.replace('x + 1', 'x + 1   '), expect: ['whitespace'] },
	{ name: 'ts: blank line added', file: 'x.ts', old: TS_BASE, new: TS_BASE.replace('\t// compute', '\n\t// compute'), expect: ['whitespace'] },
	{ name: 'ts: CRLF only', file: 'x.ts', old: TS_BASE, new: TS_BASE.replaceAll('\n', '\r\n'), expect: ['whitespace'] },
	{ name: 'ts: line comment edit is comment', file: 'x.ts', old: TS_BASE, new: TS_BASE.replace('// compute', '// compute the successor'), expect: ['comment'] },
	{ name: 'ts: comment added is comment', file: 'x.ts', old: TS_BASE, new: TS_BASE.replace('\treturn', '\t// note\n\treturn'), expect: ['comment'] },
	{ name: 'ts: trailing comment edit is comment', file: 'x.ts', old: TS_BASE.replace('x + 1', 'x + 1 // a'), new: TS_BASE.replace('x + 1', 'x + 1 // b'), expect: ['comment'] },
	{ name: 'ts: one-character code change is logic', file: 'x.ts', old: TS_BASE, new: TS_BASE.replace('x + 1', 'x + 2'), expect: ['logic'] },
	{ name: 'ts: comment next to code change is mixed', file: 'x.ts', old: TS_BASE, new: TS_BASE.replace('// compute', '// compute more').replace('x + 1', 'x + 2'), expect: ['mixed'] },
	{ name: 'ts: // inside a string is code, not a comment', file: 'x.ts', old: TS_BASE, new: TS_BASE.replace('http://example.com', 'http://example.org'), expect: ['logic'] },
	{ name: 'ts: spaces inside a string are content', file: 'x.ts', old: 'const s = "a b"\n', new: 'const s = "a  b"\n', expect: ['logic'] },
	{ name: 'ts: removing a space between + and + changes meaning', file: 'x.ts', old: 'const v = a + +b\n', new: 'const v = a ++b\n', expect: ['logic'] },
	{ name: 'ts: joining lines is not whitespace (ASI)', file: 'x.ts', old: 'function g() {\n  return\n    1\n}\n', new: 'function g() {\n  return 1\n}\n', expect: ['logic'] },
	{ name: 'ts: import added is import', file: 'x.ts', old: TS_BASE, new: 'import { b } from "./b"\n' + TS_BASE, expect: ['import'] },
	{ name: 'ts: imports reordered is import', file: 'x.ts', old: 'import { a } from "./a"\nimport { b } from "./b"\n\nfoo()\n', new: 'import { b } from "./b"\nimport { a } from "./a"\n\nfoo()\n', expect: ['import'] },
	{ name: 'ts: eslint-disable edit is not "just a comment"', file: 'x.ts', old: TS_BASE.replace('\treturn', '\t// eslint-disable-next-line no-x\n\treturn'), new: TS_BASE.replace('\treturn', '\t// eslint-disable-next-line no-y\n\treturn'), expect: ['logic'] },
	{ name: 'ts: @ts-ignore added is not a comment change', file: 'x.ts', old: TS_BASE, new: TS_BASE.replace('\treturn', '\t// @ts-ignore\n\treturn'), expect: ['logic'] },
	{ name: 'ts: regex line spacing is left alone', file: 'x.ts', old: 'const r = /a b/\n', new: 'const r = /a  b/\n', expect: ['logic'] },
	{ name: 'ts: template literal content is content', file: 'x.ts', old: 'const t = `\n  hello\n`\n', new: 'const t = `\n  hello  \n`\n', expect: ['logic'] },
	{ name: 'ts: block comment opened above the hunk (context shows it)', file: 'x.ts', old: '/*\n * one\n * two\n */\nfoo()\n', new: '/*\n * one\n * 2\n */\nfoo()\n', expect: ['comment'] },
	{ name: 'ts: -U0 hunk inside a block comment opened far above is still a comment', file: 'x.ts', old: '/*\n * one\n * two\n */\nfoo()\n', new: '/*\n * one\n * 2\n */\nfoo()\n', expect: ['comment'], context: 0 },
	{ name: 'ts: -U0 edit of code that only looks like a comment is not trusted when unclosed', file: 'x.ts', old: 'foo()\n/* start\nbar()\n*/\n', new: 'foo()\n/* start\nbaz()\n*/\n', expect: ['comment'], context: 0 },
	{ name: 'ts: commenting code out is never trivial', file: 'x.ts', old: 'foo()\nbar()\n/* c */\n', new: 'foo()\n/* bar()\n/* c */\n', expect: ['mixed'] },
	{ name: 'ts: later hunk after a state-changing hunk is logic', file: 'x.ts', old: 'a()\n' + 'x\n'.repeat(10) + 'b()\n' + 'y\n'.repeat(10) + '/* c */\nc()\n', new: '/* a()\n' + 'x\n'.repeat(10) + 'b()\n' + 'y\n'.repeat(10) + '/* c */\nc()\n// extra\n', expect: ['logic', 'logic'] },
	{ name: 'ts: commenting a call out is never trivial', file: 'x.ts', old: 'run(); // go\n', new: '// run(); // go\n', expect: ['mixed'] },
	{ name: 'ts: swapping two statements is logic, not whitespace', file: 'x.ts', old: 'a()\nb()\n', new: 'b()\na()\n', expect: ['logic'] },
	{ name: 'ts: unterminated block comment swallowing code is logic', file: 'x.ts', old: 'a()\nb()\nc()\n', new: 'a()\n/*\nb()\nc()\n', expect: ['logic'] },
	{ name: 'ts: a/**/b is not ab', file: 'x.ts', old: 'const a_b = 1; x = a /* c */ b\n', new: 'const a_b = 1; x = ab\n', expect: ['logic'] },

	// ── Java ──────────────────────────────────────────────────────────────
	{ name: 'java: javadoc edit is comment', file: 'A.java', old: 'class A {\n  /** Adds. */\n  int add(int a) { return a; }\n}\n', new: 'class A {\n  /** Adds one. */\n  int add(int a) { return a; }\n}\n', expect: ['comment'] },
	{ name: 'java: char literal quote does not start a string', file: 'A.java', old: "class A { char c = '\"'; // a\n}\n", new: "class A { char c = '\"'; // b\n}\n", expect: ['comment'] },
	{ name: 'java: text block content is content', file: 'A.java', old: 'class A { String s = """\n  // not a comment\n  x""";\n}\n', new: 'class A { String s = """\n  // not a comment!\n  x""";\n}\n', expect: ['logic'] },
	{ name: 'java: import added', file: 'A.java', old: 'import java.util.List;\nclass A {}\n', new: 'import java.util.List;\nimport java.util.Map;\nclass A {}\n', expect: ['import'] },
	{ name: 'java: annotation change is code', file: 'A.java', old: 'class A {\n  @Deprecated\n  void f() {}\n}\n', new: 'class A {\n  @Override\n  void f() {}\n}\n', expect: ['logic'] },

	// ── Python (indentation is meaningful) ────────────────────────────────
	{ name: 'py: comment edit', file: 'm.py', old: 'def f():\n    # one\n    return 1\n', new: 'def f():\n    # two\n    return 1\n', expect: ['comment'] },
	{ name: 'py: re-indenting is logic', file: 'm.py', old: 'def f():\n    x = 1\n    return x\n', new: 'def f():\n    x = 1\n        return x\n', expect: ['logic'] },
	{ name: 'py: trailing whitespace is whitespace', file: 'm.py', old: 'x = 1\n', new: 'x = 1   \n', expect: ['whitespace'] },
	{ name: 'py: blank line inside a triple-quoted string is content', file: 'm.py', old: 's = """a\nb"""\n', new: 's = """a\n\nb"""\n', expect: ['logic'] },
	{ name: 'py: # inside a string is not a comment', file: 'm.py', old: 'u = "http://x/#a"\n', new: 'u = "http://x/#b"\n', expect: ['logic'] },
	{ name: 'py: type: ignore is magic', file: 'm.py', old: 'x = f()  # type: ignore\n', new: 'x = f()  # type: nope\n', expect: ['logic'] },
	{ name: 'py: shebang edit is not a comment change', file: 'm.py', old: '#!/usr/bin/python\nx = 1\n', new: '#!/usr/bin/python3\nx = 1\n', expect: ['logic'] },
	{ name: 'py: import change', file: 'm.py', old: 'import os\n\nx = 1\n', new: 'import os\nimport sys\n\nx = 1\n', expect: ['import'] },

	// ── Go ────────────────────────────────────────────────────────────────
	{ name: 'go: comment edit', file: 'main.go', old: 'package main\n\n// Run runs.\nfunc Run() {}\n', new: 'package main\n\n// Run runs it.\nfunc Run() {}\n', expect: ['comment'] },
	{ name: 'go: raw string content', file: 'main.go', old: 'var s = `a\n// b`\n', new: 'var s = `a\n// c`\n', expect: ['logic'] },
	{ name: 'go: go:generate is magic', file: 'main.go', old: '//go:generate stringer -type=A\n', new: '//go:generate stringer -type=B\n', expect: ['logic'] },
	{ name: 'go: build tag is magic', file: 'main.go', old: '// +build linux\n\npackage x\n', new: '// +build darwin\n\npackage x\n', expect: ['logic'] },

	// ── Rust ──────────────────────────────────────────────────────────────
	{ name: 'rust: doc comment edit', file: 'lib.rs', old: "/// Adds.\nfn add<'a>(x: &'a i32) -> i32 { *x }\n", new: "/// Adds one.\nfn add<'a>(x: &'a i32) -> i32 { *x }\n", expect: ['comment'] },
	{ name: 'rust: lifetime is not a char literal', file: 'lib.rs', old: "fn f<'a>(x: &'a str) -> &'a str { x } // a\n", new: "fn f<'a>(x: &'a str) -> &'a str { x } // b\n", expect: ['comment'] },
	{ name: 'rust: nested block comment', file: 'lib.rs', old: '/* a /* b */ c */\nfn f() {}\n', new: '/* a /* b */ d */\nfn f() {}\n', expect: ['comment'] },
	{ name: 'rust: raw strings disqualify the file', file: 'lib.rs', old: 'const S: &str = r#"a"#; // x\n', new: 'const S: &str = r#"a"#; // y\n', expect: ['logic'] },
	{ name: 'rust: use added', file: 'lib.rs', old: 'use std::fmt;\nfn f() {}\n', new: 'use std::fmt;\nuse std::io;\nfn f() {}\n', expect: ['import'] },

	// ── C / C++ / C# ──────────────────────────────────────────────────────
	{ name: 'c: / * is not a comment', file: 'a.c', old: 'int f(int a, int *p) { return a / *p; }\n', new: 'int f(int a, int *p) { return a /*p; }\n', expect: ['logic'] },
	{ name: 'c: include added', file: 'a.c', old: '#include <stdio.h>\nint main(){return 0;}\n', new: '#include <stdio.h>\n#include <stdlib.h>\nint main(){return 0;}\n', expect: ['import'] },
	{ name: 'c: comment edit', file: 'a.c', old: '/* one */\nint x;\n', new: '/* two */\nint x;\n', expect: ['comment'] },
	{ name: 'c: digit separator is not a char literal', file: 'a.cpp', old: "int x = 1'000; // a\n", new: "int x = 1'000; // b\n", expect: ['comment'] },
	{ name: 'cs: using added', file: 'A.cs', old: 'using System;\nclass A {}\n', new: 'using System;\nusing System.IO;\nclass A {}\n', expect: ['import'] },
	{ name: 'cs: verbatim strings disqualify the file', file: 'A.cs', old: 'class A { string s = @"a\n// b"; }\n', new: 'class A { string s = @"a\n// c"; }\n', expect: ['logic'] },

	// ── Shell / YAML / Markdown / unknown ────────────────────────────────
	{ name: 'sh: comment edit', file: 'run.sh', old: '#!/bin/sh\n# start\necho hi\n', new: '#!/bin/sh\n# begin\necho hi\n', expect: ['comment'] },
	{ name: 'sh: $# is not a comment', file: 'run.sh', old: 'echo $#\n', new: 'echo $@\n', expect: ['logic'] },
	{ name: 'sh: heredoc disqualifies the file', file: 'run.sh', old: 'cat <<EOF\n# not a comment\nEOF\n', new: 'cat <<EOF\n# not a comment!\nEOF\n', expect: ['logic'] },
	{ name: 'yaml: comment edit', file: 'c.yml', old: 'a: 1 # one\nb: 2\n', new: 'a: 1 # uno\nb: 2\n', expect: ['comment'] },
	{ name: 'yaml: reindent is logic', file: 'c.yml', old: 'a:\n  b: 1\n', new: 'a:\n    b: 1\n', expect: ['logic'] },
	{ name: 'yaml: apostrophe in a plain scalar does not open a string', file: 'c.yml', old: "msg: it's fine # a\n", new: "msg: it's fine # b\n", expect: ['comment'] },
	{ name: 'yaml: block scalar disqualifies the file', file: 'c.yml', old: 'run: |\n  # not a comment\n  echo\n', new: 'run: |\n  # not a comment!\n  echo\n', expect: ['logic'] },
	{ name: 'md: anything is logic', file: 'README.md', old: 'a\n', new: 'a  \n', expect: ['logic'] },
	{ name: 'unknown: trailing whitespace only', file: 'data.cfg', old: 'a=1\n', new: 'a=1  \n', expect: ['whitespace'] },
	{ name: 'unknown: blank line added is logic', file: 'data.cfg', old: 'a=1\nb=2\n', new: 'a=1\n\nb=2\n', expect: ['logic'] },
	{ name: 'unknown: indentation change is logic', file: 'data.cfg', old: 'a=1\n', new: '  a=1\n', expect: ['logic'] },
]

suite('hunkClassifier: table', () => {
	for (const c of CASES) {
		test(c.name, () => {
			assert.deepStrictEqual(kinds(c.old, c.new, c.file, c.context ?? 3), c.expect)
		})
	}

	test('isTrivialKind', () => {
		assert.ok(isTrivialKind('whitespace') && isTrivialKind('comment'))
		assert.ok(!isTrivialKind('import') && !isTrivialKind('logic') && !isTrivialKind('mixed'))
	})

	test('no file text means logic, never trivial', () => {
		const hunks = diffOf('a\n', 'a  \n', 'x.ts')
		assert.deepStrictEqual(classifyFileHunks(hunks, undefined, 'x.ts'), ['logic'])
	})

	test('a hunk that does not match the text it is paired with is logic', () => {
		const hunks = diffOf(TS_BASE, TS_BASE.replace('// compute', '// compute!'), 'x.ts')
		assert.deepStrictEqual(classifyFileHunks(hunks, TS_BASE, 'x.ts'), ['logic'])
	})

	test('extension mapping', () => {
		assert.strictEqual(languageRulesFor('a/b/c.TSX').id, 'js')
		assert.strictEqual(languageRulesFor('Dockerfile').id, 'generic')
		assert.strictEqual(languageRulesFor('x.unknown').id, 'generic')
		assert.strictEqual(languageRulesFor('dir.v2/file').id, 'generic')
	})
})
