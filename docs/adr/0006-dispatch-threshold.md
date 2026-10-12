# ADR-0006: Dispatch in parallel only when each task is substantial

- Status: accepted
- Date: 2026-10-12

## Context

Commit `1a96085` told the orchestrator to use the `dispatch` skill for any 2+
independent tasks, "even when each task is small", because it otherwise kept
small work inline. The benchmark ([benchmarks.md](../research/benchmarks.md),
2 runs per arm, Opus orchestrator, outcome-only graders) then measured what
dispatch buys:

| Case | Time with vs without | Cost with vs without |
|---|---|---|
| `bench-modules` (4 tiny modules, ~25 s of coding each) | 115 s vs 118 s (≈0%) | $0.81 vs $0.56 (+45%) |
| `bench-large` (3 modules, ~100–200 reference lines each) | 164 s vs 208 s (−21%) | $1.18 vs $0.97 (+22%) |

Hidden acceptance suites passed 100% in every run of both arms, so quality did
not decide it; time and cost did. Planning, worktrees, briefs, review and serial
merges are a fixed cost per task that only a substantial task amortises.

## Decision

- Plan tasks carry `size: small | substantial`. Substantial means its own module
  or feature needing several edit-and-test cycles, roughly 100+ changed lines.
- The orchestrator uses `dispatch` without asking only when a plan has 2+
  independent tasks (no `depends_on` path, disjoint `files`) that are each
  substantial. `dispatch` picks only substantial tasks for its waves.
- Independent small tasks go to one `implementer` as a single batched task,
  done in order on the feature branch.
- The inline rule (one file, one change, no new tests) is unchanged.

## Consequences

- Small multi-feature requests cost about as much as a single delegation instead
  of 45% more, with no loss of speed.
- Large independent work still runs in parallel, at roughly 20% extra cost for
  roughly 20% less wall clock.
- "Substantial" is a judgment call; ~100 lines is a rule of thumb from two data
  points, not a measured break-even. Revisit with more benchmark runs.
- The behaviour evals split accordingly: `batch-small` (two tiny features, one
  implementer, no dispatch) and `parallel-dispatch` (two of bench-large's
  modules, plan + dispatch + 2 merges).
