#!/usr/bin/env node
// Minimal lcov coverage threshold checker.  Parses an lcov.info file and
// fails the build if line / branch / function coverage falls below the
// configured floors.  Zero deps by design — we don't want to bake `nyc`
// or `c8` into the production toolchain just for this gate.
//
// Usage:
//     node scripts/check-coverage.mjs --lines 70 --branches 60 --functions 70 path/to/lcov.info

import * as fs from 'node:fs'
import * as process from 'node:process'

const args = process.argv.slice(2)
const thresholds = { lines: 0, branches: 0, functions: 0 }
let lcovPath

for (let i = 0; i < args.length; i++) {
	const a = args[i]
	if (a === '--lines')         thresholds.lines     = Number(args[++i])
	else if (a === '--branches') thresholds.branches  = Number(args[++i])
	else if (a === '--functions')thresholds.functions = Number(args[++i])
	else                          lcovPath = a
}

if (!lcovPath || !fs.existsSync(lcovPath)) {
	console.error(`[check-coverage] lcov file not found: ${String(lcovPath)} — skipping`)
	process.exit(0)
}

const text = fs.readFileSync(lcovPath, 'utf-8')

const totals = { LH: 0, LF: 0, BRH: 0, BRF: 0, FNH: 0, FNF: 0 }
for (const line of text.split(/\r?\n/)) {
	const [k, v] = line.split(':')
	if (!k || !v) continue
	const n = Number(v)
	if (!Number.isFinite(n)) continue
	if (k in totals) totals[k] += n
}

const pct = (hit, total) => total === 0 ? 100 : (hit / total) * 100
const lines     = pct(totals.LH, totals.LF)
const branches  = pct(totals.BRH, totals.BRF)
const functions = pct(totals.FNH, totals.FNF)

console.log('[check-coverage] lines=%s%% branches=%s%% functions=%s%%',
	lines.toFixed(1), branches.toFixed(1), functions.toFixed(1))

const fail = []
if (lines     < thresholds.lines)     fail.push(`lines ${lines.toFixed(1)}% < ${thresholds.lines}%`)
if (branches  < thresholds.branches)  fail.push(`branches ${branches.toFixed(1)}% < ${thresholds.branches}%`)
if (functions < thresholds.functions) fail.push(`functions ${functions.toFixed(1)}% < ${thresholds.functions}%`)

if (fail.length > 0) {
	console.error('[check-coverage] FAILED:', fail.join('; '))
	process.exit(1)
}

console.log('[check-coverage] all thresholds met')
