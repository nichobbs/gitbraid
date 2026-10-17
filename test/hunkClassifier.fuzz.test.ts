import * as assert from 'node:assert'
import { classifyFileHunks } from '../src/hunkClassifier'
import { diffOf } from './helpers/diffOf'

/**
 * Property tests for the "never label logic as trivial" rule.  Files are built
 * from units whose lexical role is known by construction, then mutated; the
 * classifier sees only the resulting diff and file text.
 */

function rng(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6D2B79F5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

interface Lang {
	file: string
	code: string[]
	/** Code lines that contain comment-looking text inside a string. */
	tricky: string[]
	lineComment: string
	block?: { open: string, mid: string, close: string }
}

const LANGS: Lang[] = [
	{
		file: 'f.ts', lineComment: '//', block: { open: '/*', mid: ' * ', close: ' */' },
		code: ['const a = foo(b, c)', 'if (x) {', '  y = y + 1', '}', 'return a', 'export const k = 1', 'items.map((i) => i * 2)'],
		tricky: ['const u = "http://example.com/a"', "const v = '/* not a comment */'", 'const w = `// still a string`'],
	},
	{
		file: 'f.py', lineComment: '#',
		code: ['x = foo(a, b)', 'def f(a):', '    return a + 1', 'for i in range(3):', '    print(i)', 'y = [1, 2, 3]'],
		tricky: ['u = "http://x/#frag"', "v = '# nope'", 's = "a  b"'],
	},
	{
		file: 'f.c', lineComment: '//', block: { open: '/*', mid: ' * ', close: ' */' },
		code: ['int x = foo(a, b);', 'if (x) {', '  y = y + 1;', '}', 'return a;', 'p->next = q;'],
		tricky: ['const char *u = "http://x";', 'const char *v = "/* no */";', "char c = '\"';"],
	},
	{
		file: 'F.java', lineComment: '//', block: { open: '/**', mid: ' * ', close: ' */' },
		code: ['int x = foo(a, b);', 'if (x > 0) {', '  y = y + 1;', '}', 'return a;', 'list.add(item);'],
		tricky: ['String u = "http://x";', 'String v = "/* no */";', "char c = '\"';"],
	},
	{
		file: 'f.go', lineComment: '//', block: { open: '/*', mid: ' * ', close: ' */' },
		code: ['x := foo(a, b)', 'if x > 0 {', '\ty = y + 1', '}', 'return a', 'items = append(items, i)'],
		tricky: ['u := "http://x"', 'v := `// raw`', "c := '\"'"],
	},
	{
		file: 'f.rs', lineComment: '//', block: { open: '/*', mid: ' * ', close: ' */' },
		code: ['let x = foo(a, b);', 'if x > 0 {', '    y += 1;', '}', 'fn g<\'a>(s: &\'a str) -> &\'a str { s }', 'v.push(i);'],
		tricky: ['let u = "http://x";', 'let v = "/* no */";', "let c = '\"';"],
	},
	{
		file: 'f.sh', lineComment: '#',
		code: ['echo "$1"', 'cd /tmp', 'ls -la | grep x', 'x=$((x + 1))', 'echo $#'],
		tricky: ['echo "a # b"', "echo '# c'", 'echo ${#arr[@]}'],
	},
]

type Unit = { kind: 'code' | 'comment' | 'blank' | 'block', lines: string[] }

function buildUnits(lang: Lang, r: () => number): Unit[] {
	const units: Unit[] = []
	const n = 14 + Math.floor(r() * 10)
	for (let i = 0; i < n; i++) {
		const roll = r()
		if (roll < 0.45) units.push({ kind: 'code', lines: [lang.code[Math.floor(r() * lang.code.length)]] })
		else if (roll < 0.6) units.push({ kind: 'code', lines: [lang.tricky[Math.floor(r() * lang.tricky.length)]] })
		else if (roll < 0.78) units.push({ kind: 'comment', lines: [`${lang.lineComment} note ${String(i)}`] })
		else if (roll < 0.85 && lang.block) {
			units.push({ kind: 'block', lines: [lang.block.open, `${lang.block.mid}first ${String(i)}`, `${lang.block.mid}second`, lang.block.close] })
		} else units.push({ kind: 'blank', lines: [''] })
	}
	return units
}

const render = (us: Unit[]) => us.map((u) => u.lines.join('\n')).join('\n') + '\n'

suite('hunkClassifier: properties', function () {
	this.timeout(120_000)

	for (const lang of LANGS) {
		test(`${lang.file}: code changes are never trivial; comment/whitespace-only changes always are`, () => {
			const r = rng(0xC0FFEE ^ lang.file.length ^ lang.file.charCodeAt(2))
			for (let iter = 0; iter < 40; iter++) {
				const before = buildUnits(lang, r)
				const after = before.map((u) => ({ kind: u.kind, lines: [...u.lines] }))
				let codeMut = 0
				let commentMut = 0
				const muts = 1 + Math.floor(r() * 3)
				const used = new Set<number>()
				for (let m = 0; m < muts; m++) {
					const idx = Math.floor(r() * after.length)
					if (used.has(idx)) continue
					used.add(idx)
					const u = after[idx]
					const pick = r()
					if (u.kind === 'code' && pick < 0.6) {
						u.lines[0] = `${u.lines[0]} zz${String(iter)}`
						codeMut++
					} else if (u.kind === 'code') {
						u.lines[0] = `${u.lines[0]}   `
					} else if (u.kind === 'comment') {
						u.lines[0] = `${u.lines[0]} more words`
						commentMut++
					} else if (u.kind === 'block') {
						u.lines[1] = `${u.lines[1]} edited`
						commentMut++
					} else {
						u.lines.push('')
					}
				}
				const oldText = render(before)
				const newText = render(after)
				if (oldText === newText) continue

				const hunks = diffOf(oldText, newText, lang.file, 3)
				const kinds = classifyFileHunks(hunks, newText, lang.file)
				const ctx = `${lang.file} iter ${String(iter)}\n--- old\n${oldText}--- new\n${newText}--- kinds ${kinds.join(',')}`
				if (codeMut > 0) {
					assert.ok(kinds.some((k) => k === 'logic' || k === 'mixed'), `code change labelled trivial\n${ctx}`)
				} else {
					assert.ok(kinds.every((k) => k === 'whitespace' || k === 'comment'), `trivial change labelled non-trivial\n${ctx}`)
					if (commentMut > 0) assert.ok(kinds.includes('comment'), `comment change not labelled comment\n${ctx}`)
					else assert.ok(kinds.every((k) => k === 'whitespace'), `whitespace change labelled comment\n${ctx}`)
				}
			}
		})
	}
})
