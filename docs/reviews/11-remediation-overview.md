# Remediation Plan — Overview

This folder (`docs/reviews/11-*` through `docs/reviews/16-*`) is a
comprehensive, actionable plan to address the findings in the earlier
review files (`00-overview.md` through `10-priorities.md`).

## Priority tiers

Findings are split into four tiers, ordered by **greatest exploitation
potential or impact first**:

| Tier | Theme | File |
| --- | --- | --- |
| **P0** | Security, data loss, runtime crashes, publish-blockers | [12-remediation-p0.md](12-remediation-p0.md) |
| **P1** | Architecture consolidation, promised features, high-impact UX | [13-remediation-p1.md](13-remediation-p1.md) |
| **P2** | Testing, logging, error handling, performance, settings wiring | [14-remediation-p2.md](14-remediation-p2.md) |
| **P3** | Roadmap items, MCP, multi-root, conflict recovery UI | [15-remediation-p3.md](15-remediation-p3.md) |
| Quick wins | Items completable in ≤ 1 day, parallelisable | [16-remediation-quick-wins.md](16-remediation-quick-wins.md) |

## Entry format

Each finding in the P0–P3 files uses this structure:

```
### <ID>: <Short title>

**Source:** review file · line reference
**Severity:** Critical | High | Medium | Low
**Exploitability:** High | Medium | Low | N/A
**Effort:** S (≤1 day) · M (2–5 days) · L (1–2 weeks) · XL (>2 weeks)
**Blocks:** <list of other IDs this must land before>
**Blocked by:** <prerequisite IDs>

#### Root cause
<what's actually wrong and why>

#### Proposed fix
<concrete change, code sketch where useful>

#### Acceptance criteria
- <testable outcome 1>
- <testable outcome 2>

#### Verification
<how reviewers / CI will confirm>
```

ID prefixes by theme:

- `SEC-nnn` — security
- `BUG-nnn` — correctness / data loss / runtime crashes
- `PKG-nnn` — packaging, publisher, manifest
- `ARCH-nnn` — architectural consolidation
- `FEAT-nnn` — missing features promised by `PLAN.md`
- `UX-nnn` — user-facing changes
- `TEST-nnn` — test-suite and CI work
- `ERR-nnn` — error-handling / logging
- `PERF-nnn` — performance
- `RM-nnn` — roadmap items beyond current scope
- `QW-nnn` — quick wins

## Delivery strategy

### Phase A — stabilise (weeks 1–2)

Land every P0 item. Nothing in P1+ ships until this is green. Treat
this as a "security + data-safety + publish-readiness" hot-fix
release. Target version: **0.1.1**.

Critical path:
```
SEC-001 (shell injection) ──┐
SEC-002 (branch validation)─┤
BUG-001 (git clean→restore) │──► P0 release
BUG-002 (revList crash)    ─┤
PKG-001 (publisher id)    ──┤
PKG-002 (activationEvents) ─┘
```

SEC-001 is the umbrella item that removes almost every other
injection finding; land it before individual sanitiser patches to avoid
churn.

### Phase B — consolidate (weeks 3–6)

P1 tree-view consolidation, bidirectional sync, LM-tool manifest, DnD
reassignment. Target version: **0.2.0** ("the features the plan
promised").

### Phase C — harden (weeks 5–8, parallel with B)

P2 tests, logging, performance. These don't gate user-facing releases
but reduce incident rate. Target: **0.2.x** dot releases.

### Phase D — roadmap (ongoing)

P3 items are scoped individually; open an RFC/ADR per item before
implementation.

## Release/version gates

| Release | Gate |
| --- | --- |
| 0.1.1 | All P0 items closed; CI green with ≥ existing coverage; manual smoke test on macOS + Windows |
| 0.2.0 | P0 + P1 closed; coverage ≥ 70% line; marketplace metadata complete |
| 1.0.0 | P0 + P1 + P2 closed; coverage ≥ 80%; `preview: false`; published to Marketplace; changelog complete |

## Tracking

Recommend creating a GitHub Project with one column per tier. Each
`<ID>: <title>` becomes an issue whose body is the entry verbatim.
Close an issue only when the **Acceptance criteria** are green in CI.

## How to update this plan

If a new finding emerges after this plan is written:

1. Append the entry under the appropriate tier file.
2. Add a row in [16-remediation-quick-wins.md](16-remediation-quick-wins.md) if it's <1 day.
3. Update the critical-path graph in this file if it affects sequencing.
4. Bump the "Revised" date at the top of the affected file.

## Definitions

- **Exploitability**: how easily an adversary can trigger the bug. A
  shell-injection through a QuickPick the user types themselves is
  _Medium_; one through a crafted branch name on a remote they pulled
  is _High_.
- **Effort**: wall-clock days for a single senior engineer, including
  writing tests. Assumes no parallelism inside the item.
- **Severity**: user-facing or systemic impact if unfixed.

All tiers below use these consistent labels.
