#!/usr/bin/env node
// Minimal lcov coverage threshold checker.  Parses an lcov.info file and
// fails the build if line / branch / function coverage falls below the
// configured floors.  Zero deps by design — we don't want to bake `nyc`
// or `c8` into the production toolchain just for this gate.
//
// Usage:
//     node scripts/check-coverage.mjs --lines 70 --branches 60 --functions 70 path/to/lcov.info
//
// Exit codes:
//     0 — every threshold satisfied (or --allow-missing was set and the
//         lcov file could not be found).
//     1 — at least one metric fell below its threshold.
//     2 — lcov file was absent or contained no coverage data.  This is
//         typically a CI misconfiguration rather than a test regression,
//         so it's distinguished from the "below threshold" exit code.
//     3 — argument parsing error.

import * as fs from 'node:fs'
import * as process from 'node:process'

const args = process.argv.slice(2)
const thresholds = { lines: 0, branches: 0, functions: 0 }
let lcovPath
let allowMissing = false

for (let i = 0; i < args.length; i++) {
	const a = args[i]
	const next = () => {
		const v = Number(args[++i])
		if (!Number.isFinite(v) || v < 0 || v > 100) {
			console.error(`[check-coverage] invalid threshold for ${a}: ${String(args[i])}`)
			process.exit(3)
		}
		return v
	}
	if (a === '--lines')           thresholds.lines     = next()
	else if (a === '--branches')   thresholds.branches  = next()
	else if (a === '--functions')  thresholds.functions = next()
	else if (a === '--allow-missing') allowMissing = true
	else if (a === '--help' || a === '-h') {
		console.log('usage: node scripts/check-coverage.mjs [--lines N] [--branches N] [--functions N] [--allow-missing] path/to/lcov.info')
		process.exit(0)
	} else if (a.startsWith('--')) {
		console.error(`[check-coverage] unknown flag: ${a}`)
		process.exit(3)
	} else {
		lcovPath = a
	}
}

if (!lcovPath) {
	console.error('[check-coverage] missing lcov path argument')
	process.exit(3)
}

if (!fs.existsSync(lcovPath)) {
	if (allowMissing) {
		console.warn(`[check-coverage] lcov file not found at ${lcovPath} — skipping (--allow-missing)`)
		process.exit(0)
	}
	console.error(`[check-coverage] lcov file not found: ${lcovPath}`)
	process.exit(2)
}

const text = fs.readFileSync(lcovPath, 'utf-8')

const totals = { LH: 0, LF: 0, BRH: 0, BRF: 0, FNH: 0, FNF: 0 }
let currentSfIsNodeModules = false
for (const line of text.split(/\r?\n/)) {
	const colon = line.indexOf(':')
	if (colon <= 0) continue
	const k = line.slice(0, colon)
	const v = line.slice(colon + 1)
	if (k === 'SF') {
		currentSfIsNodeModules = v.includes('node_modules')
		continue
	}
	if (currentSfIsNodeModules) continue
	const n = Number(v)
	if (!Number.isFinite(n)) continue
	if (k in totals) totals[k] += n
}

if (totals.LF === 0 && totals.BRF === 0 && totals.FNF === 0) {
	console.error(`[check-coverage] lcov file at ${lcovPath} contained no coverage data`)
	process.exit(2)
}

const pct = (hit, total) => total === 0 ? 100 : (hit / total) * 100
const measured = {
	lines:     pct(totals.LH, totals.LF),
	branches:  pct(totals.BRH, totals.BRF),
	functions: pct(totals.FNH, totals.FNF),
}

console.log('[check-coverage] measured — lines=%s%% branches=%s%% functions=%s%% (thresholds: L=%s B=%s F=%s)',
	measured.lines.toFixed(1),
	measured.branches.toFixed(1),
	measured.functions.toFixed(1),
	String(thresholds.lines),
	String(thresholds.branches),
	String(thresholds.functions),
)

const failures = []
for (const key of ['lines', 'branches', 'functions']) {
	if (measured[key] + 1e-9 < thresholds[key]) {
		failures.push(`${key} ${measured[key].toFixed(1)}% < ${String(thresholds[key])}%`)
	}
}

if (failures.length > 0) {
	console.error('[check-coverage] FAILED:', failures.join('; '))
	process.exit(1)
}

console.log('[check-coverage] all thresholds met')
