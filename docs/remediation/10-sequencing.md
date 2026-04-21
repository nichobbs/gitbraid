# Sequencing and Milestones

How to land the tasks in `01-p0-blockers.md` … `09-packaging.md` without
stepping on each other or creating thrash.

## Guiding principles

1. **Quick wins before refactors.** The 10+ ≤1-day items are worth
   landing first so the codebase is cleaner when the bigger changes
   arrive.
2. **Seams before substance.** Introducing `IGitRunner` (T54) and the
   command wrapper (T25) up-front means every later fix drops into a
   testable slot.
3. **Security and correctness at the same time.** The `spawn`
   migration (T18) both closes injection and deletes the bugs it was
   masking (T1/T6).
4. **Tests ride with code.** Every task references its regression
   test. CI gating (T61) arrives as soon as possible so regressions
   don't accumulate.

## Milestone plan

### Milestone M1 — Bleeding (P0 + quick wins) — ~1 week

Parallel tracks:

- Track A (1 engineer, ~3 days): **T1, T6, T27, T28, T29, T30, T64,
  T65, T66**. Pure fix-and-test items, mostly in
  `gitFunctions.ts`, `utils.ts`, `channelLogger.ts`, `diffEngine.ts`,
  `rebaseSuggestionService.ts`.
- Track B (1 engineer, ~3 days): **T2 (stderr), T3 (discardChanges),
  T4 (force remove), T5 (activationEvents), T7 (publisher)**. These
  touch shell quoting and activation; keep them coherent.
- Track C (1 engineer, ~3 days): **T25 (command wrapper) + T34
  (eslint rule)**. Refactor every command registration site and
  remove the floating-promises that the P0 items have been masking.

Gate for M1 exit: P0 exit criteria checklist from
`01-p0-blockers.md` is green.

### Milestone M2 — Foundations — ~2 weeks

Parallel tracks, loosely coupled:

- **T18** (spawn migration) together with **T19** (ref-format
  validation), **T20** (path guard), **T22** (redaction), and
  **T58** (injection test suite).
- **T54** (IGitRunner) lands alongside T18 — the refactor uses the
  runner as its substrate.
- **T55** (per-suite tmp workspaces) and **T56** (integration tests)
  land right after T54 so the tests can use the runner.
- **T61** (CI workflow + coverage floor) lands last in this
  milestone, once the test suites stabilise.

Gate for M2 exit: security exit criteria green, CI running on every
PR, coverage floor enforced.

### Milestone M3 — Correctness — ~2 weeks

- **T10** (file change bus) — unblocks performance and reduces
  watcher fan-out.
- **T14** (defer saves during sync).
- **T9** (injective dir names) + matching migration.
- **T8** (hunk identifier stability) — biggest behavioural win.
- **T63** (overlap detection wired into routing).
- **T26** (no more `catch {}`), **T31** (typed errors), **T32**
  (`Promise.allSettled`), **T33** (rebase dialog await).
- **T24** (single `.gitignore` writer), **T21** (config concurrency).

Gate for M3 exit: P1 correctness items from
`02-p1-correctness.md` are closed (T8/T9/T10/T14 and dependent
tests), plus overlap-gating.

### Milestone M4 — UX and features — ~2 weeks

- **T11** (reconcile tree views — Option A unless the team decides
  otherwise) must precede **T17** (drag-and-drop).
- **T12** (stack content provider), **T13** (bidirectional sync),
  **T15** (LM tools declared), **T40** (MBC → GitBraid rebrand),
  **T16** (walkthrough).
- **T35–T44** (UI polish grab-bag).
- **T72** (public API symmetry) + **T67** (push/sync stack).

Gate for M4 exit: UX exit criteria green, LM tools appear in
Copilot Chat.

### Milestone M5 — Performance + polish — ~1 week

- **T45–T53** (performance grab-bag).
- **T49** (noise in `getAllNodes`), **T50** (event-driven rebase
  poll).

### Milestone M6 — Roadmap — open-ended

- T68 (assign subtree), T69 (undo), T70 (rebase recovery), T71
  (import/export), T73 (default branch), T74 (already-checked-out),
  T75 (PR awareness).

## Parallelisation notes

- T54 must precede T55/T56 (tests depend on the runner).
- T18 must precede T1/T6 ideally (the fixes live in the new runner);
  if M1 ships first, keep T1's targeted fix and re-land on top of
  T18 without regression.
- T10 must precede T45/T47/T53 (the bus is the backbone for the
  caches).
- T11 must precede T17 (don't DnD on a deprecated tree).
- T8 must precede T63 if we want overlap messages to be meaningful
  against stable hunk ids; otherwise T63 lands with numeric ids and
  catches overlaps at routing time anyway — safe to do either order.

## Acceptance dashboard (living)

Track which findings are closed by which commit. Add columns to
`docs/reviews/10-priorities.md` as items land:

```
| P0 #1 Publisher               | ✅ closed in <sha> | T7 |
| P0 #2 Shell injection         | ✅ closed in <sha> | T1, T18 |
| P0 #3 stderr popup            | ✅ closed in <sha> | T2 |
| P0 #4 discardChanges clean    | ✅ closed in <sha> | T3 |
| P0 #5 activationEvents        | ✅ closed in <sha> | T5 |
| P0 #6 revList/branch undef    | ✅ closed in <sha> | T6 |
```

## Definition of done (overall)

- Every `docs/reviews/*.md` finding is either closed or has an
  explicit "Deferred to vX.Y" note with justification.
- `npm run lint`, `npm test`, `npx vsce package --no-dependencies`
  green on Linux + macOS + Windows in CI.
- Coverage floor (70% lines, 60% branches) enforced.
- `CHANGELOG.md` summarises every closed finding.
- Walkthrough + README + manifest reflect canonical branding.
- Injection suite green.
