/* eslint-disable no-console */
// Reproducible differential diagnostic for src/globMatcher.ts.
//
// Exercises the runtime matcher used by FileChangeBus against a reference
// implementation (plain minimatch) for every (pattern, path) pair below.
// Any non-zero exit status indicates drift the test suite didn't catch.
//
//   node scripts/audit-glob.js
//
// Originally authored to audit the hand-rolled matcher that preceded the
// current thin minimatch wrapper.  See `docs/reviews/2026-04-24-glob-audit.md`
// for the historical findings.

const { minimatch } = require('minimatch')

// Compile the live module via esbuild on-the-fly so the script reflects
// whatever is currently in `src/globMatcher.ts`.
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const tmp = path.resolve(__dirname, '../.audit-glob.cjs')
const result = spawnSync(
  path.resolve(__dirname, '../node_modules/.bin/esbuild'),
  [
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--external:vscode',
    `--outfile=${tmp}`,
    path.resolve(__dirname, '../src/globMatcher.ts'),
  ],
  { stdio: 'inherit' },
)
if (result.status !== 0) process.exit(result.status)

const { matchGlob: liveMatchGlob } = require(tmp)
function currentMatchGlob(glob, rel) { return liveMatchGlob(glob, rel) }
process.on('exit', () => { try { fs.rmSync(tmp) } catch {} })

function mm(glob, rel) {
  // `dot: true` so patterns match hidden files (e.g. .git/objects/…).
  return minimatch(rel, glob, { dot: true })
}

// 1. VS Code's built-in default `files.watcherExclude` patterns.
// 2. Representative user-written patterns.
// 3. Gitignore-ish leading-slash, trailing-slash, bare-name shapes.
const patterns = [
  '**/.git/objects/**',
  '**/.git/subtree-cache/**',
  '**/node_modules/*/**',
  '**/.hg/store/**',
  '**/node_modules/**',
  'node_modules/**',
  'node_modules',
  'node_modules/',
  'dist/',
  'build/**',
  '**/*.log',
  '**/*.{log,tmp}',
  '**/*.[jt]s',
  'foo?bar',
  'a/**/c',
  '**',
  '**/',
  '.git/**',
]

const paths = [
  'node_modules/pkg/index.js',
  'a/node_modules/pkg/index.js',
  'a/b/node_modules/pkg/index.js',
  'a/b/c/node_modules/pkg/sub/nested.js',
  '.git/objects/ab/cdef',
  'src/.git/objects/x',
  'dist/bundle.js',
  'dist/sub/bundle.js',
  'build/x.js',
  'build/sub/x.js',
  'app.log',
  'logs/app.log',
  'src/app.log',
  'app.tmp',
  'script.ts',
  'script.js',
  'script.md',
  'fooxbar',
  'foobar',
  'foo/bar',
  'a/b/c',
  'a/x/c',
  'a/c',
  'a/b/x/c',
  'any.txt',
]

let disagreements = 0
const rows = []

for (const glob of patterns) {
  for (const rel of paths) {
    const current = currentMatchGlob(glob, rel)
    const reference = mm(glob, rel)
    const mark = current === reference ? '  ' : '!!'
    if (current !== reference) {
      disagreements++
      rows.push({
        glob,
        rel,
        current,
        reference,
        mark,
      })
    }
  }
}

console.log(`Disagreements: ${disagreements}`)
console.log('glob'.padEnd(28) + '| path'.padEnd(40) + '| current | minimatch')
console.log('-'.repeat(92))
for (const r of rows) {
  console.log(
    r.glob.padEnd(28) +
    '| ' + r.rel.padEnd(38) +
    '| ' + String(r.current).padEnd(7) +
    '| ' + String(r.reference),
  )
}
